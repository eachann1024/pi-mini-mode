import { diagramMarkdown, isMarkdownProse, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { extractNoticeBody, supervisorNoticeBody } from "./transcript-notices.ts";
import { paintExpandedHeading } from "./minimal-theme.ts";
import { agentChildren, childSessionData, failedAgent, finishedAgent, plain, rawToolInput, stripAcceptanceReport } from "./agent-state.ts";
import type { UiLanguage } from "./settings.ts";
import { addUsage, EMPTY_USAGE, formatUsd, type UsageLike } from "./usage.ts";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
// Keep the spinner in the middle two Braille rows, with one rotation per second.
export const RUNNING_FRAMES = ["⠲", "⠴", "⠦", "⠖"];
export const runningGlyph = (now = Date.now()) => RUNNING_FRAMES[Math.floor(now / 250) % RUNNING_FRAMES.length];
export interface AgentCall {
  id: string;
  name: string;
  task: string;
  command?: string;
  tool?: string;
  action?: string;
  state: "running" | "done" | "error";
  output?: string;
  startedAt?: number;
  endedAt?: number;
}
export function agentCallDisplay(call: AgentCall): { summary: string; detail: string } {
  if (isAgentTool(call.tool ?? call.name)) return {
    summary: `${call.tool ?? call.name} · ${call.action || "dispatch"} · ${call.state === "running" ? "waiting for receipt" : call.state === "error" ? "failed" : "returned"}`,
    detail: call.output ?? call.task,
  };
  const receipt = call.output?.match(/\bAsync workflow \[([^\]\n]+)\]/);
  if (receipt) return { summary: `Workflow ${receipt[1]} · dispatched`, detail: "" };
  return {
    summary: call.state !== "error" && /^(read|write|edit|bash|grep|find|ls)$/.test(call.name) ? call.task || call.output || "" : call.output ?? call.task,
    detail: call.state === "error" ? call.output ?? "" : "",
  };
}
export const isAgentTool = (name: string) => /^(subagent(?:_supervisor)?|agents?|get_subagent_result|steer_subagent|bg_wait)$/i.test(name);
export function agentCall(id: string, tool: string, args: unknown): AgentCall {
  const data = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const name = String(data.agent ?? data.subagent_type ?? data.agent_type ?? tool);
  const command = typeof data.command === "string" ? data.command : undefined;
  return { id, name, tool, command, action: typeof data.action === "string" ? data.action : undefined, task: String(data.task ?? data.prompt ?? data.description ?? data.action ?? data.command ?? data.path ?? ""), state: "running" };
}
export function agentCallRows(calls: AgentCall[], theme: Theme, width: number, expanded: boolean,
  markdown: (text: string, width: number) => string[]): string[] {
  if (!calls.length || width < 1) return [];
  const running = calls.filter(call => call.state === "running").length;
  const errors = calls.filter(call => call.state === "error").length;
  const done = calls.length - running - errors;
  const header = `${expanded ? "⌄" : "›"} Agent calls · ${calls.length} total · ${running} running · ${done} returned${errors ? ` · ${errors} failed` : ""} · Ctrl+O`;
  const rows = [truncateToWidth(theme.fg(errors ? "error" : running ? "accent" : "muted", header), width)];
  if (expanded) calls.forEach((call, index) => {
    const color = call.state === "error" ? "error" : call.state === "done" ? "success" : "accent";
    const glyph = call.state === "error" ? "✗" : call.state === "done" ? "✓" : "●";
    rows.push(truncateToWidth(theme.fg(color, `${index === calls.length - 1 ? "└─" : "├─"} ${glyph} ${call.name}`), width));
    for (const text of [call.task, call.output]) {
      if (text) rows.push(...markdown(text, Math.max(1, width - 3)).map(row => truncateToWidth(`   ${row}`, width, "")));
    }
  });
  return rows;
}

