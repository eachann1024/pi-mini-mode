import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { agentCallDisplay, isAgentTool, liveAgentView, runningGlyph } from "./agent-view.ts";
import { createAssistantImages, imagePlaceholders } from "./assistant-images.ts";
import { linkToolFiles } from "./file-links.ts";
import { diagramMarkdown, isFencedMarkdown, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { minimalSurface, paintExpandedHeading } from "./minimal-theme.ts";
import { formatElapsed, formatThinkingElapsed, formatToolElapsed, piLoopSummary, type MinimalTurn } from "./minimal-turns.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { thinkingPreview } from "./thinking-preview.ts";
import type { NoticeRows, TurnNotices } from "./transcript-adapter.ts";
import { addUsage, EMPTY_USAGE, formatTokens } from "./usage.ts";

export function minimalOutputComponent(theme: ExtensionContext["ui"]["theme"], getTurns: () => MinimalTurn[], isExpanded: () => boolean = () => false, showUsage: () => boolean = () => true, subAgentsExpanded: () => boolean = () => false, agentDeadlines = new Map<string, number>(), transformText: (text: string) => string = text => text, imageOptions?: { cwd(): string; requestRender(): void; write?(data: string): void }, getRecordLimit: () => number = () => DEFAULT_SETTINGS["pi-mini-mode-minimal-record-limit"]) {
  const placeholderText = (text: string) => imageOptions ? imagePlaceholders(text, imageOptions.cwd()) : text;
  const markdown = (text: string, width: number, process = false) => renderMinimalMarkdown(text, width, getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "",
    { color: (value) => theme.fg(process ? "muted" : "text", value) }, (source, available) => transformText(placeholderText(diagramMarkdown(source, available))));
  const assistantImages = imageOptions && createAssistantImages(imageOptions.cwd, imageOptions.requestRender, imageOptions.write);
  const assistantMarkdown = (text: string, width: number, owner: string) => assistantImages ? assistantImages.render(text, width, markdown, owner) : markdown(text, width);
  const surface = (rows: string[], width: number, user: boolean, selected = -1, expanded = false) => {
    const padding = Math.min(2, Math.floor((width - 1) / 2));
    return ["", ...rows, ""].map((row, index) => {
      const line = truncateToWidth(" ".repeat(padding) + row, width, "");
      return minimalSurface(theme, line + " ".repeat(Math.max(0, width - visibleWidth(line))), user, expanded && index === selected);
    });
  };
  let agentExpiry = Infinity;
  const expandedPrompts = new Map<number, string>();
  const expandedSubagents = new Set<string>();
  const expandedTools = new Set<string>();
  const expandedThinking = new Set<string>();
  const thinkingPreviews = new Map<string, { text: string; source: string; width: number; rows: number; live: boolean }>();
  const agentModes = new Map<number, "all" | "preview">();
  const runningTurns = new Set<number>();
  let pinnedToolId: string | undefined;
  let pinnedTool: { id: string; y: number; line: string } | undefined;
  let pinnedAgentIndex: number | undefined;
  let pinnedAgent: { index: number; y: number; line: string } | undefined;
  let pinnedSubagentId: string | undefined;
  let pinnedSubagent: { id: string; y: number; line: string; autoScroll?: boolean } | undefined;
  let toolControls: Array<{ id: string; y: number; width: number; title: string }> = [];
  let agentControls: Array<{ index: number; y: number; width: number }> = [];
  let hoveredTool: typeof toolControls[number] | undefined;
  const clearHover = () => { const changed = !!hoveredTool; hoveredTool = undefined; return changed; };
  const toggleTool = (id: string) => {
    if (id.startsWith("thinking:")) {
      const present = getTurns().some((turn, turnIndex) => turn.process.some((entry, processIndex) =>
        entry.startsWith("thinking") && `thinking:${turnIndex}:${processIndex}` === id));
      if (!present) return;
      if (expandedThinking.has(id)) expandedThinking.delete(id);
      else expandedThinking.add(id);
      clearHover();
      return;
    }
    if (id.startsWith("agents:")) {
      const index = Number(id.slice(7));
      if (!Number.isInteger(index) || !getTurns()[index]) return;
      const all = (agentModes.get(index) ?? (isExpanded() ? "all" : "preview")) === "all";
      agentModes.set(index, all ? "preview" : "all");
      if (all) { expandedThinking.clear(); expandedTools.clear(); expandedSubagents.clear(); }
      pinnedAgentIndex = all ? undefined : index;
      clearHover();
      return;
    }
    if (!getTurns().some(turn => turn.agentCalls?.some(call => call.id === id && !isAgentTool(call.tool ?? call.name)))) return;
    if (expandedTools.has(id)) {
      expandedTools.delete(id);
      if (pinnedToolId === id) pinnedToolId = undefined;
    } else {
      expandedTools.add(id);
      // Only the latest opened tool owns the sticky heading; others stay open.
      pinnedToolId = id;
    }
    clearHover();
  };
  const toggleSubagent = (runId: string) => {
    if (!subagentControls.some(control => control.runId === runId)) return;
    if (expandedSubagents.has(runId)) {
      expandedSubagents.delete(runId);
      if (pinnedSubagentId === runId) pinnedSubagentId = undefined;
    } else {
      expandedSubagents.add(runId);
      // SubAgent details open in place; sticky heading engages only after scrolling.
      pinnedSubagentId = runId;
    }
  };
  let promptControls: Array<{ index: number; question: string; y: number; x: number; width: number; label: string }> = [];
  let subagentControls: Array<{ runId: string; y: number; width: number; line: string }> = [];
  let noticeRegions: Array<{ y: number; rows: NoticeRows }> = [];
  const togglePrompt = (index: number, question: string) => {
    if (getTurns()[index]?.question !== question) return;
    if (expandedPrompts.get(index) === question) expandedPrompts.delete(index);
    else expandedPrompts.set(index, question);
  };
  return {
    dispose() { assistantImages?.dispose(); },
    invalidate() { clearHover(); },
    resetProcessView() {
      agentModes.clear(); expandedThinking.clear(); expandedTools.clear(); expandedSubagents.clear();
      thinkingPreviews.clear();
      pinnedToolId = undefined; pinnedAgentIndex = undefined; pinnedSubagentId = undefined;
    },
    clearHover,
    pinnedTool: () => pinnedTool,
    unpinTool: () => { pinnedToolId = undefined; pinnedTool = undefined; },
    pinnedAgent: () => pinnedAgent,
    unpinAgent: () => { pinnedAgentIndex = undefined; pinnedAgent = undefined; },
    pinnedSubagent: () => pinnedSubagent,
    unpinSubagent: () => { pinnedSubagentId = undefined; pinnedSubagent = undefined; },
    toolChoices: () => toolControls.map(control => ({ ...control, expanded: expandedTools.has(control.id) || expandedThinking.has(control.id) })),
    toggleTool,
    toggleSubagent,
    agentExpiry: () => agentExpiry,
    promptChoices: () => promptControls.map(control => ({ ...control })),
    togglePrompt,
    handleMouse(event: TuiMouseEvent) {
      const tool = toolControls.find(control => event.y === control.y && event.x >= 2 && event.x < Math.min(5, control.width));
      if (event.type === "move") {
        const next = !event.shift && !event.ctrl && !event.alt ? tool : undefined;
        if (hoveredTool?.id !== next?.id) {
          hoveredTool = next;
          return { handled: true, render: true };
        }
        return;
      }
      if (event.type === "wheel" || event.type === "drag") { clearHover(); return; }
      if (tool && event.button === "left" && !event.shift && !event.ctrl && !event.alt) {
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          toggleTool(tool.id);
          return { handled: true, render: true };
        }
      }
      if (event.button !== "left" || event.shift || event.ctrl || event.alt) return;
      const agent = agentControls.find(control => event.y === control.y && event.x >= 0 && event.x < control.width);
      if (agent && (event.clickCount ?? 1) === 1) {
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          const all = (agentModes.get(agent.index) ?? (isExpanded() ? "all" : "preview")) === "all";
          agentModes.set(agent.index, all ? "preview" : "all");
          if (all) { expandedThinking.clear(); expandedTools.clear(); expandedSubagents.clear(); }
          pinnedAgentIndex = all ? undefined : agent.index;
          return { handled: true, render: true };
        }
      }
      const control = promptControls.find(control => event.y === control.y && event.x >= control.x && event.x < control.x + control.width);
      if (control && (event.clickCount ?? 1) === 1) {
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          togglePrompt(control.index, control.question);
          return { handled: true, render: true };
        }
      }
      const sub = subagentControls.find(control => event.y === control.y && event.x >= 0 && event.x < control.width);
      if (sub) {
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          toggleSubagent(sub.runId);
          return { handled: true, render: true };
        }
      }
      if ((event.clickCount ?? 1) !== 1) return;
      const region = noticeRegions.find(region => event.y >= region.y && event.y < region.y + region.rows.length);
      return region?.rows.handleMouse?.({ ...event, y: event.y - region.y });
    },
    render(width: number, notices?: TurnNotices): string[] {
      promptControls = [];
      toolControls = [];
      agentControls = [];
      pinnedTool = undefined;
      pinnedAgent = undefined;
      pinnedSubagent = undefined;
      subagentControls = [];
      noticeRegions = [];
      agentExpiry = Infinity;
      if (width <= 0) { clearHover(); return []; }
      const turns = getTurns();
      const toolIds = new Set(turns.flatMap(turn => (turn.agentCalls ?? []).map(call => call.id)));
      for (const id of expandedTools) if (!toolIds.has(id)) expandedTools.delete(id);
      const thinkingIds = new Set(turns.flatMap((turn, turnIndex) => turn.process.flatMap((entry, processIndex) =>
        entry.startsWith("thinking") ? [`thinking:${turnIndex}:${processIndex}`] : [])));
      for (const id of expandedThinking) if (!thinkingIds.has(id)) expandedThinking.delete(id);
      for (const id of thinkingPreviews.keys()) if (!thinkingIds.has(id)) thinkingPreviews.delete(id);
      const inner = Math.max(1, width - 2 * Math.min(2, Math.floor((width - 1) / 2)));
      const lines: string[] = [];
      // An open heading wears the same full-width selectedBg band as an expanded SubAgent row.
      const bandHeading = (row: string, open: boolean) => open
        ? paintExpandedHeading(theme, row + " ".repeat(Math.max(0, width - visibleWidth(row)))) : row;
      for (const [index, turn] of turns.entries()) {
        if (index > 0) lines.push("");
        if (expandedPrompts.has(index) && expandedPrompts.get(index) !== turn.question) expandedPrompts.delete(index);
        const noticeRows = notices?.get(index) ?? [];
        const questionRows = markdown(turn.question, inner);
        const loopSummary = piLoopSummary(turn.question);
        const expanded = expandedPrompts.get(index) === turn.question;
        // A fence is one visual unit; slicing it mid-block looks like raw source.
        const keepFence = !loopSummary && isFencedMarkdown(turn.question);
        // Loop wakeups are system-generated user messages. Collapse them even when
        // their short prompt would otherwise fit the normal four-row allowance.
        const userRows = expanded || keepFence ? [...questionRows] : loopSummary ? markdown(loopSummary, inner) : questionRows.slice(0, 4);
        let controlIndex = -1;
        if (!keepFence && (loopSummary || questionRows.length > 4)) {
          const label = expanded ? "▴ 收起" : loopSummary ? "▾ 展开" : `▾ 展开 (${questionRows.length} 行)`;
          const control = truncateToWidth(label, inner, "");
          promptControls.push({ index, question: turn.question, y: lines.length + 1 + userRows.length,
            x: 0, width, label });
          userRows.push(theme.fg("accent", control));
          // The expanded control is this message's heading, so it keeps the band in place of the user surface.
          controlIndex = userRows.length;
        }
        lines.push(...surface(userRows, width, true, controlIndex, expanded));
        const entries = turn.process.flatMap((entry, processIndex) => {
          if (entry.startsWith("call ")) {
            const call = turn.agentCalls?.find(call => call.id === entry.slice(5));
            if (call && isAgentTool(call.tool ?? call.name)) return [];
            const display = call && agentCallDisplay(call);
            return call && display ? [{ title: `${isAgentTool(call.tool ?? call.name) ? "Control" : call.name} ${display.summary}`.trim(), detail: display.detail, state: call.state, id: call.id, thinking: false, processIndex, activeThinking: false }] : [];
          }
          const part = entry.match(/^(tool|output|thinking|skill)(?:\s+|$)([\s\S]*)/);
          const thinking = part?.[1] === "thinking";
          const activeThinking = thinking && turn.running && turn.thinking === processIndex;
          const failedThinking = thinking && /^(error|aborted)$/.test(turn.thinkingOutcomes?.[processIndex] ?? "");
          const label = ({ tool: "Tool", output: "Output", thinking: "Thinking", skill: "Skill" } as Record<string, string>)[part?.[1] ?? ""] ?? "Process";
          return [{ title: `${label} ${part?.[2] ?? entry}`, detail: part?.[2] ?? entry, state: failedThinking ? "error" : activeThinking ? "running" : "done", id: thinking ? `thinking:${index}:${processIndex}` : "", thinking, processIndex, activeThinking }];
        });
        // Older in-memory turns may predate call markers.
        for (const call of turn.agentCalls ?? []) {
          if (isAgentTool(call.tool ?? call.name)) continue;
          const display = agentCallDisplay(call);
          if (!entries.some(entry => entry.id === call.id)) entries.push({ title: `${isAgentTool(call.tool ?? call.name) ? "Control" : call.name} ${display.summary}`, detail: display.detail, state: call.state, id: call.id, thinking: false, processIndex: -1, activeThinking: false });
        }
        const agentTurnControls: Array<{ runId: string; y: number; width: number; line: string }> = [];
        const agents = liveAgentView(turn.subAgents ?? [], theme, width, subAgentsExpanded(), true, agentDeadlines, Date.now(), expandedSubagents, agentTurnControls);
        const active = !!turn.running || agents.running > 0 || entries.some(entry => entry.state === "running") || (turn.waitingTools?.length ?? 0) > 0;
        if (active) runningTurns.add(index);
        else if (runningTurns.delete(index)) {
          // Return to the configured preview once; a later click can expand everything again.
          if (agentModes.get(index) === "all") {
            agentModes.set(index, "preview");
            expandedThinking.clear();
            expandedTools.clear();
            expandedSubagents.clear();
            if (pinnedAgentIndex === index) pinnedAgentIndex = undefined;
          }
        }
        if (entries.length || active || turn.usage || agents.total) {
          const mode = agentModes.get(index) ?? (isExpanded() ? "all" : "preview");
          const expanded = mode === "all";
          const busy = entries.some(entry => entry.state === "running") || (turn.waitingTools?.length ?? 0) > 0;
          const working = turn.running && !busy && !turn.final;
          // Every child keeps its heading; process records share the remaining preview budget.
          const processLimit = Math.max(0, getRecordLimit() - agents.total);
          const shown = expanded ? entries : processLimit ? entries.slice(-processLimit) : [];
          const showWorking = working && (turn.awaitingResponse || expanded || (!shown.length && !agents.total));
          const sparkle = active ? Math.floor(Date.now() / 360) % 2 ? "✧" : "✦" : "✦";
          const usage = addUsage({ ...EMPTY_USAGE, ...turn.usage, cost: turn.usage?.cost ?? 0 }, turn.pendingUsage);
          const hasUsage = usage.totalTokens > 0 || usage.cacheRead > 0;
          const totals = hasUsage
            ? theme.fg("muted", "会话 ") + theme.bold(theme.fg("text", formatTokens(usage.totalTokens)))
              + theme.fg("muted", " · 缓存 ") + theme.bold(theme.fg("text", formatTokens(usage.cacheRead)))
            : "";
          const recordCount = entries.length + agents.total;
          const progressHeader = theme.fg(active ? "accent" : "muted", sparkle + " ") + theme.bold(theme.fg("text", "Agent")) + theme.fg("muted", recordCount ? ` · ${recordCount}` : "");
          const showAgentRows = agents.total > 0;
          const caret = theme.fg("muted", expanded ? " ▾" : " ▸");
          const elapsedHeader = turn.startedAt == null ? "" : theme.fg("muted", " · ") + theme.fg(active ? "success" : "muted", formatElapsed(turn.startedAt, turn.endedAt ?? Date.now()));
          const left = progressHeader + elapsedHeader + caret;
          const showTotals = hasUsage && showUsage() && visibleWidth(left) + 2 + visibleWidth(totals) <= width;
          agentControls.push({ index, y: lines.length + 1, width: Math.min(width, visibleWidth(left)) });
          if (expanded && pinnedAgentIndex === index) pinnedAgent = { index, y: lines.length + 1, line: truncateToWidth(left, width) };
          lines.push("", showTotals
            ? left + " ".repeat(width - visibleWidth(left) - visibleWidth(totals)) + totals
            : truncateToWidth(left, width));
          shown.forEach((entry, row) => {
            const title = entry.title;
            const text = title.split(/\r?\n/).find(line => line.trim())?.replace(/\s+/g, " ").trim() ?? "";
            const split = text.indexOf(" ");
            const noThinkingBody = entry.thinking && !stripVTControlCharacters(entry.detail).trim();
            const label = split < 0 ? text : text.slice(0, split);
            const body = split < 0 ? "" : text.slice(split + 1);
            const activeThinking = !!entry.activeThinking;
            const elapsed = entry.thinking ? formatThinkingElapsed(turn, entry.processIndex, activeThinking) : "";
            const thinkingElapsed = elapsed ? theme.fg(activeThinking ? "success" : "muted", ` ${elapsed}`) : "";
            const call = turn.agentCalls?.find(call => call.id === entry.id && !isAgentTool(call.tool ?? call.name));
            const controlId = call?.id ?? (entry.thinking && !noThinkingBody || entry.id.startsWith("agents:") ? entry.id : "");
            const open = call ? expandedTools.has(call.id) : entry.thinking && !noThinkingBody && expandedThinking.has(entry.id);
            const identity = entry.state === "error" ? "error" : open || activeThinking ? "accent" : "text";
            const duration = call ? formatToolElapsed(call.startedAt, call.endedAt ?? Date.now()) : "";
            const toolElapsed = duration ? theme.fg(entry.state === "error" ? "error" : call?.state === "running" ? "accent" : "muted", ` ${duration}`) : "";
            const summary = theme.fg(identity, theme.bold(label)) + thinkingElapsed + toolElapsed + " ";
            if (controlId && width >= 4) toolControls.push({ id: controlId, y: lines.length, width, title: text });
            if (hoveredTool?.id === controlId && (hoveredTool.y !== lines.length || hoveredTool.width !== width)) clearHover();
            const status = entry.state === "running" ? runningGlyph() : "●";
            const arrow = !!controlId && (open || hoveredTool?.id === controlId);
            const keepStatus = entry.state === "running";
            const glyph = arrow ? (open ? "▼" : "▶") + (keepStatus ? ` ${status}` : "") : status;
            const glyphColor = entry.state === "error" ? "error" : entry.state === "running" || arrow ? "accent" : "muted";
            const last = row === shown.length - 1 && !showWorking && !agents.rows.length;
            const prefix = theme.fg(open ? "accent" : "dim", "│ ") + (entry.state === "running" || arrow ? theme.fg(glyphColor, glyph) + " " : "") + summary;
            if (label === "Output") {
              // Wrapped output hangs under the body column and keeps the tree rail to the next sibling.
              const indent = visibleWidth(prefix);
              const rail = !last && indent > 0 ? theme.fg("dim", "\u2502") + " ".repeat(indent - 1) : " ".repeat(indent);
              const wrapped = markdown(body, Math.max(1, width - indent), true);
              lines.push(truncateToWidth(prefix + (wrapped[0] ?? ""), width, ""));
              for (const extra of wrapped.slice(1)) lines.push(truncateToWidth(rail + extra, width, ""));
            } else {
              const available = Math.max(0, width - visibleWidth(prefix));
              if (entry.thinking) {
                const cached = thinkingPreviews.get(entry.id);
                const previewRows = open ? 1 : 2;
                const reuse = cached?.source === entry.detail && cached.width === available && cached.rows === previewRows && cached.live === activeThinking;
                const display = reuse ? cached.text : thinkingPreview(entry.detail, available, previewRows, activeThinking);
                if (!reuse) thinkingPreviews.set(entry.id, { text: display, source: entry.detail, width: available, rows: previewRows, live: activeThinking });
                const outcome = turn.thinkingOutcomes?.[entry.processIndex];
                const fallback = activeThinking ? "正在思考，等待可显示摘要"
                  : outcome === "aborted" ? "思考已中断，未返回可显示摘要"
                  : outcome === "error" ? "思考失败，未返回可显示摘要" : "思考已结束，未返回可显示摘要";
                const rows = available > 0 ? new Text(display || fallback, 0, 0).render(available).slice(0, previewRows) : [];
                const color = entry.state === "error" ? "error" : activeThinking ? "accent" : "muted";
                lines.push(bandHeading(truncateToWidth(prefix + theme.fg(color, rows[0] ?? ""), width, ""), open));
                const rail = theme.fg(last ? color : "dim", last ? " " : "│") + " ".repeat(Math.max(0, visibleWidth(prefix) - 1));
                for (const extra of rows.slice(1)) lines.push(truncateToWidth(rail + theme.fg(color, extra), width, ""));
              } else {
                const displayBody = placeholderText(body);
                const compactBody = linkToolFiles(displayBody, imageOptions?.cwd() ?? process.cwd(), !open);
                const fittedBody = truncateToWidth(compactBody, available, "…");
                // Always close a hyperlink before subsequent rows.
                const styledBody = theme.fg(entry.state === "error" ? "error" : open ? "accent" : "muted", fittedBody + "\x1b]8;;\x07");
                lines.push(bandHeading(truncateToWidth(prefix + styledBody, width, "…"), open));
              }
            }
            if (open && call && call.id === pinnedToolId) pinnedTool = { id: call.id, y: lines.length - 1, line: lines.at(-1)! };
            if (open && call) {
              // ponytail: saved text only; native view retains images, args and custom renderers.
              const output = stripVTControlCharacters(call.output ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
              const rail = width > 5 ? (last ? "     " : theme.fg("accent", "│    ")) : "";
              const detailWidth = Math.max(1, width - visibleWidth(rail));
              if (call.task && (/\r|\n/.test(call.task) || visibleWidth(call.task) > width - visibleWidth(prefix))) {
                const input = stripVTControlCharacters(call.task).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
                lines.push(...new Text(`输入：\n${input}`, 0, 0).render(detailWidth).map(line => truncateToWidth(rail + theme.fg("muted", line), width, "")));
                lines.push(truncateToWidth(rail + theme.fg("muted", "输出："), width, ""));
              }
              const details = new Text(output || (entry.state === "running" ? "等待工具文本结果…" : "无文本结果"), 0, 0).render(detailWidth);
              lines.push(...details.map(line => truncateToWidth(rail + theme.fg(entry.state === "error" ? "error" : "muted", line), width, "")));
            } else if (open && entry.thinking) {
              const rail = width > 5 ? (last ? "     " : theme.fg("accent", "│    ")) : "";
              const detailWidth = Math.max(1, width - visibleWidth(rail));
              lines.push(...markdown(entry.detail, detailWidth, true).map(line => truncateToWidth(rail + line, width, "")));
            }
          });
          if (showAgentRows) {
            const agentStartY = lines.length;
            for (const c of agentTurnControls) {
              const control = { ...c, y: agentStartY + c.y };
              subagentControls.push(control);
              if (c.runId === pinnedSubagentId) pinnedSubagent = { id: c.runId, y: control.y, line: c.line, autoScroll: false };
            }
            lines.push(...agents.rows);
          }
          if (showWorking) {
            const label = turn.awaitingResponse ? "Waiting" : "Working";
            const prefix = theme.fg("dim", "└─ ") + theme.fg("accent", `${runningGlyph()} `) + theme.fg("text", theme.bold(label)) + " ";
            lines.push(truncateToWidth(prefix + theme.fg("muted", turn.awaitingResponse ? "等待模型响应" : "等待下一步执行"), width, ""));
          }
        }
        for (const [replyIndex, reply] of (turn.replies ?? []).entries()) lines.push("", ...assistantMarkdown(reply, width, `reply:${index}:${replyIndex}`));
        if (turn.final) lines.push("", ...assistantMarkdown(turn.final, width, `final:${index}`));
        noticeRegions.push({ y: lines.length, rows: noticeRows });
        lines.push(...noticeRows);
      }
      if (hoveredTool && !toolControls.some(control => control.id === hoveredTool!.id)) clearHover();
      for (const deadline of agentDeadlines.values()) if (deadline > Date.now()) agentExpiry = Math.min(agentExpiry, deadline);
      return lines;
    },
  };
}
