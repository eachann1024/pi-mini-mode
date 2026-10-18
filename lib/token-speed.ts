import { finiteNumber, formatSpeed, formatUsd, outputSpeed, speedColor, DECODE_SPEED_MIN_OUTPUT, type SpeedColor, type UsageLike } from "./usage.ts";

/** Footer redraw cadence while a turn is streaming. */
export const SPEED_REFRESH_MS = 500;
/** Recent window used for the live rate. Long enough to absorb one quiet chunk, short enough to follow the current pace. */
export const SPEED_WINDOW_MS = 1_000;

export interface SpeedMetric {
  label: string;
  value: string;
  color?: SpeedColor | "text" | "muted";
}

interface Sample {
  t: number;
  tokens: number;
}

interface UsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: number;
}

function speedKey(value: number | undefined): string {
  return value === undefined ? "" : formatSpeed(value, false);
}

/** ASCII ~4 chars/token; CJK and other non-ASCII ~1 token each. */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) ascii += 1;
    else other += 1;
  }
  return ascii / 4 + other;
}

export function estimateContentTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (typeof item.text === "string") tokens += estimateTextTokens(item.text);
    if (typeof item.thinking === "string") tokens += estimateTextTokens(item.thinking);
    if (typeof item.name === "string") tokens += estimateTextTokens(item.name);
    if (typeof item.arguments === "string") tokens += estimateTextTokens(item.arguments);
    else if (item.arguments && typeof item.arguments === "object") tokens += estimateTextTokens(JSON.stringify(item.arguments));
  }
  return tokens;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  return `${seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2)}s`;
}

function readUsage(usage: UsageLike | undefined, into: UsageSnapshot): void {
  if (!usage) return;
  const extra = usage as UsageLike & { reasoning?: unknown; totalTokens?: unknown; cacheWrite1h?: unknown };
  const take = (key: keyof UsageSnapshot, value: unknown) => {
    const number = finiteNumber(value);
    if (number !== undefined) into[key] = number;
  };
  take("input", usage.input);
  take("output", usage.output);
  take("cacheRead", usage.cacheRead);
  take("cacheWrite", usage.cacheWrite);
  take("cacheWrite1h", extra.cacheWrite1h);
  take("reasoning", extra.reasoning);
  take("totalTokens", extra.totalTokens);
  take("cost", usage.cost?.total);
}

export interface StreamUpdate {
  at: number;
  output?: number;
  content?: unknown;
  usage?: UsageLike;
}

/**
 * Live footer speed is the token rate over the last second, republished every
 * 500ms. Provider `usage.output` wins when it advances; streamed text keeps the
 * rate moving when that sample is stale. The finished turn replaces it with
 * the average decode speed.
 */
