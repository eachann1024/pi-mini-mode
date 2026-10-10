import { agentCall, type AgentCall } from "./agent-view.ts";
import { addUsage, EMPTY_USAGE, type SessionUsage, type UsageLike } from "./usage.ts";
import { stripVTControlCharacters } from "node:util";

export interface MinimalTurn {
  question: string;
  usage?: SessionUsage;
  pendingUsage?: UsageLike;
  agentCalls?: AgentCall[];
  subAgents?: Record<string, unknown>[];
  process: string[];
  final?: string;
  replies?: string[];
  running?: boolean;
  /** Wall-clock start of this user-request execution; retained across tool and thinking turns. */
  startedAt?: number;
  endedAt?: number;
  thinking?: number;
  /** Per-process-index Thinking clocks. Live rows count; completed rows keep endedAt. */
  thinkingClocks?: Array<ThinkingClock | undefined>;
  thinkingOutcomes?: Array<ThinkingOutcome | undefined>;
  awaitingResponse?: boolean;
  waitingTools?: Array<{ id: string; name: string; startedAt: number }>;
}

export interface ThinkingClock {
  startedAt: number;
  endedAt?: number;
}

export type ThinkingOutcome = "done" | "error" | "aborted";

export function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object" && "content" in content) return contentText(content.content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean)
    .join("\n");
}

export function processText(value: unknown): string {
  return contentText(value) || (value === undefined ? "" : JSON.stringify(value) ?? "");
}

/** Format an execution duration without losing hours once a long run crosses one. */
export function formatElapsed(startedAt: number | undefined, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

/** Compact tool duration, visible from the start of execution. */
export function formatToolElapsed(startedAt: number | undefined, endedAt = Date.now()): string {
  if (startedAt === undefined) return "";
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (!seconds) return "1s";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  return `${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}${remainder ? `${remainder}s` : ""}`;
}

export function ensureThinkingClock(turn: MinimalTurn, index: number, startedAt = Date.now()): ThinkingClock {
  const clocks = turn.thinkingClocks ??= [];
  return clocks[index] ??= { startedAt };
}

export function freezeThinkingClock(turn: MinimalTurn | undefined, index: number | undefined, endedAt = Date.now(), outcome: ThinkingOutcome = "done"): void {
  if (!turn || index === undefined) return;
  const clock = turn.thinkingClocks?.[index];
  if (clock && clock.endedAt === undefined) clock.endedAt = endedAt;
  (turn.thinkingOutcomes ??= [])[index] ??= outcome;
}

export function freezeOpenThinkingClocks(turn: MinimalTurn | undefined, endedAt = Date.now(), outcome: ThinkingOutcome = "done"): void {
  if (!turn?.thinkingClocks) return;
  for (const [index, clock] of turn.thinkingClocks.entries()) {
    if (clock && clock.endedAt === undefined) freezeThinkingClock(turn, index, endedAt, outcome);
  }
}

/** Each Thinking row counts from its own start and keeps its frozen stop time. */
export function formatThinkingElapsed(
  turn: Pick<MinimalTurn, "startedAt" | "thinkingClocks">,
  processIndex: number,
  active: boolean,
  now = Date.now(),
): string {
  const clock = turn.thinkingClocks?.[processIndex];
  const startedAt = clock?.startedAt;
  if (active && startedAt != null) return `${(Math.max(0, now - startedAt) / 1_000).toFixed(1)}s`;
  if (clock?.endedAt != null) return `${(Math.max(0, clock.endedAt - clock.startedAt) / 1_000).toFixed(1)}s`;
  return "";
}

export function pushProcess(turn: MinimalTurn | undefined, kind: string, value: unknown): void {
  if (!turn) return;
  const text = processText(value);
  const line = text ? `${kind} ${text}` : kind;
  if (turn.process.at(-1) !== line) turn.process.push(line);
}

export function thinkingText(item: Record<string, unknown>): string {
  const readable = (value: unknown) => typeof value === "string"
    ? stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim() : "";
  const body = readable(item.thinking) || readable(item.text);
  if (body) return body;
  // Recover only the explicitly readable summary. Encrypted/signature data is never prose.
  try {
    const signature = typeof item.thinkingSignature === "string" ? JSON.parse(item.thinkingSignature) : undefined;
    if (signature?.type === "reasoning" && Array.isArray(signature.summary)) {
      return signature.summary.filter((part: { type?: unknown }) => part?.type === "summary_text")
        .map((part: { text?: unknown }) => readable(part.text)).filter(Boolean).join("\n\n");
    }
  } catch { /* Other providers use opaque signatures. */ }
  return "";
}

export function skillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\/skill:([\w.-]+)/g)) names.add(match[1]);
  for (const match of text.matchAll(/<skill[^>]*?(?:name=["']([^"']+)["']|>\s*<name>([^<]+))/gi)) names.add((match[1] ?? match[2]).trim());
  return [...names];
}

