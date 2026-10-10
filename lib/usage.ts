import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finiteNumber(value) ?? 0);
}

export function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
}

export interface SessionUsage {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const EMPTY_USAGE: SessionUsage = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

export function addUsage(total: SessionUsage, usage: UsageLike | undefined): SessionUsage {
  if (!usage) return total;
  const input = nonNegative(usage.input);
  const output = nonNegative(usage.output);
  const cacheRead = nonNegative(usage.cacheRead);
  const cacheWrite = nonNegative(usage.cacheWrite);
  // totalTokens is the provider's authoritative count. Older/custom tool results
  // sometimes omit it, so only then derive a complete count from its components.
  const reportedTotal = finiteNumber(usage.totalTokens);
  return {
    totalTokens: total.totalTokens + Math.max(0, reportedTotal ?? input + output + cacheRead + cacheWrite),
    input: total.input + input,
    output: total.output + output,
    cacheRead: total.cacheRead + cacheRead,
    cacheWrite: total.cacheWrite + cacheWrite,
    cost: total.cost + nonNegative(usage.cost?.total),
  };
}

export interface CacheWaste {
  missedTokens: number;
  missCount: number;
}

/** Same noise floor as Pi's cache-miss notice. Compaction resets the baseline. */
export function cacheWaste(entries: ReadonlyArray<{ type?: unknown; message?: { role?: unknown; usage?: UsageLike } }>): CacheWaste {
  let prev = 0;
  let reported = false;
  const totals = { missedTokens: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") { prev = 0; continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    const input = nonNegative(usage?.input);
    const cacheRead = nonNegative(usage?.cacheRead);
    const cacheWrite = nonNegative(usage?.cacheWrite);
    const prompt = input + cacheRead + cacheWrite;
    if (prev > 0 && prompt > 0 && (cacheRead + cacheWrite > 0 || reported)) {
      const missed = Math.min(prev, prompt) - cacheRead;
      if (missed > 1024) { totals.missedTokens += missed; totals.missCount++; }
    }
    if (prompt > 0) { prev = prompt; reported ||= cacheRead + cacheWrite > 0; }
  }
  return totals;
}

/** Aggregate persisted, finalized usage once per active-branch entry. */
export function sessionUsage(ctx: ExtensionContext): SessionUsage {
  return ctx.sessionManager.getBranch().reduce((total, entry) => {
    if (entry.type !== "message") return total;
    const message = entry.message as { role?: unknown; usage?: UsageLike };
    return message.role === "assistant" || message.role === "toolResult"
      ? addUsage(total, message.usage)
      : total;
  }, { ...EMPTY_USAGE });
}

export function cacheHit(usage: SessionUsage): number | undefined {
  const cacheBase = usage.input + usage.cacheRead;
  return cacheBase === 0 ? undefined : 100 * usage.cacheRead / cacheBase;
}

export type SpeedColor = "success" | "warning" | "error" | "muted";

export function speedColor(speed: number | undefined): SpeedColor {
  if (speed === undefined) return "muted";
  if (speed >= 30) return "success";
  if (speed >= 10) return "warning";
  return "error";
}

export function formatSpeed(speed: number, showUnit: boolean): string {
  const value = speed.toFixed(speed >= 100 ? 0 : 1);
  return showUnit ? `${value} tok/s` : value;
}

export interface ActiveGeneration {
  firstTokenAt?: number;
  output: number;
  lastSampleAt: number;
}

/** Hide sub-100ms bursts (batched usage) and 1-token completions; they are not a decode rate. */
export const DECODE_SPEED_MIN_ELAPSED_MS = 100;
export const DECODE_SPEED_MIN_OUTPUT = 2;

/** Decode TPS: provider `usage.output` / seconds after the first output token (excludes TTFT). */
export function outputSpeed(output: unknown, firstTokenAt: number | undefined, endedAt = Date.now()): number | undefined {
  const tokenCount = finiteNumber(output);
  if (firstTokenAt === undefined || tokenCount === undefined || tokenCount < DECODE_SPEED_MIN_OUTPUT) return undefined;
  const elapsedMs = endedAt - firstTokenAt;
  if (elapsedMs < DECODE_SPEED_MIN_ELAPSED_MS) return undefined;
  const rate = tokenCount / (elapsedMs / 1_000);
  return Number.isFinite(rate) ? rate : undefined;
}