export function createTokenSpeedTracker() {
  let displayed: number | undefined;
  let lastLive: number | undefined;
  let streaming = false;
  let lastPublish = 0;
  let lastStreamAt = Number.NEGATIVE_INFINITY;
  let lastNow = 0;
  let turnStartedAt: number | undefined;
  let assistantStartedAt: number | undefined;
  let firstTokenAt: number | undefined;
  let segmentEndedAt: number | undefined;
  let providerOutput = 0;
  let streamTokens = 0;
  let samples: Sample[] = [];
  let usage: UsageSnapshot = {};
  let frozen: SpeedMetric[] | undefined;

  const liveCount = () => Math.max(providerOutput, streamTokens);

  const pushSample = (at: number, tokens: number) => {
    const last = samples[samples.length - 1];
    if (last && last.t === at) last.tokens = tokens;
    else samples.push({ t: at, tokens });
    const cutoff = at - SPEED_WINDOW_MS * 3;
    if (samples.length > 12) samples = samples.filter((sample) => sample.t >= cutoff);
  };

  const liveRate = (now: number): number | undefined => {
    if (firstTokenAt === undefined || now - firstTokenAt < SPEED_REFRESH_MS) return undefined;
    const tokens = liveCount();
    const windowMs = Math.min(SPEED_WINDOW_MS, now - firstTokenAt);
    const cut = now - windowMs;
    let baseT = firstTokenAt;
    let baseTokens = 0;
    for (const sample of samples) {
      if (sample.t <= cut) {
        baseT = sample.t;
        baseTokens = sample.tokens;
      } else break;
    }
    const elapsed = now - baseT;
    if (elapsed < SPEED_REFRESH_MS / 2) return undefined;
    const delta = tokens - baseTokens;
    if (delta < 0) return undefined;
    const rate = delta / (elapsed / 1_000);
    return Number.isFinite(rate) ? rate : undefined;
  };

  const publish = (now: number): boolean => {
    if (!streaming || now - lastPublish < SPEED_REFRESH_MS) return false;
    const rate = liveRate(now);
    if (rate === undefined) return false;
    lastPublish = now;
    lastLive = rate;
    const changed = speedKey(displayed) !== speedKey(rate);
    displayed = rate;
    return changed;
  };

  const settledCount = () => usage.output !== undefined && usage.output >= DECODE_SPEED_MIN_OUTPUT ? usage.output : liveCount();

  const runningAverage = (now: number): number | undefined => {
    const count = streaming ? liveCount() : settledCount();
    const end = streaming ? now : (segmentEndedAt ?? now);
    return outputSpeed(count, firstTokenAt, end);
  };

  const collect = (): SpeedMetric[] => {
    const rows: SpeedMetric[] = [];
    const now = lastNow || Date.now();
    const average = runningAverage(now);
    if (average !== undefined) rows.push({ label: "平均速度", value: formatSpeed(average, true), color: speedColor(average) });
    if (streaming && lastLive !== undefined) rows.push({ label: "实时速度", value: formatSpeed(lastLive, true), color: speedColor(lastLive) });
    const origin = turnStartedAt ?? assistantStartedAt;
    if (firstTokenAt !== undefined && origin !== undefined && firstTokenAt > origin) {
      rows.push({ label: "首字吐字", value: formatDuration(firstTokenAt - origin), color: "text" });
    }
    const decodeEnd = streaming ? now : segmentEndedAt;
    if (firstTokenAt !== undefined && decodeEnd !== undefined && decodeEnd - firstTokenAt >= SPEED_REFRESH_MS) {
      rows.push({ label: "解码用时", value: formatDuration(decodeEnd - firstTokenAt), color: "text" });
    }
    const counts: Array<[keyof UsageSnapshot, string]> = [
      ["output", "输出 token"],
      ["input", "输入 token"],
      ["cacheRead", "缓存读取"],
      ["cacheWrite", "缓存写入"],
      ["cacheWrite1h", "写入 1h"],
      ["reasoning", "推理 token"],
      ["totalTokens", "合计 token"],
    ];
    for (const [key, label] of counts) {
      const value = usage[key];
      if (value === undefined || value <= 0) continue;
      rows.push({ label, value: formatCount(value), color: "text" });
    }
    if (usage.output === undefined && !streaming && liveCount() >= DECODE_SPEED_MIN_OUTPUT) {
      rows.push({ label: "输出 token", value: formatCount(liveCount()), color: "text" });
    }
    if (usage.cost !== undefined && usage.cost > 0) rows.push({ label: "费用", value: formatUsd(usage.cost), color: "muted" });
    if (rows.length === 0 && displayed !== undefined) {
      rows.push({ label: "平均速度", value: formatSpeed(displayed, true), color: speedColor(displayed) });
    }
    return rows;
  };

  return {
    onTurnStart(at: number) {
      lastNow = at;
      turnStartedAt = at;
    },
    onAssistantStart(at: number) {
      lastNow = at;
      streaming = true;
      lastPublish = at;
      lastStreamAt = Number.NEGATIVE_INFINITY;
      assistantStartedAt = at;
      firstTokenAt = undefined;
      segmentEndedAt = undefined;
      providerOutput = 0;
      streamTokens = 0;
      samples = [];
      usage = {};
      lastLive = undefined;
    },
    onStream(update: StreamUpdate): boolean {
      if (!streaming || update.at < lastStreamAt) return false;
      const nextProvider = update.output !== undefined && update.output >= providerOutput ? update.output : providerOutput;
      const nextStream = Math.max(streamTokens, estimateContentTokens(update.content));
      const nextTokens = Math.max(nextProvider, nextStream);
      // Regressing or repeated samples must not move the clock. The 500ms timer
      // still decays the live rate when tokens actually stop arriving.
      if (nextTokens <= liveCount() && liveCount() > 0) return false;
      lastStreamAt = update.at;
      lastNow = update.at;
      providerOutput = nextProvider;
      streamTokens = nextStream;
      readUsage(update.usage, usage);
      if (nextTokens > 0) {
        if (firstTokenAt === undefined) firstTokenAt = update.at;
        pushSample(update.at, nextTokens);
      }
      return publish(update.at);
    },
    refresh(at: number): boolean {
      lastNow = at;
      if (streaming && firstTokenAt !== undefined) pushSample(at, liveCount());
      return publish(at);
    },
    onAssistantEnd(finalUsage: UsageLike | undefined, at: number): boolean {
      if (at >= lastStreamAt) lastStreamAt = at;
      lastNow = at;
      streaming = false;
      segmentEndedAt = at;
      readUsage(finalUsage, usage);
      const reported = finiteNumber(finalUsage?.output);
      if (reported !== undefined && reported >= providerOutput) providerOutput = reported;
      if (usage.output === undefined && providerOutput > 0) usage.output = providerOutput;
      const count = reported !== undefined && reported >= DECODE_SPEED_MIN_OUTPUT
        ? reported
        : liveCount();
      if (count > 0 && firstTokenAt === undefined) firstTokenAt = assistantStartedAt ?? at;
      const average = outputSpeed(count, firstTokenAt, at);
      lastLive = undefined;
      if (average !== undefined) displayed = average;
      frozen = collect();
      return average !== undefined;
    },
    noteNested(output: unknown, startedAt: number, endedAt: number): boolean {
      if (displayed !== undefined) return false;
      const rate = outputSpeed(output, startedAt, endedAt);
      if (rate === undefined) return false;
      displayed = rate;
      lastNow = endedAt;
      return true;
    },
    displayed(): number | undefined {
      return displayed;
    },
    streaming(): boolean {
      return streaming;
    },
    metrics(): SpeedMetric[] {
      if (streaming && lastLive === undefined && frozen?.length) return frozen;
      return collect();
    },
    reset() {
      displayed = undefined;
      lastLive = undefined;
      streaming = false;
      lastPublish = 0;
      lastStreamAt = Number.NEGATIVE_INFINITY;
      lastNow = 0;
      turnStartedAt = undefined;
      assistantStartedAt = undefined;
      firstTokenAt = undefined;
      segmentEndedAt = undefined;
      providerOutput = 0;
      streamTokens = 0;
      samples = [];
      usage = {};
      frozen = undefined;
    },
  };
}
