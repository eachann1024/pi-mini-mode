import { diagramMarkdown, isMarkdownProse, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { extractNoticeBody, supervisorNoticeBody } from "./transcript-notices.ts";
import { paintExpandedHeading } from "./minimal-theme.ts";
import { agentChildren, childSessionData, failedAgent, finishedAgent, plain, rawToolInput, stripAcceptanceReport } from "./agent-state.ts";
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
  return { id, name, tool, action: typeof data.action === "string" ? data.action : undefined, task: String(data.task ?? data.prompt ?? data.description ?? data.action ?? data.command ?? data.path ?? ""), state: "running" };
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

/** Retained for callers that share a render-state map across the current session. */
export type AgentDeadlines = Map<string, number>;

/** One snapshot drives both the inline count and its uncapped child rows. */
export function liveAgentView(statuses: Record<string, unknown>[], theme: Theme, width: number, expanded = false, _activeOnly = false,
  deadlines: AgentDeadlines = new Map(), now = Date.now(), expandedIds?: Set<string>,
  subagentControls?: Array<{ runId: string; y: number; width: number; line: string }>) {
  // Live and session-persisted snapshots share the same lifecycle and details.
  const all = agentChildren(statuses);
  const errors = all.filter(failedAgent).length;
  const done = all.filter(child => !failedAgent(child) && finishedAgent(child.status ?? child.state)).length;
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
  if (width > 0) all.forEach((child, index) => {
    const runKey = String(child.runId ?? child.displayId);
    const isChildExpanded = expanded || (expandedIds?.has(runKey) ?? false);
    const notice = child.notice as { summary?: string; state?: string; color?: "error" | "warning" | "muted"; alert?: boolean; internal?: boolean } | undefined;
    const model = text(child.model).split("/").at(-1) || "";
    const suffix = model.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
    const level = text(child.thinking) || suffix?.[1] || childSessionData(child.sessionFile)?.thinking || "?";
    const tools = Array.isArray(child.recentTools) ? child.recentTools.filter(tool => tool && typeof tool === "object") : [];
    const latest = tools.at(-1);
    const latestArgs = rawToolInput(child.sessionFile, latest?.tool, text(latest?.args));
    const activity = notice?.summary
      || text(child.error)
      || [text(child.currentTool), text(child.currentPath || child.currentToolArgs)].filter(Boolean).join(" ")
      || [text(latest?.tool), latestArgs].filter(Boolean).join(" ")
      || text(child.description) || text(child.status ?? child.state) || "waiting";
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
    const startedAt = timestamp(child.startedAt) ?? deadlines.get(elapsedKey) ?? now;
    if (!timestamp(child.startedAt)) deadlines.set(elapsedKey, startedAt);
    const endedAt = terminal ? timestamp(child.endedAt) ?? deadlines.get(`${elapsedKey}:ended`) ?? now : now;
    if (terminal) deadlines.set(`${elapsedKey}:ended`, endedAt);
    const elapsed = formatAgentElapsed(startedAt, endedAt);
    const identity = isChildExpanded ? "accent" : color;
    const heading = truncateToWidth(theme.fg(isChildExpanded ? "accent" : "dim", `${index === all.length - 1 ? "└─" : "├─"} `)
      + theme.fg(failedAgent(child) || notice?.color === "error" ? "error" : notice?.color === "warning" ? "warning" : isRunning && !terminal ? "accent" : "muted", `${glyph} `)
      + theme.fg(identity, theme.bold("SubAgent"))
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
      const session = childSessionData(child.sessionFile);
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
  return { rows, total: all.length, done, errors, running: all.length - done - errors };
}

export function liveAgentRows(statuses: Record<string, unknown>[], theme: Theme, width: number, expanded = false, deadlines: AgentDeadlines = new Map()): string[] {
  const view = liveAgentView(statuses, theme, width, expanded, false, deadlines);
  return width > 0 && view.total ? [agentSummary(theme, width, view.running, view.done, view.errors, expanded), ...view.rows] : [];
}
