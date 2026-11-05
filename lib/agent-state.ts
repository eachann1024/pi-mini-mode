import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { addUsage, EMPTY_USAGE, finiteNumber, type SessionUsage, type UsageLike } from "./usage.ts";

export const plain = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();

/** Child gate JSON is for the runtime, not the transcript. */
export function stripAcceptanceReport(output: string): string {
  return output
    .replace(/\n?```acceptance[-_]report\s*\n[\s\S]*?```\s*$/i, "")
    .replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
    .trimEnd();
}

export interface ChildSessionStep {
  at: number;
  name: string;
  value: string;
  input: number;
}

export interface ChildSessionInfo {
  stamp: string;
  sessionId: string;
  model: string;
  thinking: string;
  finalOutput: string;
  latestText: string;
  inputs: Array<{ name: string; value: string }>;
  usage: SessionUsage;
  turns: number;
  steps: ChildSessionStep[];
  startedAt?: number;
  endedAt?: number;
  terminalState?: "complete" | "failed";
}

function entryTimestampMs(entry: { timestamp?: unknown }, message?: { timestamp?: unknown }): number | undefined {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  return undefined;
}

/** Recover the child's own prose and raw tool inputs from its session, never from activity previews. */
const childSessionCache = new Map<string, ChildSessionInfo>();
const singleLine = (value: string) => plain(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ");
export function childSessionData(sessionFile: unknown): ChildSessionInfo | undefined {
  if (typeof sessionFile !== "string") return undefined;
  try {
    const stat = statSync(sessionFile);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    let cached = childSessionCache.get(sessionFile);
    if (!cached || cached.stamp !== stamp) {
      const inputs: Array<{ name: string; value: string }> = [];
      const steps: ChildSessionStep[] = [];
      let sessionId = "";
      let model = "";
      let thinking = "";
      let finalOutput = "";
      let latestText = "";
      let usage: SessionUsage = { ...EMPTY_USAGE };
      let turns = 0;
      let startedAt: number | undefined;
      let endedAt: number | undefined;
      let terminalState: "complete" | "failed" | undefined;
      for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            id?: string;
            timestamp?: unknown;
            provider?: string;
            modelId?: string;
            thinkingLevel?: string;
            usage?: UsageLike;
            message?: {
              role?: string;
              provider?: string;
              model?: string;
              thinkingLevel?: string;
              timestamp?: unknown;
              usage?: UsageLike;
              stopReason?: string;
              channel?: string;
              content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> } | null>;
            };
          };
          const entryAt = entryTimestampMs(entry, entry.message);
          if (entryAt !== undefined) {
            startedAt ??= entryAt;
            endedAt = Math.max(endedAt ?? entryAt, entryAt);
          }
          if (entry.type === "session" && typeof entry.id === "string") sessionId = entry.id;
          if (entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId) {
            model = typeof entry.provider === "string" && entry.provider && !entry.modelId.startsWith(`${entry.provider}/`)
              ? `${entry.provider}/${entry.modelId}` : entry.modelId;
          }
          if (entry.type === "thinking_level_change" && /^(off|minimal|low|medium|high|xhigh|max)$/.test(entry.thinkingLevel ?? "")) thinking = entry.thinkingLevel!;
          if (entry.type === "usage") usage = addUsage(usage, (entry.usage ?? entry) as UsageLike);
          if (entry.message?.role === "user") {
            terminalState = undefined;
            continue;
          }
          if (entry.message?.role === "toolResult") {
            terminalState = undefined;
            if (entry.message.usage) usage = addUsage(usage, entry.message.usage);
            continue;
          }
          if (entry.message?.role !== "assistant") continue;
          const message = entry.message;
          turns++;
          usage = addUsage(usage, message.usage);
          if (typeof message.model === "string" && message.model) {
            model = typeof message.provider === "string" && message.provider && !message.model.startsWith(`${message.provider}/`)
              ? `${message.provider}/${message.model}` : message.model;
          }
          if (!thinking && typeof message.thinkingLevel === "string" && /^(off|minimal|low|medium|high|xhigh|max)$/.test(message.thinkingLevel)) {
            thinking = message.thinkingLevel;
          }
          const msgInput = Math.max(0, (finiteNumber(message.usage?.input) ?? 0) + (finiteNumber(message.usage?.cacheRead) ?? 0) + (finiteNumber(message.usage?.cacheWrite) ?? 0));
          const stepAt = entryAt ?? startedAt ?? stat.mtimeMs;
          const content = Array.isArray(message.content) ? message.content : [];
          const hasToolCall = content.some(block => block?.type === "toolCall");
          const text = content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block!.text).join("\n\n").trim();
          // Pi persists no channel: only a stopped assistant text reply is a final answer.
          finalOutput = entry.type === "message" && message.stopReason === "stop"
            && (message.channel === undefined || message.channel === "final")
            && !hasToolCall
            ? text : "";
          terminalState = !hasToolCall && message.stopReason === "stop" ? "complete"
            : /^(error|aborted)$/.test(message.stopReason ?? "") ? "failed"
            : undefined;
          // Narration attached to a tool call is still the child's own prose; it
          // is the only body a running or tool-ended child has.
          if (entry.type === "message" && text) latestText = text;
          let turnInputAssigned = false;
          for (const call of content) {
            if (!call) continue;
            if (call.type !== "toolCall" || typeof call.name !== "string") continue;
            const input = call.arguments ?? call.input ?? {};
            const value = [input.path, input.command, input.pattern, input.query, input.task, input.prompt]
              .find((candidate): candidate is string => typeof candidate === "string") ?? "";
            const cleanValue = value ? singleLine(value) : "";
            if (cleanValue) inputs.push({ name: call.name, value: cleanValue });
            const stepVal = call.name === "grep" && typeof input.pattern === "string" && typeof input.path === "string"
              ? `${singleLine(input.pattern)} ${singleLine(input.path)}`
              : cleanValue;
            steps.push({ at: stepAt, name: call.name, value: stepVal, input: turnInputAssigned ? 0 : msgInput });
            turnInputAssigned = true;
          }
        } catch { /* A concurrently written session can end with a partial line. */ }
      }
      cached = { stamp, sessionId, model, thinking, finalOutput, latestText, inputs, usage, turns, steps, startedAt, endedAt, terminalState };
      childSessionCache.set(sessionFile, cached);
    }
    return cached;
  } catch { return undefined; }
}
export function rawToolInput(sessionFile: unknown, tool: unknown, preview: string): string {
  if (typeof tool !== "string" || !preview.endsWith("...")) return preview;
  const prefix = singleLine(preview.slice(0, -3));
  return [...(childSessionData(sessionFile)?.inputs ?? [])].reverse().find(input => input.name === tool && input.value.startsWith(prefix))?.value ?? preview;
}