/** pi-loop injects its wakeup as a user message; keep its boilerplate out of the compact card. */
export function piLoopSummary(question: string): string | undefined {
  if (!question.startsWith("[pi-loop]")) return;
  const lines = question.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = lines[0] ?? "[pi-loop]";
  const prompt = lines.find(line => line !== title && !line.startsWith("[Self-paced loop:"));
  return prompt ? `${title} · ${prompt}` : title;
}

/** Rebuild turns on the selected session branch. */
export function minimalTurnsFromBranch(branch: readonly unknown[]): MinimalTurn[] {
  const turns: MinimalTurn[] = [];
  let turn: MinimalTurn | undefined;
  for (const rawEntry of branch) {
    const entry = rawEntry as { type?: string; message?: { role?: string; content?: unknown; usage?: UsageLike; stopReason?: string; errorMessage?: string } } | null;
    if (entry?.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role === "user") {
      const question = contentText(content);
      turn = { question: question || "[Attachment]",  process: [], running: false };
      for (const name of skillNames(question)) pushProcess(turn, "skill", name);
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (role === "assistant" || role === "toolResult") turn.usage = addUsage(turn.usage ?? EMPTY_USAGE, entry.message.usage);
    if (role === "toolResult") {
      const result = entry.message as { toolCallId?: string; isError?: boolean };
      const call = turn.agentCalls?.find(call => call.id === result.toolCallId);
      if (call) {
        call.state = result.isError ? "error" : "done";
        call.output = contentText(content) || "Call returned (no text output)";
        continue;
      }
      pushProcess(turn, "output", content);
      continue;
    }
    if (role !== "assistant" || !Array.isArray(content)) continue;
    if (turn.final) (turn.replies ??= []).push(turn.final);
    turn.final = undefined;
    for (const [blockIndex, item] of (content as Array<Record<string, unknown>>).entries()) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "thinking") {
        const index = turn.process.push(`thinking ${thinkingText(item)}`) - 1;
        (turn.thinkingOutcomes ??= [])[index] = blockIndex === content.length - 1
          && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") ? entry.message.stopReason : "done";
      } else if (item.type === "toolCall") {
        if (item.name) {
          (turn.agentCalls ??= []).push(agentCall(String(item.id), String(item.name), item.arguments ?? item.input));
          pushProcess(turn, "call", String(item.id));
          const path = (item.arguments as { path?: string })?.path;
          if (path && /(?:^|\/)SKILL\.md$/i.test(path)) pushProcess(turn, "skill", path.split("/").at(-2));
          continue;
        }
        pushProcess(turn, `tool ${String(item.name ?? "")}`.trim(), item.arguments ?? item.input);
        const path = (item.arguments as { path?: unknown })?.path;
        if (typeof path === "string" && /(?:^|\/)SKILL\.md$/i.test(path)) pushProcess(turn, "skill", path.split("/").at(-2) ?? path);
      }
    }
    const text = contentText(content);
    const hasTools = content.some((item) => item?.type === "toolCall");
    if (hasTools) {
      if (text) pushProcess(turn, "output", text);
      turn.final = undefined;
    } else turn.final = text || undefined;
    if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
      turn.final = [entry.message.stopReason === "aborted" ? "Execution aborted" : "Execution failed", entry.message.errorMessage, turn.final].filter(Boolean).join("\n");
    }
  }
  return turns;
}
