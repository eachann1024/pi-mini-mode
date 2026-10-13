import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const plain = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();

/** Child gate JSON is for the runtime, not the transcript. */
export function stripAcceptanceReport(output: string): string {
  return output
    .replace(/\n?```acceptance[-_]report\s*\n[\s\S]*?```\s*$/i, "")
    .replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
    .trimEnd();
}

/** Recover the child's own prose and raw tool inputs from its session, never from activity previews. */
const childSessionCache = new Map<string, { stamp: string; thinking: string; finalOutput: string; latestText: string; inputs: Array<{ name: string; value: string }> }>();
const singleLine = (value: string) => plain(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ");
export function childSessionData(sessionFile: unknown) {
  if (typeof sessionFile !== "string") return undefined;
  try {
    const stat = statSync(sessionFile);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    let cached = childSessionCache.get(sessionFile);
    if (!cached || cached.stamp !== stamp) {
      const inputs: Array<{ name: string; value: string }> = [];
      let thinking = "";
      let finalOutput = "";
      let latestText = "";
      for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
        try {
          const entry = JSON.parse(line) as { type?: string; thinkingLevel?: string; message?: { role?: string; stopReason?: string; channel?: string; content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown>; arguments?: Record<string, unknown> } | null> } };
          if (entry.type === "thinking_level_change" && /^(off|minimal|low|medium|high|xhigh|max)$/.test(entry.thinkingLevel ?? "")) thinking = entry.thinkingLevel!;
          if (entry.message?.role !== "assistant") continue;
          const message = entry.message;
          const content = Array.isArray(message.content) ? message.content : [];
          const text = content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block!.text).join("\n\n").trim();
          // Pi persists no channel: only a stopped assistant text reply is a final answer.
          finalOutput = entry.type === "message" && message.stopReason === "stop"
            && (message.channel === undefined || message.channel === "final")
            && !content.some(block => block?.type === "toolCall")
            ? text : "";
          // Narration attached to a tool call is still the child's own prose; it
          // is the only body a running or tool-ended child has.
          if (entry.type === "message" && text) latestText = text;
          for (const call of content) {
            if (!call) continue;
            if (call.type !== "toolCall" || typeof call.name !== "string") continue;
            const input = call.arguments ?? call.input ?? {};
            const value = [input.path, input.command, input.pattern, input.query, input.task, input.prompt]
              .find((candidate): candidate is string => typeof candidate === "string") ?? "";
            if (value) inputs.push({ name: call.name, value: singleLine(value) });
          }
        } catch { /* A concurrently written session can end with a partial line. */ }
      }
      cached = { stamp, thinking, finalOutput, latestText, inputs };
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
    const children = agentChildren([status]).map(child => {
      const previous = saved && agentChildren([saved]).find(item => item.displayId === child.displayId);
      const sameAttempt = previous?.sessionFile === child.sessionFile && previous?.startedAt === child.startedAt;
      const finalOutput = childSessionData(child.sessionFile)?.finalOutput ?? child.finalOutput ?? (sameAttempt ? previous?.finalOutput : undefined);
      return { ...child, finalOutput, notice: child.notice ?? previous?.notice, noticeMessages: child.noticeMessages ?? previous?.noticeMessages };
    });
    retained.set(String(status.runId), children.length
      ? { ...status, steps: children, workflowChildren: undefined, children: undefined } : status);
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

export function currentAgentStatuses(statuses: Record<string, unknown>[], callsOrIds: unknown[]): Record<string, unknown>[] {
  const callIds = new Set<string>();
  const runIds = new Set<string>();
  for (const item of callsOrIds) {
    if (typeof item === "string") {
      callIds.add(item);
      const match = item.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
      if (match) runIds.add(match[1]);
    } else if (item && typeof item === "object") {
      const call = item as Record<string, unknown>;
      if (typeof call.id === "string") callIds.add(call.id);
      const text = `${call.output ?? ""} ${call.task ?? ""} ${call.action ?? ""}`;
      const matches = text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi);
      for (const m of matches) runIds.add(m[1]);
    }
  }
  const selected = new Set<string>();
  for (const status of statuses) {
    const runId = String(status.runId ?? "");
    const toolCallId = String(status.toolCallId ?? "");
    if ((toolCallId && callIds.has(toolCallId)) || (runId && runIds.has(runId))) {
      if (runId) selected.add(runId);
    }
  }
  for (let size = -1; size !== selected.size;) {
    size = selected.size;
    for (const status of statuses) {
      const parentId = String(status.parentWorkflowRunId ?? "");
      if (parentId && selected.has(parentId)) selected.add(String(status.runId));
    }
  }
  return statuses.filter(status => selected.has(String(status.runId)));
}

/** Associate each status only with the user turn that dispatched its tool call.
 * Status snapshots are session-wide and can update after later turns begin.
 */
export function agentStatusesByTurn(statuses: Record<string, unknown>[], turns: Array<{ agentCalls?: unknown[] }>): Map<number, Record<string, unknown>[]> {
  const assigned = new Map<number, Record<string, unknown>[]>();
  const claimed = new Set<string>();
  for (const [index, turn] of turns.entries()) {
    const matched = currentAgentStatuses(statuses, turn.agentCalls ?? []).filter(status => {
      const runId = String(status.runId ?? "");
      return !runId || !claimed.has(runId);
    });
    assigned.set(index, matched);
    for (const status of matched) {
      const runId = String(status.runId ?? "");
      if (runId) claimed.add(runId);
    }
  }
  return assigned;
}

export function agentChildren(statuses: Record<string, unknown>[]): Record<string, unknown>[] {
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