export const finishedAgent = (state: unknown) => /^(complete|completed|done|success|succeeded)$/.test(String(state));
export const failedAgent = (node: Record<string, unknown>) => !!node.error || /^(failed|error|stopped|rejected|cancelled|canceled|aborted)$/.test(String(node.status ?? node.state));

export const AGENT_STATUS_ENTRY = "pi-mini-mode-agent-status";

export function savedAgentStatuses(entries: unknown[]): Record<string, unknown>[] {
  const saved = new Map<string, Record<string, unknown>>();
  for (const value of entries) {
    const entry = value as { type?: string; customType?: string; data?: Record<string, unknown> } | null;
    if (entry?.type === "custom" && entry.customType === AGENT_STATUS_ENTRY
      && entry.data && typeof entry.data.runId === "string") saved.set(entry.data.runId, entry.data);
  }
  return [...saved.values()];
}

/** Keep observed snapshots even after the producer cleans its temporary directory. */
export function retainAgentStatuses(previous: Record<string, unknown>[], current: Record<string, unknown>[]): Record<string, unknown>[] {
  const retained = new Map(previous.map(status => [String(status.runId), status]));
  for (const status of new Map([...previous, ...current].map(status => [String(status.runId), status])).values()) {
    const saved = retained.get(String(status.runId));
    const children = agentChildren([status]);
    const previousChildren = saved && saved !== status ? agentChildren([saved]) : saved ? children : undefined;
    const merged = children.map(child => {
      const previous = previousChildren?.find(item => item.displayId === child.displayId);
      const sameAttempt = previous?.sessionFile === child.sessionFile && previous?.startedAt === child.startedAt;
      const finalOutput = childSessionData(child.sessionFile)?.finalOutput ?? child.finalOutput ?? (sameAttempt ? previous?.finalOutput : undefined);
      return { ...child, finalOutput, notice: child.notice ?? previous?.notice, noticeMessages: child.noticeMessages ?? previous?.noticeMessages };
    });
    retained.set(String(status.runId), merged.length
      ? { ...status, steps: merged, workflowChildren: undefined, children: undefined } : status);
  }
  return [...retained.values()];
}