export function agentSummary(theme: Theme, width: number, running: number, done: number, errors: number, expanded: boolean): string {
  const label = `Sub Agent · running ${running}${done ? ` · done ${done}` : ""}${errors ? ` · failed ${errors}` : ""}${done ? ` · Ctrl+S ${expanded ? "collapse" : "expand"}` : ""}`;
  const summary = truncateToWidth(theme.fg(errors ? "error" : "muted", label), width);
  return " ".repeat(Math.max(0, width - visibleWidth(summary))) + summary;
}
const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function formatAgentElapsed(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function padRightVisible(str: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  const fitted = truncateToWidth(str, targetWidth, "…");
  return fitted + " ".repeat(Math.max(0, targetWidth - visibleWidth(fitted)));
}

function padLeftVisible(str: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  const fitted = truncateToWidth(str, targetWidth, "…");
  return " ".repeat(Math.max(0, targetWidth - visibleWidth(fitted))) + fitted;
}

const TABLE_COPY = {
  zh: {
    source: "来源",
    task: "任务",
    time: "用时",
    steps: "步骤",
    input: "输入",
    output: "输出",
    cache: "缓存",
    total: "合计",
    expand: "展开",
    collapse: "收起",
    running: "运行",
    done: "完成",
    failed: "失败",
    count: (n: number) => `${n} 个`,
    session: "会话",
    turns: (n: number) => `${n} 轮`,
    cacheDetail: (r: string, w: string, m: string) => `缓存读 ${r} · 缓存写 ${w} · 未命中 ${m}`,
  },
  en: {
    source: "Source",
    task: "Task",
    time: "Time",
    steps: "Steps",
    input: "In",
    output: "Out",
    cache: "Cache",
    total: "Total",
    expand: "expand",
    collapse: "collapse",
    running: "running",
    done: "done",
    failed: "failed",
    count: (n: number) => `${n}`,
    session: "session",
    turns: (n: number) => n === 1 ? "1 turn" : `${n} turns`,
    cacheDetail: (r: string, w: string, m: string) => `cache read ${r} · cache write ${w} · miss ${m}`,
  },
} as const;

/** Retained for callers that share a render-state map across the current session. */
export type AgentDeadlines = Map<string, number>;

/** One snapshot drives both the inline count and its uncapped child rows. */
export function liveAgentView(statuses: Record<string, unknown>[], theme: Theme, width: number, expanded = false, _activeOnly = false,
  deadlines: AgentDeadlines = new Map(), now = Date.now(), expandedIds?: Set<string>,
  subagentControls?: Array<{ runId: string; y: number; width: number; line: string }>,
  lang: UiLanguage = "zh") {
  // Live and session-persisted snapshots share the same lifecycle and details.
  const all = agentChildren(statuses);
  const errors = all.filter(failedAgent).length;
  const done = all.filter(child => !failedAgent(child) && finishedAgent(child.status ?? child.state)).length;
  const running = all.length - done - errors;
  const rows: string[] = [];
  const text = (value: unknown) => typeof value === "string" ? plain(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ") : "";
  const bodyText = (value: unknown) => typeof value === "string"
    ? stripAcceptanceReport(plain(value).replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, " ")).trim() : "";
  const renderBody = (source: string, available: number) => {
    const width = Math.max(1, available);
    if (isMarkdownProse(source)) return renderMinimalMarkdown(source, width, getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "",
      { color: value => theme.fg("muted", value) }, diagramMarkdown);
    // Wrap by visible columns. Do not re-slice truncateToWidth: it appends a
    // reset, so slice(row.length) would drop source characters on every wrap.
    return wrapTextWithAnsi(source, width).map(row => theme.fg("muted", row));
  };

  const hasTableData = all.some(child => {
    if (child.source === "pi -p" || child.agent === "pi -p" || child.usage) return true;
    const session = childSessionData(child.sessionFile);
    return Boolean(session?.sessionId || (session?.usage.totalTokens ?? 0) > 0);
  });

  const copy = TABLE_COPY[lang] ?? TABLE_COPY.zh;
  const gap = "  ";
  const prefixWidth = 3;
  const sourceWidth = Math.max(
    visibleWidth(copy.source),
    visibleWidth(copy.total),
    ...all.map(child => (child.source === "pi -p" || child.agent === "pi -p" ? 5 : 8)),
  );
  const timeWidth = 5;
  const stepsWidth = 5;
  const inputWidth = 7;
  const outputWidth = 7;
  const cacheWidth = 5;
  const baseFixed = prefixWidth + 2 + sourceWidth + 2 + timeWidth + 2;
  const minTaskForOptional = 18;
  const minTaskFallback = 12;
  const useTable = width > 0 && all.length > 0 && hasTableData && width >= baseFixed + minTaskFallback;

  const fullWidth = width;
  if (useTable) {
    // Rows sit on the Agent tree rail, like process records above them.
    const railPrefix = theme.fg("dim", "│ ");
    const width = Math.max(1, fullWidth - visibleWidth(railPrefix));
    // Hide optional columns in order: Cache -> Out -> Steps -> In
    let showInput = false;
    let showSteps = false;
    let showOutput = false;
    let showCache = false;
    if (width >= baseFixed + (2 + stepsWidth) + (2 + inputWidth) + (2 + outputWidth) + (2 + cacheWidth) + minTaskForOptional) {
      showInput = true; showSteps = true; showOutput = true; showCache = true;
    } else if (width >= baseFixed + (2 + stepsWidth) + (2 + inputWidth) + (2 + outputWidth) + minTaskForOptional) {
      showInput = true; showSteps = true; showOutput = true;
    } else if (width >= baseFixed + (2 + stepsWidth) + (2 + inputWidth) + minTaskForOptional) {
      showInput = true; showSteps = true;
    } else if (width >= baseFixed + (2 + inputWidth) + minTaskForOptional) {
      showInput = true;
    }
    const optionalWidth = (showSteps ? 2 + stepsWidth : 0)
      + (showInput ? 2 + inputWidth : 0)
      + (showOutput ? 2 + outputWidth : 0)
      + (showCache ? 2 + cacheWidth : 0);
    // Keep numbers next to the task instead of pinning them to the far edge.
    const taskWidth = Math.max(minTaskFallback, Math.min(56, width - baseFixed - optionalWidth));
    const leftWidth = prefixWidth + 2 + sourceWidth + 2 + taskWidth;

    const anyExpanded = expanded || all.some(child => expandedIds?.has(String(child.runId ?? child.displayId)));
    const statusParts = [
      running ? `${copy.running} ${running}` : "",
      done ? `${copy.done} ${done}` : "",
      errors ? `${copy.failed} ${errors}` : "",
    ].filter(Boolean);
    const titleLabel = `Sub Agent · ${copy.count(all.length)}${statusParts.length ? ` · ${statusParts.join(" · ")}` : ""} · Ctrl+S ${anyExpanded ? copy.collapse : copy.expand}`;
    const titleFits = visibleWidth(titleLabel) <= leftWidth;
    if (!titleFits) rows.push(theme.fg(errors ? "error" : "muted", truncateToWidth(titleLabel, width, "…")));
    const headerCells = [
      titleFits ? theme.fg(errors ? "error" : "muted", padRightVisible(titleLabel, leftWidth)) : " ".repeat(leftWidth),
      padLeftVisible(copy.time, timeWidth),
      ...(showSteps ? [padLeftVisible(copy.steps, stepsWidth)] : []),
      ...(showInput ? [padLeftVisible(copy.input, inputWidth)] : []),
      ...(showOutput ? [padLeftVisible(copy.output, outputWidth)] : []),
      ...(showCache ? [padLeftVisible(copy.cache, cacheWidth)] : []),
    ];
    const headerRow = headerCells[0] + gap + theme.fg("dim", headerCells.slice(1).join(gap));
    rows.push(headerRow + " ".repeat(Math.max(0, width - visibleWidth(headerRow))));

    let totalSteps = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let anyUsage = false;
    const rawSids = all.map(child => {
      const s = childSessionData(child.sessionFile);
      return s?.sessionId || text(child.sessionId) || String(child.runId ?? child.displayId);
    });
    const sidPrefixCounts = new Map<string, number>();
    for (const id of rawSids) {
      const p = id.slice(0, 8);
      sidPrefixCounts.set(p, (sidPrefixCounts.get(p) ?? 0) + 1);
    }

    all.forEach((child, childIndex) => {
      const runKey = String(child.runId ?? child.displayId);
      const isChildExpanded = expanded || (expandedIds?.has(runKey) ?? false);
      const notice = child.notice as { summary?: string; state?: string; color?: "error" | "warning" | "muted"; alert?: boolean; internal?: boolean } | undefined;
      const session = childSessionData(child.sessionFile);
      const rawModel = text(child.model) || session?.model || "";
      const modelShort = rawModel.split("/").at(-1) || "";
      const suffix = modelShort.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
      const cleanModel = (suffix ? modelShort.slice(0, -suffix[0].length) : modelShort) || "?";
      const level = text(child.thinking) || suffix?.[1] || session?.thinking || "off";
      const tools = Array.isArray(child.recentTools) ? child.recentTools.filter(tool => tool && typeof tool === "object") : [];
      const latest = tools.at(-1);
      const latestArgs = rawToolInput(child.sessionFile, latest?.tool, text(latest?.args));
      const currentAction = [text(child.currentTool), text(child.currentPath || child.currentToolArgs)].filter(Boolean).join(" ")
        || [text(latest?.tool), latestArgs].filter(Boolean).join(" ");
      const taskPrompt = text(child.task || child.description);
      const state = text(child.status ?? child.state) || "waiting";
      const terminal = failedAgent(child) || finishedAgent(state);
      const isRunning = /^(running|active|starting|queued|pending)$/.test(state);
      const rawTaskText = failedAgent(child)
        ? (notice?.summary || text(child.error) || taskPrompt || currentAction || state)
        : terminal
          ? (taskPrompt || notice?.summary || currentAction || state)
          : (notice?.summary || currentAction || taskPrompt || state);
      const taskDisplay = (!terminal && (latest || child.currentTool))
        ? text(rawTaskText)
        : text(renderMinimalMarkdown(rawTaskText, Math.max(1, visibleWidth(rawTaskText) + 1), getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "", undefined, diagramMarkdown).join(" "));

      const glyph = failedAgent(child) || notice?.color === "error" ? "×"
        : notice?.color === "warning" ? "⚠"
        : finishedAgent(state) ? "✓"
        : isRunning ? runningGlyph(now) : "●";
      const glyphColor = failedAgent(child) || notice?.color === "error" ? "error"
        : notice?.color === "warning" ? "warning"
        : isRunning && !terminal ? "accent" : "muted";

      const elapsedKey = `elapsed:${runKey}`;
      const startedAt = timestamp(child.startedAt) ?? session?.startedAt ?? deadlines.get(elapsedKey) ?? now;
      if (!timestamp(child.startedAt) && !session?.startedAt) deadlines.set(elapsedKey, startedAt);
      const endedAt = terminal ? timestamp(child.endedAt) ?? session?.endedAt ?? deadlines.get(`${elapsedKey}:ended`) ?? now : now;
      if (terminal) deadlines.set(`${elapsedKey}:ended`, endedAt);
      const elapsed = formatAgentElapsed(startedAt, endedAt);

      const fallbackToolCount = typeof child.toolCount === "number" && Number.isFinite(child.toolCount) ? child.toolCount : 0;
      const stepCount = session?.steps.length ? session.steps.length : Math.max(tools.length, fallbackToolCount);
      const usage = session && (session.usage.totalTokens > 0 || !child.usage)
        ? session.usage
        : (child.usage ? addUsage(EMPTY_USAGE, child.usage as UsageLike) : EMPTY_USAGE);
      const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      const outputTokens = usage.output;
      const hasUsage = inputTokens > 0 || outputTokens > 0;
      totalSteps += stepCount;
      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCacheRead += usage.cacheRead;
      anyUsage ||= hasUsage;

      const inputStr = hasUsage ? formatCompactTokens(inputTokens) : "–";
      const outputStr = hasUsage ? formatCompactTokens(outputTokens) : "–";
      const cacheStr = inputTokens > 0 ? `${Math.round((100 * usage.cacheRead) / inputTokens)}%` : "–";

      const isPrint = child.source === "pi -p" || child.agent === "pi -p";
      const sourceLabel = isPrint ? "pi -p" : "SubAgent";
      const fgMain = isChildExpanded ? "accent" : "text";
      const fgTask = failedAgent(child) ? "error" : isChildExpanded ? "accent" : "muted";
      const fgTime = isChildExpanded ? "accent" : terminal ? "muted" : "success";

      const prefixCell = isChildExpanded
        ? theme.fg("accent", padRightVisible(`⌄ ${glyph}`, prefixWidth))
        : theme.fg(isRunning && !terminal ? "accent" : "muted", "› ") + theme.fg(glyphColor, glyph);
      const cells = [
        prefixCell,
        theme.fg(fgMain, theme.bold(padRightVisible(sourceLabel, sourceWidth))),
        theme.fg(fgTask, padRightVisible(taskDisplay, taskWidth)),
        theme.fg(fgTime, padLeftVisible(elapsed, timeWidth)),
        ...(showSteps ? [theme.fg(fgMain, padLeftVisible(String(stepCount), stepsWidth))] : []),
        ...(showInput ? [theme.fg(fgMain, padLeftVisible(inputStr, inputWidth))] : []),
        ...(showOutput ? [theme.fg(fgMain, padLeftVisible(outputStr, outputWidth))] : []),
        ...(showCache ? [theme.fg(fgMain, padLeftVisible(cacheStr, cacheWidth))] : []),
      ];
      const joined = cells.join(gap);
      const padded = joined + " ".repeat(Math.max(0, width - visibleWidth(joined)));
      const line = isChildExpanded ? paintExpandedHeading(theme, padded) : padded;
      subagentControls?.push({ runId: runKey, y: rows.length, width: fullWidth, line: railPrefix + line });
      rows.push(line);

      if (isChildExpanded) {
        const rail = theme.fg("accent", "│") + "  ";
        const tableWidth = leftWidth + 2 + timeWidth + optionalWidth;
        const innerWidth = Math.max(1, Math.min(width, tableWidth) - visibleWidth(rail));
        const rawSid = rawSids[childIndex] ?? runKey;
        const sid = (sidPrefixCounts.get(rawSid.slice(0, 8)) ?? 0) > 1 && rawSid.length >= 13
          ? rawSid.slice(0, 13)
          : rawSid.slice(0, 8);
        const turnsCount = session?.turns ?? 0;
        const metaLine = `${cleanModel} · ${level} · ${copy.session} ${sid} · ${copy.turns(turnsCount)} · ${formatUsd(usage.cost)}`;
        const metaRow = rail + theme.fg("dim", truncateToWidth(metaLine, innerWidth, "…"));
        rows.push(metaRow + " ".repeat(Math.max(0, width - visibleWidth(metaRow))));

        const stepItems = (session?.steps.length
          ? session.steps
          : tools.map(tool => ({
              at: timestamp(tool.endMs) ?? startedAt,
              name: text(tool.tool) || "tool",
              value: rawToolInput(child.sessionFile, tool.tool, text(tool.args)),
              input: 0,
            }))).slice(-8);
        const stepBase = session?.startedAt ?? startedAt;
        const stepToolWidth = Math.max(6, ...stepItems.map(s => Math.min(12, visibleWidth(s.name))));
        for (const step of stepItems) {
          const relTime = padRightVisible(formatAgentElapsed(stepBase, step.at >= stepBase ? step.at : stepBase), 5);
          const toolCol = padRightVisible(step.name, stepToolWidth);
          const inText = step.input > 0 ? padLeftVisible(`↑${formatCompactTokens(step.input)}`, 8) : "";
          const argWidth = Math.max(1, innerWidth - 5 - 2 - stepToolWidth - 2 - (inText ? 10 : 0));
          const argCol = padRightVisible(step.value, argWidth);
          const stepRow = rail
            + theme.fg("dim", relTime) + "  "
            + theme.fg("text", theme.bold(toolCol)) + "  "
            + theme.fg("muted", argCol)
            + (inText ? "  " + theme.fg("dim", inText) : "");
          rows.push(stepRow + " ".repeat(Math.max(0, width - visibleWidth(stepRow))));
        }

        const messages = Array.isArray(child.noticeMessages) ? child.noticeMessages : [];
        const bodies: string[] = [];
        let latestProgress = "";
        for (const msg of messages) {
          const item = msg && typeof msg === "object" ? msg as Record<string, unknown> : undefined;
          const details = item?.details && typeof item.details === "object" ? item.details as Record<string, unknown> : undefined;
          if (item?.customType === "subagent_supervisor_request" && details?.reason === "progress_update") {
            const progress = extractNoticeBody(msg);
            if (progress) latestProgress = progress;
            continue;
          }
          const b = supervisorNoticeBody(msg);
          if (b && !bodies.includes(b)) bodies.push(b);
        }
        if (!bodies.length && latestProgress) bodies.push(latestProgress);
        const latestText = bodyText(session?.latestText);
        if (!terminal && latestText && !bodies.length) bodies.push(latestText);
        const finalOutput = terminal ? bodyText(session?.finalOutput || latestText || child.finalOutput) : "";
        if (finalOutput && !bodies.includes(finalOutput)) bodies.push(finalOutput);
        const error = bodyText(child.error);
        if (error && !bodies.includes(error)) bodies.push(error);

        for (const [bodyIdx, textBody] of bodies.entries()) {
          if (stepItems.length > 0 || bodyIdx > 0) {
            rows.push(rail + " ".repeat(Math.max(0, width - visibleWidth(rail))));
          }
          for (const mdLine of renderBody(textBody, innerWidth)) {
            const fullMd = truncateToWidth(`${rail}${mdLine}`, width);
            rows.push(fullMd + " ".repeat(Math.max(0, width - visibleWidth(fullMd))));
          }
        }

        const cacheFooter = copy.cacheDetail(
          formatCompactTokens(usage.cacheRead),
          formatCompactTokens(usage.cacheWrite),
          formatCompactTokens(usage.input),
        );
        const cacheRow = rail + theme.fg("dim", truncateToWidth(cacheFooter, innerWidth, "…"));
        rows.push(cacheRow + " ".repeat(Math.max(0, width - visibleWidth(cacheRow))));
      }
    });

    const totalInputStr = anyUsage ? formatCompactTokens(totalInput) : "–";
    const totalOutputStr = anyUsage ? formatCompactTokens(totalOutput) : "–";
    const totalCacheStr = totalInput > 0 ? `${Math.round((100 * totalCacheRead) / totalInput)}%` : "–";
    const totalCells = [
      " ".repeat(prefixWidth),
      padRightVisible(copy.total, sourceWidth),
      " ".repeat(taskWidth),
      " ".repeat(timeWidth),
      ...(showSteps ? [padLeftVisible(String(totalSteps), stepsWidth)] : []),
      ...(showInput ? [padLeftVisible(totalInputStr, inputWidth)] : []),
      ...(showOutput ? [padLeftVisible(totalOutputStr, outputWidth)] : []),
      ...(showCache ? [padLeftVisible(totalCacheStr, cacheWidth)] : []),
    ];
    const totalRow = theme.fg("muted", totalCells.join(gap));
    if (all.length > 1) rows.push(totalRow + " ".repeat(Math.max(0, width - visibleWidth(totalRow))));

    return { rows: rows.map(row => railPrefix + row), total: all.length, done, errors, running, table: true };
  }

  if (width > 0) all.forEach((child, index) => {
    const runKey = String(child.runId ?? child.displayId);
    const isChildExpanded = expanded || (expandedIds?.has(runKey) ?? false);
    const notice = child.notice as { summary?: string; state?: string; color?: "error" | "warning" | "muted"; alert?: boolean; internal?: boolean } | undefined;
    const session = childSessionData(child.sessionFile);
    const model = (text(child.model) || session?.model || "").split("/").at(-1) || "";
    const suffix = model.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
    const level = text(child.thinking) || suffix?.[1] || session?.thinking || "?";
    const tools = Array.isArray(child.recentTools) ? child.recentTools.filter(tool => tool && typeof tool === "object") : [];
    const latest = tools.at(-1);
    const latestArgs = rawToolInput(child.sessionFile, latest?.tool, text(latest?.args));
    const activity = notice?.summary
      || text(child.error)
      || [text(child.currentTool), text(child.currentPath || child.currentToolArgs)].filter(Boolean).join(" ")
      || [text(latest?.tool), latestArgs].filter(Boolean).join(" ")
      || text(child.task || child.description) || text(child.status ?? child.state) || "waiting";
    // Tool inputs are literal code, not Markdown (heredocs can contain HTML-like text).
    const body = latest || child.currentTool ? text(activity) : text(renderMinimalMarkdown(activity, Math.max(1, visibleWidth(activity) + 1), getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "", undefined, diagramMarkdown).join(" "));
    const state = text(child.status ?? child.state) || "waiting";
    const terminal = failedAgent(child) || finishedAgent(state);
    const isRunning = /^(running|active|starting|queued|pending)$/.test(state);
    const glyph = failedAgent(child) || notice?.color === "error" ? "×"
      : notice?.color === "warning" ? "⚠"
      : finishedAgent(state) ? "✓"
      : isRunning ? runningGlyph(now) : "●";
    const color = "text";
    // Status snapshots, not the dispatch tool receipt, define a child run's lifecycle.
    // Preserve a terminal observation when an older pi-subagents status omits endedAt.
    const elapsedKey = `elapsed:${runKey}`;
    const startedAt = timestamp(child.startedAt) ?? session?.startedAt ?? deadlines.get(elapsedKey) ?? now;
    if (!timestamp(child.startedAt) && !session?.startedAt) deadlines.set(elapsedKey, startedAt);
    const endedAt = terminal ? timestamp(child.endedAt) ?? session?.endedAt ?? deadlines.get(`${elapsedKey}:ended`) ?? now : now;
    if (terminal) deadlines.set(`${elapsedKey}:ended`, endedAt);
    const elapsed = formatAgentElapsed(startedAt, endedAt);
    const identity = isChildExpanded ? "accent" : color;
    const labelName = child.source === "pi -p" || child.agent === "pi -p" ? "pi -p" : "SubAgent";
    const heading = truncateToWidth(theme.fg(isChildExpanded ? "accent" : "dim", `${index === all.length - 1 ? "└─" : "├─"} `)
      + theme.fg(failedAgent(child) || notice?.color === "error" ? "error" : notice?.color === "warning" ? "warning" : isRunning && !terminal ? "accent" : "muted", `${glyph} `)
      + theme.fg(identity, theme.bold(labelName))
      + theme.fg(identity, ` • ${suffix ? model.slice(0, -suffix[0].length) : model}`)
      + (level ? theme.fg("muted", ` ${level}`) : "") + theme.fg(terminal ? "muted" : "success", ` ${elapsed}`) + theme.fg(identity, " : "), width, "…");
    const bodyBudget = Math.max(0, width - visibleWidth(heading));
    const progress = !bodyBudget ? "" : truncateToWidth(body, bodyBudget, "…");
    const row = heading + theme.fg(isChildExpanded ? "accent" : "muted", progress);
    const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
    const line = isChildExpanded ? paintExpandedHeading(theme, padded) : padded;
    subagentControls?.push({ runId: runKey, y: rows.length, width, line });
    rows.push(line);
    if (isChildExpanded) {
      const rail = theme.fg("accent", "│") + "  ";
      let processShown = false;
      if (!terminal) {
        const process: Array<{ name: string; args: string }> = tools.slice(-6).map(tool => ({
          name: text(tool.tool) || "tool",
          args: rawToolInput(child.sessionFile, tool.tool, text(tool.args)),
        }));
        if (!process.length && child.currentTool) {
          process.push({ name: text(child.currentTool), args: text(child.currentPath || child.currentToolArgs) });
        }
        for (const item of process) {
          const prefix = `${rail}${theme.fg("muted", "●")} ${theme.fg("text", theme.bold(item.name))}${item.args ? " " : ""}`;
          rows.push(truncateToWidth(prefix + (item.args ? theme.fg("muted", item.args) : ""), width, "…"));
          processShown = true;
        }
      }
      const messages = Array.isArray(child.noticeMessages) ? child.noticeMessages : [];
      const bodies: string[] = [];
      let latestProgress = "";
      for (const msg of messages) {
        const item = msg && typeof msg === "object" ? msg as Record<string, unknown> : undefined;
        const details = item?.details && typeof item.details === "object" ? item.details as Record<string, unknown> : undefined;
        if (item?.customType === "subagent_supervisor_request" && details?.reason === "progress_update") {
          const progress = extractNoticeBody(msg);
          if (progress) latestProgress = progress;
          continue;
        }
        const b = supervisorNoticeBody(msg);
        if (b && !bodies.includes(b)) bodies.push(b);
      }
      if (!bodies.length && latestProgress) bodies.push(latestProgress);
      const latestText = bodyText(session?.latestText);
      if (!terminal && latestText && !bodies.length) bodies.push(latestText);
      // A stopped answer outranks the running narration; the narration still
      // covers a child that ended between turns or without a stopped reply.
      const finalOutput = terminal ? bodyText(session?.finalOutput || latestText || child.finalOutput) : "";
      if (finalOutput && !bodies.includes(finalOutput)) bodies.push(finalOutput);
      const error = bodyText(child.error);
      if (error && !bodies.includes(error)) bodies.push(error);
      if (!terminal && !processShown && !bodies.length) {
        rows.push(truncateToWidth(`${rail}${theme.fg("muted", "●")} ${theme.fg("text", theme.bold(text(state)))}`, width, "…"));
        processShown = true;
      }
      for (const [index, textBody] of bodies.entries()) {
        // Child/supervisor bodies are Markdown prose; tool logs and JSON are
        // not placed in this semantic body channel.
        if (processShown || index > 0) rows.push(truncateToWidth(rail, width, ""));
        for (const line of renderBody(textBody, Math.max(1, width - 3))) {
          rows.push(truncateToWidth(`${rail}${line}`, width));
        }
      }
    }
  });
  return { rows, total: all.length, done, errors, running };
}

export function liveAgentRows(statuses: Record<string, unknown>[], theme: Theme, width: number, expanded = false, deadlines: AgentDeadlines = new Map(), lang: UiLanguage = "zh"): string[] {
  const view = liveAgentView(statuses, theme, width, expanded, false, deadlines, Date.now(), undefined, undefined, lang);
  if (!width || !view.total) return [];
  return view.table ? view.rows : [agentSummary(theme, width, view.running, view.done, view.errors, expanded), ...view.rows];
}
