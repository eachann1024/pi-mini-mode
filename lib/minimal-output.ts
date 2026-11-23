import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { agentCallDisplay, agentChildren, childSessionData, isAgentTool, isPrintAgentCall, liveAgentView, printAgentStatuses, runningGlyph, type AgentCall } from "./agent-view.ts";
import { assistantImageSpans, clearAssistantImageCaches, createAssistantImages, imagePlaceholders } from "./assistant-images.ts";
import { clearFileLinkCaches, linkToolFiles } from "./file-links.ts";
import { createLinkHover } from "./link-hover.ts";
import { diagramMarkdown, isFencedMarkdown, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { minimalSurface, paintExpandedHeading } from "./minimal-theme.ts";
import { formatElapsed, formatThinkingElapsed, formatToolElapsed, piLoopSummary, type MinimalTurn } from "./minimal-turns.ts";
import { clearPrintAgentCaches } from "./print-agent.ts";
import { DEFAULT_SETTINGS, type UiLanguage } from "./settings.ts";
import { thinkingPreview } from "./thinking-preview.ts";
import type { NoticeRows, TurnNotices } from "./transcript-adapter.ts";
import { renderUpdateBanner } from "./update-banner.ts";
import { addUsage, EMPTY_USAGE, formatTokens } from "./usage.ts";

/** Shown when a thinking block has no displayable summary. */
const THINKING_FALLBACK: Record<UiLanguage, Record<"active" | "aborted" | "error" | "ended", string>> = {
  zh: { active: "正在思考，等待可显示摘要", aborted: "思考已中断，未返回可显示摘要", error: "思考失败，未返回可显示摘要", ended: "思考已结束，未返回可显示摘要" },
  en: { active: "Waiting for a displayable summary", aborted: "Interrupted, no displayable summary returned", error: "Failed, no displayable summary returned", ended: "Finished, no displayable summary returned" },
};

const MINIMAL_COPY = {
  zh: {
    collapsePrompt: "▴ 收起",
    expandPrompt: "▾ 展开",
    expandPromptLines: (n: number) => `▾ 展开 (${n} 行)`,
    session: "会话 ",
    cache: " · 缓存 ",
    inputLabel: "输入：",
    outputLabel: "输出：",
    waitingToolResult: "等待工具文本结果…",
    emptyToolResult: "无文本结果",
    waitingModel: "等待模型响应",
    waitingNextStep: "等待下一步执行",
  },
  en: {
    collapsePrompt: "▴ Collapse",
    expandPrompt: "▾ Expand",
    expandPromptLines: (n: number) => `▾ Expand (${n} lines)`,
    session: "Session ",
    cache: " · Cache ",
    inputLabel: "Input:",
    outputLabel: "Output:",
    waitingToolResult: "Waiting for tool text result…",
    emptyToolResult: "No text result",
    waitingModel: "Waiting for model response",
    waitingNextStep: "Waiting for next step",
  },
} as const;

const LRU_MAX = 800;
function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return map.get(key);
}
function lruSet<K, V>(map: Map<K, V>, key: K, val: V, max = LRU_MAX): V {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, val);
  return val;
}

function keysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** First row with this y. Each control list is one record per rendered line, so y is unique. */
function firstAtY<T extends { y: number }>(rows: readonly T[], y: number): T | undefined {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rowY = rows[mid].y;
    if (rowY < y) lo = mid + 1;
    else if (rowY > y) hi = mid - 1;
    else {
      let index = mid;
      while (index > 0 && rows[index - 1].y === y) index--;
      return rows[index];
    }
  }
  return undefined;
}

function isSubAgentChildRunning(child: Record<string, unknown>): boolean {
  const exit = typeof child.exitCode === "number" ? child.exitCode : undefined;
  const raw = String(child.status ?? child.state ?? "");
  const failed = (exit !== undefined && exit > 0) || /^(failed|error|aborted|cancelled|canceled|timed?_?out|killed)$/i.test(raw);
  const done = !failed && /^(done|completed?|succeeded|success|failed|error|aborted|cancelled|canceled|stopped|timed?_?out|killed)$/i.test(raw);
  return !failed && !done;
}

interface TurnRenderResult {
  lines: string[];
  promptControls: Array<{ index: number; question: string; y: number; x: number; width: number; label: string }>;
  toolControls: Array<{ id: string; y: number; width: number; title: string }>;
  processRows: Array<{ key: string; y: number }>;
  agentControls: Array<{ index: number; y: number; width: number }>;
  subagentControls: Array<{ runId: string; y: number; width: number; line: string }>;
  pinnedTool?: { id: string; y: number; line: string };
  pinnedAgent?: { index: number; y: number; line: string };
  pinnedSubagent?: { id: string; y: number; line: string; autoScroll?: boolean };
  claimedPrintFiles: string[];
}