// ponytail: pi-subagents status.json adapter; replace with an uncapped public snapshot API when available.
export function readAgentStatuses(sessionId: string, root = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()
  ? resolve(process.env.PI_SUBAGENTS_TEMP_ROOT) : join(tmpdir(), `pi-subagents-uid-${process.getuid?.()}`), previous: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!sessionId) return [];
  const directory = join(root, "async-subagent-runs");
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return [];
      try {
        const status = JSON.parse(readFileSync(join(directory, entry.name, "status.json"), "utf8"));
        return status && status.sessionId === sessionId ? [status] : [];
      } catch {
        // Retain the last valid snapshot during replacement; never flash an empty panel.
        return previous.filter(status => status.sessionId === sessionId && status.runId === entry.name);
      }
    });
  } catch { return previous.filter(status => status.sessionId === sessionId); }
}

// Frames re-read every call output unless the source values are unchanged. Object calls
// keep their extracted run ids in a WeakMap (collected with the call); short string ids use
// a bounded LRU. Any edited source rescans that call. An append can create or destroy a
// UUID word boundary, so a tail increment is not reused.
const RUN_ID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const STRING_RUN_CACHE_LIMIT = 256;
const STRING_RUN_CACHE_MAX_LENGTH = 128;
const stringRunCache = new Map<string, string | null>();
type SourceSnap = { ref: unknown; text?: string };
type CallSnap = { id: SourceSnap; output: SourceSnap; task: SourceSnap; action: SourceSnap; callId?: string; runIds: string[] };
const callSnaps = new WeakMap<object, CallSnap>();

function sourceSnap(value: unknown): SourceSnap {
  if (typeof value === "string" || value == null) return { ref: value };
  return { ref: value, text: String(value) };
}
function sourceText(snap: SourceSnap): string {
  if (typeof snap.ref === "string") return snap.ref;
  if (snap.ref == null) return "";
  return snap.text ?? "";
}
function sameSource(value: unknown, snap: SourceSnap): boolean {
  if (typeof value === "string" || value == null) return value === snap.ref;
  return String(value) === snap.text;
}
function collectRunIds(text: string, seen: Set<string>, into: string[]) {
  if (text.length < 36) return;
  RUN_ID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUN_ID_PATTERN.exec(text))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    into.push(match[1]);
  }
  RUN_ID_PATTERN.lastIndex = 0;
}
function firstRunId(text: string): string | null {
  if (text.length < 36) return null;
  RUN_ID_PATTERN.lastIndex = 0;
  const match = RUN_ID_PATTERN.exec(text);
  RUN_ID_PATTERN.lastIndex = 0;
  return match?.[1] ?? null;
}
function cachedStringRunId(item: string): string | null {
  if (item.length > STRING_RUN_CACHE_MAX_LENGTH) return firstRunId(item);
  const cached = stringRunCache.get(item);
  if (cached !== undefined) {
    stringRunCache.delete(item);
    stringRunCache.set(item, cached);
    return cached;
  }
  const found = firstRunId(item);
  stringRunCache.set(item, found);
  if (stringRunCache.size > STRING_RUN_CACHE_LIMIT) {
    const oldest = stringRunCache.keys().next().value;
    if (oldest !== undefined) stringRunCache.delete(oldest);
  }
  return found;
}
function callSnap(item: object): CallSnap {
  const call = item as Record<string, unknown>;
  const cached = callSnaps.get(item);
  if (cached && sameSource(call.id, cached.id) && sameSource(call.output, cached.output)
    && sameSource(call.task, cached.task) && sameSource(call.action, cached.action)) return cached;
  const output = sourceSnap(call.output);
  const task = sourceSnap(call.task);
  const action = sourceSnap(call.action);
  const runIds: string[] = [];
  const seen = new Set<string>();
  collectRunIds(sourceText(output), seen, runIds);
  collectRunIds(sourceText(task), seen, runIds);
  collectRunIds(sourceText(action), seen, runIds);
  const next: CallSnap = {
    id: sourceSnap(call.id), output, task, action,
    callId: typeof call.id === "string" ? call.id : undefined, runIds,
  };
  callSnaps.set(item, next);
  return next;
}
type CallKeys = { callIds: Set<string>; runIds: Set<string> };
function collectCallKeys(items: unknown[]): CallKeys {
  const callIds = new Set<string>();
  const runIds = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      callIds.add(item);
      const runId = cachedStringRunId(item);
      if (runId) runIds.add(runId);
    } else if (item && typeof item === "object") {
      const snap = callSnap(item);
      if (snap.callId) callIds.add(snap.callId);
      for (const runId of snap.runIds) runIds.add(runId);
    }
  }
  return { callIds, runIds };
}

type StatusHit = { status: Record<string, unknown>; index: number };
type StatusIndex = { byRun: Map<string, StatusHit[]>; byTool: Map<string, string[]>; children: Map<string, string[]> };
function indexStatuses(statuses: Record<string, unknown>[]): StatusIndex {
  const byRun = new Map<string, StatusHit[]>();
  const byTool = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (let index = 0; index < statuses.length; index++) {
    const status = statuses[index];
    const selectKey = String(status.runId);
    const bucket = byRun.get(selectKey);
    if (bucket) bucket.push({ status, index });
    else byRun.set(selectKey, [{ status, index }]);
    const directKey = String(status.runId ?? "");
    const toolCallId = String(status.toolCallId ?? "");
    if (toolCallId && directKey) {
      const tools = byTool.get(toolCallId);
      if (tools) tools.push(directKey);
      else byTool.set(toolCallId, [directKey]);
    }
    const parentId = String(status.parentWorkflowRunId ?? "");
    if (parentId) {
      const kids = children.get(parentId);
      if (kids) kids.push(selectKey);
      else children.set(parentId, [selectKey]);
    }
  }
  return { byRun, byTool, children };
}
function selectRunIds(index: StatusIndex, keys: CallKeys): Set<string> {
  const selected = new Set<string>();
  for (const id of keys.callIds) {
    const runs = index.byTool.get(id);
    if (runs) for (const runId of runs) selected.add(runId);
  }
  for (const runId of keys.runIds) if (index.byRun.has(runId)) selected.add(runId);
  if (selected.size === 0) return selected;
  const queue = [...selected];
  for (let i = 0; i < queue.length; i++) {
    const kids = index.children.get(queue[i]);
    if (!kids) continue;
    for (const runId of kids) if (!selected.has(runId)) {
      selected.add(runId);
      queue.push(runId);
    }
  }
  return selected;
}
function takeStatuses(index: StatusIndex, selected: Set<string>, claimed?: Set<string>): Record<string, unknown>[] {
  const hits: StatusHit[] = [];
  for (const runId of selected) {
    const bucket = index.byRun.get(runId);
    if (!bucket) continue;
    for (const hit of bucket) {
      const key = String(hit.status.runId ?? "");
      if (claimed && key && claimed.has(key)) continue;
      hits.push(hit);
    }
  }
  if (hits.length > 1) hits.sort((a, b) => a.index - b.index);
  if (claimed) for (const hit of hits) {
    const key = String(hit.status.runId ?? "");
    if (key) claimed.add(key);
  }
  return hits.map(hit => hit.status);
}