export interface UpdateBannerState {
  version: string;
  previousVersion?: string;
  collapsed: boolean;
  toggle: () => void;
}

export interface MinimalOutputOptions {
  cwd(): string;
  requestRender(): void;
  write?(data: string): void;
  updateBanner?: () => UpdateBannerState | undefined;
}

export function minimalOutputComponent(theme: ExtensionContext["ui"]["theme"], getTurns: () => MinimalTurn[], isExpanded: () => boolean = () => false, showUsage: () => boolean = () => true, subAgentsExpanded: () => boolean = () => false, agentDeadlines = new Map<string, number>(), transformText: (text: string) => string = text => text, imageOptions?: MinimalOutputOptions, getRecordLimit: () => number = () => DEFAULT_SETTINGS["pi-mini-mode-minimal-record-limit"], getLanguage: () => UiLanguage = () => "zh", getUpdateBanner?: () => UpdateBannerState | undefined) {
  const resolveUpdateBanner = getUpdateBanner ?? imageOptions?.updateBanner;
  const markdownCache = new Map<string, string[]>();
  const assistantMdCache = new Map<string, string[]>();
  const callDisplayCache = new Map<string, { tool?: string; name: string; action?: string; state: string; task: string; output?: string; value: { summary: string; detail: string } }>();
  const turnCache = new Map<number, { key: readonly unknown[]; value: TurnRenderResult }>();
  const placeholderText = (text: string) => imageOptions ? imagePlaceholders(text, imageOptions.cwd()) : text;
  const markdown = (text: string, width: number, process = false): string[] => {
    const key = `${process ? 1 : 0}|${width}|${text}`;
    const hit = lruGet(markdownCache, key);
    if (hit !== undefined) return [...hit];
    const rows = renderMinimalMarkdown(text, width, getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "",
      { color: (value) => theme.fg(process ? "muted" : "text", value) }, (source, available) => transformText(placeholderText(diagramMarkdown(source, available))));
    lruSet(markdownCache, key, rows);
    return [...rows];
  };
  const thinkingMarkdown = (text: string, width: number, color: "error" | "accent" | "muted", previewRows: number): string[] => {
    const key = `t:${color}|${width}|${previewRows}|${text}`;
    const hit = lruGet(markdownCache, key);
    if (hit !== undefined) return [...hit];
    const rows = renderMinimalMarkdown(text, width, getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "",
      { color: value => theme.fg(color, value) }, (source, avail) => transformText(placeholderText(diagramMarkdown(source, avail))))
      .slice(0, previewRows);
    lruSet(markdownCache, key, rows);
    return [...rows];
  };
  const assistantImages = imageOptions && createAssistantImages(imageOptions.cwd, () => { turnCache.clear(); imageOptions.requestRender(); }, imageOptions.write);
  const assistantMarkdown = (text: string, width: number, owner: string): string[] => {
    if (!assistantImages) return markdown(text, width);
    const key = `${width}|${text}`;
    const hit = lruGet(assistantMdCache, key);
    if (hit !== undefined) return [...hit];
    if (!assistantImageSpans(text, imageOptions!.cwd()).length) {
      const rows = markdown(text, width);
      lruSet(assistantMdCache, key, rows);
      return [...rows];
    }
    return assistantImages.render(text, width, markdown, owner);
  };
  const cachedCallDisplay = (call: AgentCall) => {
    const hit = callDisplayCache.get(call.id);
    if (hit && hit.state === call.state && hit.output === call.output && hit.task === call.task && hit.name === call.name && hit.tool === call.tool && hit.action === call.action) {
      return hit.value;
    }
    const value = agentCallDisplay(call);
    lruSet(callDisplayCache, call.id, { tool: call.tool, name: call.name, action: call.action, state: call.state, task: call.task, output: call.output, value });
    return value;
  };
  const clearAllCaches = () => {
    markdownCache.clear();
    assistantMdCache.clear();
    callDisplayCache.clear();
    turnCache.clear();
    clearAssistantImageCaches();
    clearFileLinkCaches();
    clearPrintAgentCaches();
  };
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
  let processRows: Array<{ key: string; y: number }> = [];
  let hoveredProcess: { key: string; y: number } | undefined;
  let hoverWidth = 0;
  let agentControls: Array<{ index: number; y: number; width: number }> = [];
  let hoveredTool: typeof toolControls[number] | undefined;
  const linkHover = createLinkHover(text => paintExpandedHeading(theme, text));
  const clearHover = () => { const changed = !!hoveredTool || hoveredProcess !== undefined; hoveredTool = undefined; hoveredProcess = undefined; return linkHover.clear() || changed; };
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
    if (!getTurns().some(turn => turn.agentCalls?.some(call => call.id === id && !isAgentTool(call.tool ?? call.name) && !isPrintAgentCall(call)))) return;
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
  let bannerControl: { headerRows: number; totalRows: number; width: number; toggle: () => void } | undefined;
  const togglePrompt = (index: number, question: string) => {
    if (getTurns()[index]?.question !== question) return;
    if (expandedPrompts.get(index) === question) expandedPrompts.delete(index);
    else expandedPrompts.set(index, question);
  };
  return {
    dispose() { assistantImages?.dispose(); },
    invalidate() { clearHover(); clearAllCaches(); },
    resetProcessView() {
      agentModes.clear(); expandedThinking.clear(); expandedTools.clear(); expandedSubagents.clear();
      thinkingPreviews.clear();
      clearAllCaches();
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
      const toolAt = firstAtY(toolControls, event.y);
      const tool = toolAt && event.x >= 2 && event.x < Math.min(5, toolAt.width) ? toolAt : undefined;
      if (event.type === "move") {
        const linkChanged = linkHover.handleMouse(event);
        const next = !event.shift && !event.ctrl && !event.alt ? tool : undefined;
        const record = firstAtY(processRows, event.y);
        if (hoveredTool?.id !== next?.id || hoveredProcess?.key !== record?.key || hoveredProcess?.y !== record?.y || linkChanged) {
          hoveredTool = next;
          hoveredProcess = record;
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
      if (bannerControl && (event.clickCount ?? 1) === 1) {
        const inHeader = event.y >= 0 && event.y < bannerControl.headerRows;
        const inFooter = bannerControl.totalRows > bannerControl.headerRows
          && event.y >= bannerControl.totalRows - 3 && event.y < bannerControl.totalRows;
        if ((inHeader || inFooter) && event.x >= 0 && event.x < bannerControl.width) {
          if (event.type === "press") return { handled: true };
          if (event.type === "click") {
            bannerControl.toggle();
            return { handled: true, render: true };
          }
        }
      }
      const agentAt = firstAtY(agentControls, event.y);
      const agent = agentAt && event.x >= 0 && event.x < agentAt.width ? agentAt : undefined;
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
      const promptAt = firstAtY(promptControls, event.y);
      const control = promptAt && event.x >= promptAt.x && event.x < promptAt.x + promptAt.width ? promptAt : undefined;
      if (control && (event.clickCount ?? 1) === 1) {
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          togglePrompt(control.index, control.question);
          return { handled: true, render: true };
        }
      }
      const subAt = firstAtY(subagentControls, event.y);
      const sub = subAt && event.x >= 0 && event.x < subAt.width ? subAt : undefined;
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
      if (width !== hoverWidth) clearHover();
      hoverWidth = width;
      promptControls = [];
      toolControls = [];
      processRows = [];
      agentControls = [];
      pinnedTool = undefined;
      pinnedAgent = undefined;
      pinnedSubagent = undefined;
      subagentControls = [];
      noticeRegions = [];
      bannerControl = undefined;
      agentExpiry = Infinity;
      if (width <= 0) { clearHover(); return linkHover.render([], width); }
      const turns = getTurns();
      if (turnCache.size > turns.length) {
        for (const k of turnCache.keys()) if (k >= turns.length) turnCache.delete(k);
      }
      const renderCwd = imageOptions?.cwd() ?? process.cwd();
      const claimedPrintSessions = new Set<string>();
      const isCapturedCall = (call: AgentCall) => isAgentTool(call.tool ?? call.name) || isPrintAgentCall(call);
      if (expandedTools.size > 0) {
        const toolIds = new Set(turns.flatMap(turn => (turn.agentCalls ?? []).filter(call => !isCapturedCall(call)).map(call => call.id)));
        for (const id of expandedTools) if (!toolIds.has(id)) expandedTools.delete(id);
      }
      if (expandedThinking.size > 0 || thinkingPreviews.size > 0) {
        const hasThinkingId = (id: string) => {
          const parts = id.split(":");
          return Boolean(turns[Number(parts[1])]?.process[Number(parts[2])]?.startsWith("thinking"));
        };
        for (const id of expandedThinking) if (!hasThinkingId(id)) expandedThinking.delete(id);
        for (const id of thinkingPreviews.keys()) if (!hasThinkingId(id)) thinkingPreviews.delete(id);
      }
      const inner = Math.max(1, width - 2 * Math.min(2, Math.floor((width - 1) / 2)));
      const lines: string[] = [];
      // An open heading wears the same full-width selectedBg band as an expanded SubAgent row.
      const bandHeading = (row: string, open: boolean) => open
        ? paintExpandedHeading(theme, row + " ".repeat(Math.max(0, width - visibleWidth(row)))) : row;
      const now = Date.now();
      let hasFutureDeadline = false;
      for (const deadline of agentDeadlines.values()) {
        if (deadline > now) {
          hasFutureDeadline = true;
          agentExpiry = Math.min(agentExpiry, deadline);
        }
      }
      const exp = isExpanded();
      const subExp = subAgentsExpanded();
      const usageShown = showUsage();
      const recLimit = getRecordLimit();
      const lang = getLanguage();
      const banner = resolveUpdateBanner?.();
      if (banner) {
        const renderedBanner = renderUpdateBanner(theme, width, {
          version: banner.version,
          previousVersion: banner.previousVersion,
          language: lang,
          collapsed: banner.collapsed,
        });
        if (renderedBanner.rows.length > 0) {
          bannerControl = {
            headerRows: renderedBanner.headerRows,
            totalRows: renderedBanner.rows.length,
            width,
            toggle: banner.toggle,
          };
          lines.push(...renderedBanner.rows);
          if (turns.length > 0) lines.push("");
        }
      }

      const buildTurnKey = (index: number, turn: MinimalTurn, baseY: number, subChildren: Record<string, unknown>[]): readonly unknown[] => {
        const usage = addUsage({ ...EMPTY_USAGE, ...turn.usage, cost: turn.usage?.cost ?? 0 }, turn.pendingUsage);
        const calls = turn.agentCalls ?? [];
        const turnExpandedTools = expandedTools.size > 0
          ? calls.filter(c => expandedTools.has(c.id)).map(c => c.id).join(",")
          : "";
        const thinkingPrefix = `thinking:${index}:`;
        let turnExpandedThinking = "";
        if (expandedThinking.size > 0) {
          for (const id of expandedThinking) {
            if (id.startsWith(thinkingPrefix)) turnExpandedThinking += (turnExpandedThinking ? "," : "") + id;
          }
        }
        const turnExpandedSubagents = expandedSubagents.size > 0 && (subChildren.length > 0 || calls.some(isPrintAgentCall))
          ? Array.from(expandedSubagents).join(",")
          : "";
        const hoveredId = hoveredTool && (hoveredTool.id.startsWith(thinkingPrefix) || calls.some(c => c.id === hoveredTool!.id))
          ? `${hoveredTool.id}@${hoveredTool.y - baseY}@${hoveredTool.width}`
          : "";
        const turnPinnedTool = pinnedToolId && calls.some(c => c.id === pinnedToolId) ? pinnedToolId : "";
        const turnPinnedAgent = pinnedAgentIndex === index ? index : -1;
        const turnPinnedSubagent = pinnedSubagentId && (subChildren.length > 0 || calls.some(isPrintAgentCall)) ? pinnedSubagentId : "";
        const elapsedSec = turn.startedAt != null && turn.endedAt == null
          ? Math.floor((now - turn.startedAt) / 1000)
          : (turn.endedAt ?? -1);
        const key: unknown[] = [
          width,
          exp,
          subExp,
          usageShown,
          recLimit,
          lang,
          agentModes.get(index),
          expandedPrompts.get(index),
          turnExpandedTools,
          turnExpandedThinking,
          turnExpandedSubagents,
          hoveredId,
          turnPinnedTool,
          turnPinnedAgent,
          turnPinnedSubagent,
          turn.question,
          turn.final ?? "",
          turn.replies?.length ?? 0,
          turn.replies?.at(-1) ?? "",
          turn.process.length,
          turn.process[0] ?? "",
          turn.process.at(-1) ?? "",
          turn.startedAt ?? -1,
          elapsedSec,
          turn.thinkingClocks?.length ?? 0,
          turn.thinkingClocks?.at(-1)?.endedAt ?? -1,
          turn.thinkingOutcomes?.length ?? 0,
          usage.totalTokens,
          usage.cacheRead,
          calls.length,
          subChildren.length,
        ];
        const replies = turn.replies;
        if (replies) for (let i = 0; i < replies.length; i++) key.push(replies[i]);
        for (let i = 0; i < turn.process.length; i++) key.push(turn.process[i]);
        const clocks = turn.thinkingClocks;
        if (clocks) {
          for (let i = 0; i < clocks.length; i++) {
            const clock = clocks[i];
            key.push(clock?.startedAt, clock?.endedAt);
          }
        }
        const outcomes = turn.thinkingOutcomes;
        if (outcomes) for (let i = 0; i < outcomes.length; i++) key.push(outcomes[i]);
        for (const c of calls) {
          key.push(c.id, c.state, c.task, c.output?.length ?? -1, c.output, c.startedAt ?? -1, c.endedAt ?? -1, c.name, c.tool, c.action, c.command);
        }
        for (const sub of subChildren) {
          key.push(
            sub.runId ?? sub.displayId,
            sub.status ?? sub.state,
            sub.finalOutput,
            sub.error,
            (sub.notice as { summary?: unknown } | undefined)?.summary,
            (sub.noticeMessages as unknown[] | undefined)?.length ?? 0,
            childSessionData(sub.sessionFile)?.stamp ?? "",
          );
        }
        return key;
      };

      const renderTurn = (index: number, turn: MinimalTurn, baseY: number): TurnRenderResult => {
        const turnLines: string[] = [];
        const turnPromptControls: TurnRenderResult["promptControls"] = [];
        const turnToolControls: TurnRenderResult["toolControls"] = [];
        const turnProcessRows: TurnRenderResult["processRows"] = [];
        const turnAgentControls: TurnRenderResult["agentControls"] = [];
        const turnSubagentControls: TurnRenderResult["subagentControls"] = [];
        let turnPinnedTool: TurnRenderResult["pinnedTool"];
        let turnPinnedAgent: TurnRenderResult["pinnedAgent"];
        let turnPinnedSubagent: TurnRenderResult["pinnedSubagent"];
        const beforeClaimedSize = claimedPrintSessions.size;
        const copy = MINIMAL_COPY[lang] ?? MINIMAL_COPY.zh;

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
          const label = expanded ? copy.collapsePrompt : loopSummary ? copy.expandPrompt : copy.expandPromptLines(questionRows.length);
          const control = truncateToWidth(label, inner, "");
          turnPromptControls.push({ index, question: turn.question, y: turnLines.length + 1 + userRows.length,
            x: 0, width, label });
          userRows.push(theme.fg("accent", control));
          // The expanded control is this message's heading, so it keeps the band in place of the user surface.
          controlIndex = userRows.length;
        }
        turnLines.push(...surface(userRows, width, true, controlIndex, expanded));
        const entries = turn.process.flatMap((entry, processIndex) => {
          if (entry.startsWith("call ")) {
            const call = turn.agentCalls?.find(call => call.id === entry.slice(5));
            if (call && isCapturedCall(call)) return [];
            const display = call && cachedCallDisplay(call);
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
          if (isCapturedCall(call)) continue;
          const display = cachedCallDisplay(call);
          if (!entries.some(entry => entry.id === call.id)) entries.push({ title: `${isAgentTool(call.tool ?? call.name) ? "Control" : call.name} ${display.summary}`, detail: display.detail, state: call.state, id: call.id, thinking: false, processIndex: -1, activeThinking: false });
        }
        const printStatuses = (turn.agentCalls ?? []).flatMap(call => printAgentStatuses(call, renderCwd, claimedPrintSessions));
        const claimedPrintFiles = claimedPrintSessions.size > beforeClaimedSize
          ? Array.from(claimedPrintSessions).slice(beforeClaimedSize)
          : [];
        const combinedSubAgents = [...(turn.subAgents ?? []), ...printStatuses];
        const hasTableSubAgents = printStatuses.length > 0 || agentChildren(turn.subAgents ?? []).some(child => Boolean(child.usage || childSessionData(child.sessionFile)?.sessionId));
        const agentTurnControls: Array<{ runId: string; y: number; width: number; line: string }> = [];
        const agents = liveAgentView(combinedSubAgents, theme, width, subExp && hasTableSubAgents, true, agentDeadlines, now, expandedSubagents, agentTurnControls, lang);
        const active = !!turn.running || agents.running > 0 || entries.some(entry => entry.state === "running") || (turn.waitingTools?.length ?? 0) > 0;
        if (entries.length || active || turn.usage || agents.total) {
          const mode = agentModes.get(index) ?? (exp ? "all" : "preview");
          const expanded = mode === "all";
          const busy = entries.some(entry => entry.state === "running") || (turn.waitingTools?.length ?? 0) > 0;
          const working = turn.running && !busy && !turn.final;
          const showAgentRows = (Boolean(agents.table) || expanded || subExp) && agents.total > 0;
          // Every child keeps its heading; process records share the remaining preview budget.
          const processLimit = Math.max(0, recLimit - (!agents.table && showAgentRows ? agents.total : 0));
          const shown = expanded ? entries : processLimit ? entries.slice(-processLimit) : [];
          const showWorking = working && (turn.awaitingResponse || expanded || (!shown.length && !agents.total));
          const sparkle = active ? Math.floor(now / 360) % 2 ? "✧" : "✦" : "✦";
          const usage = addUsage({ ...EMPTY_USAGE, ...turn.usage, cost: turn.usage?.cost ?? 0 }, turn.pendingUsage);
          const hasUsage = usage.totalTokens > 0 || usage.cacheRead > 0;
          const totals = hasUsage
            ? theme.fg("muted", copy.session) + theme.bold(theme.fg("text", formatTokens(usage.totalTokens)))
              + theme.fg("muted", copy.cache) + theme.bold(theme.fg("text", formatTokens(usage.cacheRead)))
            : "";
          const recordCount = entries.length + agents.total;
          const progressHeader = theme.fg(active ? "accent" : "muted", sparkle + " ") + theme.bold(theme.fg("text", "Agent")) + theme.fg("muted", recordCount ? ` · ${recordCount}` : "");
          const caret = theme.fg("muted", expanded ? " ▾" : " ▸");
          const elapsedHeader = turn.startedAt == null ? "" : theme.fg("muted", " · ") + theme.fg(active ? "success" : "muted", formatElapsed(turn.startedAt, turn.endedAt ?? now));
          const left = progressHeader + elapsedHeader + caret;
          const showTotals = hasUsage && usageShown && visibleWidth(left) + 2 + visibleWidth(totals) <= width;
          turnAgentControls.push({ index, y: turnLines.length + 1, width: Math.min(width, visibleWidth(left)) });
          if (expanded && pinnedAgentIndex === index) turnPinnedAgent = { index, y: turnLines.length + 1, line: truncateToWidth(left, width) };
          turnLines.push("", showTotals
            ? left + " ".repeat(width - visibleWidth(left) - visibleWidth(totals)) + totals
            : truncateToWidth(left, width));
          shown.forEach((entry, row) => {
            turnProcessRows.push({ key: entry.id || `${index}:${entry.processIndex}`, y: turnLines.length });
            const title = entry.title;
            const text = title.split(/\r?\n/).find(line => line.trim())?.replace(/\s+/g, " ").trim() ?? "";
            const split = text.indexOf(" ");
            const noThinkingBody = entry.thinking && !stripVTControlCharacters(entry.detail).trim();
            const label = split < 0 ? text : text.slice(0, split);
            const body = split < 0 ? "" : text.slice(split + 1);
            const activeThinking = !!entry.activeThinking;
            const elapsed = entry.thinking ? formatThinkingElapsed(turn, entry.processIndex, activeThinking, now) : "";
            const thinkingElapsed = elapsed ? theme.fg(activeThinking ? "success" : "muted", ` ${elapsed}`) : "";
            const call = turn.agentCalls?.find(call => call.id === entry.id && !isCapturedCall(call));
            const controlId = call?.id ?? (entry.thinking && !noThinkingBody || entry.id.startsWith("agents:") ? entry.id : "");
            const open = call ? expandedTools.has(call.id) : entry.thinking && !noThinkingBody && expandedThinking.has(entry.id);
            const identity = entry.state === "error" ? "error" : open || activeThinking ? "accent" : "text";
            const duration = call ? formatToolElapsed(call.startedAt,
              call.endedAt ?? (call.state === "running" ? now : undefined)) : "";
            const toolElapsed = duration ? theme.fg(entry.state === "error" ? "error" : call?.state === "running" ? "accent" : "muted", ` ${duration}`) : "";
            const summary = theme.fg(identity, theme.bold(label)) + thinkingElapsed + toolElapsed + " ";
            if (controlId && width >= 4) turnToolControls.push({ id: controlId, y: turnLines.length, width, title: text });
            if (hoveredTool?.id === controlId && (hoveredTool.y !== baseY + turnLines.length || hoveredTool.width !== width)) clearHover();
            const status = entry.state === "error" ? "✕" : entry.state === "running" ? runningGlyph(now) : "●";
            const arrow = !!controlId && (open || hoveredTool?.id === controlId);
            const keepStatus = entry.state === "running" || (open && entry.state === "error");
            const glyph = arrow ? (open ? "▼" : "▶") + (keepStatus ? ` ${status}` : "") : status;
            const glyphColor = entry.state === "error" ? "error" : entry.state === "running" || arrow ? "accent" : "muted";
            const last = row === shown.length - 1 && !showWorking && !agents.rows.length;
            const showGlyph = entry.state === "running" || entry.state === "error" || arrow;
            const prefix = theme.fg(open ? "accent" : "dim", "│ ") + (showGlyph ? theme.fg(glyphColor, glyph) + " " : "") + summary;
            if (label === "Output") {
              // Wrapped output hangs under the body column and keeps the tree rail to the next sibling.
              const indent = visibleWidth(prefix);
              const rail = !last && indent > 0 ? theme.fg("dim", "\u2502") + " ".repeat(indent - 1) : " ".repeat(indent);
              const wrapped = markdown(body, Math.max(1, width - indent), true);
              turnLines.push(truncateToWidth(prefix + (wrapped[0] ?? ""), width, ""));
              for (const extra of wrapped.slice(1)) turnLines.push(truncateToWidth(rail + extra, width, ""));
            } else {
              const available = Math.max(0, width - visibleWidth(prefix));
              if (entry.thinking) {
                const cached = thinkingPreviews.get(entry.id);
                const previewRows = 1;
                const reuse = cached?.source === entry.detail && cached.width === available && cached.rows === previewRows && cached.live === activeThinking;
                const display = reuse ? cached.text : thinkingPreview(entry.detail, available, previewRows, activeThinking);
                if (!reuse) thinkingPreviews.set(entry.id, { text: display, source: entry.detail, width: available, rows: previewRows, live: activeThinking });
                const outcome = turn.thinkingOutcomes?.[entry.processIndex];
                const fallbackCopy = THINKING_FALLBACK[lang];
                const fallback = activeThinking ? fallbackCopy.active
                  : outcome === "aborted" ? fallbackCopy.aborted
                  : outcome === "error" ? fallbackCopy.error : fallbackCopy.ended;
                const color = entry.state === "error" ? "error" : activeThinking ? "accent" : "muted";
                const rows = available > 0
                  ? thinkingMarkdown(display || fallback, available, color, previewRows)
                  : [];
                turnLines.push(bandHeading(truncateToWidth(prefix + (rows[0] ?? ""), width, ""), open));
                const rail = theme.fg(last ? color : "dim", last ? " " : "│") + " ".repeat(Math.max(0, visibleWidth(prefix) - 1));
                for (const extra of rows.slice(1)) turnLines.push(truncateToWidth(rail + extra, width, ""));
              } else {
                const displayBody = placeholderText(body);
                const compactBody = linkToolFiles(displayBody, renderCwd, !open);
                const fittedBody = truncateToWidth(compactBody, available, "…");
                // Always close a hyperlink before subsequent rows.
                const styledBody = theme.fg(entry.state === "error" ? "error" : open ? "accent" : "muted", fittedBody + "\x1b]8;;\x07");
                turnLines.push(bandHeading(truncateToWidth(prefix + styledBody, width, "…"), open));
              }
            }
            if (open && call && call.id === pinnedToolId) turnPinnedTool = { id: call.id, y: turnLines.length - 1, line: turnLines.at(-1)! };
            if (open && call) {
              // ponytail: saved text only; native view retains images, args and custom renderers.
              const output = stripVTControlCharacters(call.output ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
              const rail = width > 5 ? (last ? "     " : theme.fg("accent", "│    ")) : "";
              const detailWidth = Math.max(1, width - visibleWidth(rail));
              if (call.task && (/\r|\n/.test(call.task) || visibleWidth(call.task) > width - visibleWidth(prefix))) {
                const input = stripVTControlCharacters(call.task).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
                turnLines.push(...new Text(`${copy.inputLabel}\n${input}`, 0, 0).render(detailWidth).map(line => truncateToWidth(rail + theme.fg("muted", line), width, "")));
                turnLines.push(truncateToWidth(rail + theme.fg("muted", copy.outputLabel), width, ""));
              }
              const details = new Text(output || (entry.state === "running" ? copy.waitingToolResult : copy.emptyToolResult), 0, 0).render(detailWidth);
              turnLines.push(...details.map(line => truncateToWidth(rail + theme.fg(entry.state === "error" ? "error" : "muted", line), width, "")));
            } else if (open && entry.thinking) {
              const rail = width > 5 ? (last ? "     " : theme.fg("accent", "│    ")) : "";
              const detailWidth = Math.max(1, width - visibleWidth(rail));
              turnLines.push(...markdown(entry.detail, detailWidth, true).map(line => truncateToWidth(rail + line, width, "")));
            }
          });
          if (showAgentRows) {
            const agentStartY = turnLines.length;
            for (const c of agentTurnControls) {
              const control = { ...c, y: agentStartY + c.y };
              turnSubagentControls.push(control);
              if (c.runId === pinnedSubagentId) turnPinnedSubagent = { id: c.runId, y: control.y, line: c.line, autoScroll: false };
            }
            turnLines.push(...agents.rows);
          }
          if (showWorking) {
            const label = turn.awaitingResponse ? "Waiting" : "Working";
            const prefix = theme.fg("dim", "└─ ") + theme.fg("accent", `${runningGlyph(now)} `) + theme.fg("text", theme.bold(label)) + " ";
            turnLines.push(truncateToWidth(prefix + theme.fg("muted", turn.awaitingResponse ? copy.waitingModel : copy.waitingNextStep), width, ""));
          }
        }
        for (const [replyIndex, reply] of (turn.replies ?? []).entries()) turnLines.push("", ...assistantMarkdown(reply, width, `reply:${index}:${replyIndex}`));
        if (turn.final) turnLines.push("", ...assistantMarkdown(turn.final, width, `final:${index}`));
        return {
          lines: turnLines,
          promptControls: turnPromptControls,
          toolControls: turnToolControls,
          processRows: turnProcessRows,
          agentControls: turnAgentControls,
          subagentControls: turnSubagentControls,
          pinnedTool: turnPinnedTool,
          pinnedAgent: turnPinnedAgent,
          pinnedSubagent: turnPinnedSubagent,
          claimedPrintFiles,
        };
      };

      for (const [index, turn] of turns.entries()) {
        if (index > 0) lines.push("");
        const baseY = lines.length;
        if (expandedPrompts.has(index) && expandedPrompts.get(index) !== turn.question) expandedPrompts.delete(index);
        const subChildren = turn.subAgents?.length ? agentChildren(turn.subAgents) : [];
        const cheapActive = !!turn.running
          || (turn.waitingTools?.length ?? 0) > 0
          || (turn.agentCalls ?? []).some(call => !isAgentTool(call.tool ?? call.name) && call.state === "running")
          || subChildren.some(isSubAgentChildRunning);
        if (cheapActive) runningTurns.add(index);
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
        const canCache = !cheapActive && !hasFutureDeadline;
        let rendered: TurnRenderResult | undefined;
        if (canCache) {
          const key = buildTurnKey(index, turn, baseY, subChildren);
          const cached = turnCache.get(index);
          if (cached && keysEqual(cached.key, key)) {
            rendered = cached.value;
          } else {
            rendered = renderTurn(index, turn, baseY);
            turnCache.set(index, { key: buildTurnKey(index, turn, baseY, subChildren), value: rendered });
          }
        } else {
          turnCache.delete(index);
          rendered = renderTurn(index, turn, baseY);
        }
        for (const f of rendered.claimedPrintFiles) claimedPrintSessions.add(f);
        for (const c of rendered.promptControls) promptControls.push({ ...c, y: baseY + c.y });
        for (const c of rendered.toolControls) toolControls.push({ ...c, y: baseY + c.y });
        for (const r of rendered.processRows) processRows.push({ key: r.key, y: baseY + r.y });
        for (const c of rendered.agentControls) agentControls.push({ ...c, y: baseY + c.y });
        for (const c of rendered.subagentControls) subagentControls.push({ ...c, y: baseY + c.y });
        if (rendered.pinnedTool) pinnedTool = { ...rendered.pinnedTool, y: baseY + rendered.pinnedTool.y };
        if (rendered.pinnedAgent) pinnedAgent = { ...rendered.pinnedAgent, y: baseY + rendered.pinnedAgent.y };
        if (rendered.pinnedSubagent) pinnedSubagent = { ...rendered.pinnedSubagent, y: baseY + rendered.pinnedSubagent.y };
        for (const line of rendered.lines) lines.push(line);
        const noticeRows = notices?.get(index) ?? [];
        noticeRegions.push({ y: lines.length, rows: noticeRows });
        for (const line of noticeRows) lines.push(line);
      }
      if (hoveredTool && !toolControls.some(control => control.id === hoveredTool!.id)) clearHover();
      if (hoveredProcess && !processRows.some(row => row.key === hoveredProcess!.key && row.y === hoveredProcess!.y)) clearHover();
      for (const deadline of agentDeadlines.values()) if (deadline > Date.now()) agentExpiry = Math.min(agentExpiry, deadline);
      const linkedRows = linkHover.render(lines, width);
      const hovered = hoveredProcess;
      const hoveredAt = hovered && firstAtY(processRows, hovered.y);
      const hoveredRow = hoveredAt && hoveredAt.key === hovered.key ? hoveredAt : undefined;
      if (!hoveredRow) return linkedRows;
      const result = [...linkedRows];
      const line = result[hoveredRow.y];
      result[hoveredRow.y] = paintExpandedHeading(theme, line + " ".repeat(Math.max(0, width - visibleWidth(line))));
      return result;
    },
  };
}