export function currentAgentStatuses(statuses: Record<string, unknown>[], callsOrIds: unknown[]): Record<string, unknown>[] {
  if (statuses.length === 0 || callsOrIds.length === 0) return [];
  const index = indexStatuses(statuses);
  return takeStatuses(index, selectRunIds(index, collectCallKeys(callsOrIds)));
}

/** Associate each status only with the user turn that dispatched its tool call.
 * Status snapshots are session-wide and can update after later turns begin.
 */
export function agentStatusesByTurn(statuses: Record<string, unknown>[], turns: Array<{ agentCalls?: unknown[] }>): Map<number, Record<string, unknown>[]> {
  const assigned = new Map<number, Record<string, unknown>[]>();
  if (statuses.length === 0) {
    for (let index = 0; index < turns.length; index++) assigned.set(index, []);
    return assigned;
  }
  const indexed = indexStatuses(statuses);
  const claimed = new Set<string>();
  for (let index = 0; index < turns.length; index++) {
    const calls = turns[index]?.agentCalls ?? [];
    assigned.set(index, calls.length === 0 ? [] : takeStatuses(indexed, selectRunIds(indexed, collectCallKeys(calls)), claimed));
  }
  return assigned;
}

export function agentChildren(statuses: Record<string, unknown>[]): Record<string, unknown>[] {
  if (statuses.length === 0) return [];
  const children = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, key: string) => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (typeof node.agent === "string") {
      const id = String(node.runId ?? (node.childId ? `${key}:${node.childId}` : key));
      const previous = children.get(id);
      children.set(id, { ...previous, ...node, displayId: id, model: node.model || previous?.model, thinking: node.thinking || previous?.thinking });
    }
    const inventory = node.workflowChildren as { children?: unknown[] } | undefined;
    if (Array.isArray(inventory?.children)) inventory.children.forEach((child, i) => visit(child, `${key}/steps/${i}`));
    if (Array.isArray(node.steps)) node.steps.forEach((child, i) => visit(child, `${key}/steps/${i}`));
    if (Array.isArray(node.children)) node.children.forEach((child, i) => visit(child, `${key}/children/${i}`));
  };
  // Workflow snapshots can lag behind the child. Merge their metadata first,
  // then apply the child's own snapshot regardless of directory iteration order.
  for (const status of [...statuses.filter(status => status.mode !== "single"), ...statuses.filter(status => status.mode === "single")]) {
    if (status.mode === "single" && Array.isArray(status.steps) && status.steps.length === 1) {
      const terminal = finishedAgent(status.state) || failedAgent(status);
      visit({ ...status.steps[0], runId: status.runId, startedAt: status.steps[0].startedAt ?? status.startedAt,
        notice: status.notice ?? status.steps[0].notice, noticeMessages: status.noticeMessages ?? status.steps[0].noticeMessages,
        ...(terminal ? { status: status.state, endedAt: status.steps[0].endedAt ?? status.endedAt, error: status.error ?? status.steps[0].error } : {}),
      }, String(status.runId));
    } else visit({ ...status, notice: status.notice, noticeMessages: status.noticeMessages }, String(status.runId));
  }
  return [...children.values()];
}
