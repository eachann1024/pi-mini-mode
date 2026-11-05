import { finiteNumber, formatSpeed, formatUsd, outputSpeed, speedColor, DECODE_SPEED_MIN_OUTPUT, type SpeedColor, type UsageLike } from "./usage.ts";

/** Footer redraw cadence while a turn is streaming. */
export const SPEED_REFRESH_MS = 500;
/** Recent window used for the live rate. Long enough to absorb one quiet chunk, short enough to follow the current pace. */
export const SPEED_WINDOW_MS = 2_500;

const CALIBRATION_ALPHA = 0.3;
const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 2;
const RELIABLE_MIN_ELAPSED_MS = 1_000;
const RELIABLE_MIN_OUTPUT = 16;
const SPIKE_MIN_TOKENS = 64;

export type ModelIdentifier = string | { provider?: unknown; model?: unknown };

function normalizeModelKey(model?: ModelIdentifier): string {
  if (typeof model === "string") {
    const trimmed = model.trim().replace(/^\/+|\/+$/g, "");
    return trimmed || "__default__";
  }
  if (model && typeof model === "object") {
    const provider = typeof model.provider === "string" ? model.provider.trim() : "";
    const id = typeof model.model === "string" ? model.model.trim() : "";
    return [provider, id].filter(Boolean).join("/") || "__default__";
  }
  return "__default__";
}

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
  type?: string;
  delta?: string;
}

/**
 * Live footer speed is the token rate over the last 2.5 seconds, republished
 * every 500ms. Provider `usage.output` wins once it advances monotonically at
 * least twice; streamed text keeps the rate moving otherwise. The finished
 * turn replaces it with the reliable weighted decode speed across the run.
 */
export function createTokenSpeedTracker() {
  let displayed: number | undefined;
  let lastReliable: number | undefined;
  let lastLive: number | undefined;
  let streaming = false;
  let lastPublish = 0;
  let lastStreamAt = Number.NEGATIVE_INFINITY;
  let lastTokenUpdateAt = Number.NEGATIVE_INFINITY;
  let lastNow = 0;
  let turnStartedAt: number | undefined;
  let assistantStartedAt: number | undefined;
  let firstTokenAt: number | undefined;
  let decodeStartedAt: number | undefined;
  let segmentEndedAt: number | undefined;
  let providerOutput = 0;
  let providerAdvances = 0;
  let firstProviderSample: Sample | undefined;
  let rawStreamTokens = 0;
  let streamTokens = 0;
  let hasSeenDelta = false;
  let firstSampleTokens = 0;
  let firstSampleRawTokens = 0;
  let liveBaseAt: number | undefined;
  let liveBaseTokens = 0;
  let samples: Sample[] = [];
  let usage: UsageSnapshot = {};
  let frozen: SpeedMetric[] | undefined;
  let runTokens = 0;
  let runElapsedMs = 0;
  let currentModelKey = "__default__";
  const calibrationRatios = new Map<string, number>();

  const calibrationRatio = () => calibrationRatios.get(currentModelKey) ?? 1;
  const trustedProvider = () => (providerAdvances >= 2 ? providerOutput : 0);
  const liveCount = () => Math.max(trustedProvider(), streamTokens);

  const pushSample = (at: number, tokens: number) => {
    const last = samples[samples.length - 1];
    if (last && last.t === at) last.tokens = tokens;
    else samples.push({ t: at, tokens });
    const cutoff = at - SPEED_WINDOW_MS * 3;
    if (samples.length > 12) samples = samples.filter((sample) => sample.t >= cutoff);
  };

  const liveRate = (now: number): number | undefined => {
    if (liveBaseAt === undefined || now - liveBaseAt < SPEED_REFRESH_MS) return undefined;
    const tokens = liveCount();
    const windowMs = Math.min(SPEED_WINDOW_MS, now - liveBaseAt);
    const cut = now - windowMs;
    let baseT = liveBaseAt;
    let baseTokens = liveBaseTokens;
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

  const settledCount = () => usage.output !== undefined && usage.output >= DECODE_SPEED_MIN_OUTPUT
    ? usage.output
    : Math.max(providerOutput, streamTokens);

  const runningAverage = (now: number): number | undefined => {
    if (streaming) return outputSpeed(liveCount(), firstTokenAt, now);
    if (displayed !== undefined) return displayed;
    const end = segmentEndedAt ?? now;
    return outputSpeed(settledCount(), decodeStartedAt ?? firstTokenAt, end);
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
    const decodeStart = streaming ? firstTokenAt : (decodeStartedAt ?? firstTokenAt);
    const decodeEnd = streaming ? now : segmentEndedAt;
    if (decodeStart !== undefined && decodeEnd !== undefined && decodeEnd - decodeStart >= SPEED_REFRESH_MS) {
      rows.push({ label: "解码用时", value: formatDuration(decodeEnd - decodeStart), color: "text" });
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
    if (usage.output === undefined && !streaming && settledCount() >= DECODE_SPEED_MIN_OUTPUT) {
      rows.push({ label: "输出 token", value: formatCount(settledCount()), color: "text" });
    }
    if (usage.cost !== undefined && usage.cost > 0) rows.push({ label: "费用", value: formatUsd(usage.cost), color: "muted" });
    if (rows.length === 0 && displayed !== undefined) {
      rows.push({ label: "平均速度", value: formatSpeed(displayed, true), color: speedColor(displayed) });
    }
    return rows;
  };

  return {
    onRunStart() {
      runTokens = 0;
      runElapsedMs = 0;
    },
    onTurnStart(at: number) {
      lastNow = at;
      turnStartedAt = at;
    },
    onAssistantStart(at: number, model?: ModelIdentifier) {
      lastNow = at;
      streaming = true;
      lastPublish = at;
      lastStreamAt = Number.NEGATIVE_INFINITY;
      lastTokenUpdateAt = Number.NEGATIVE_INFINITY;
      assistantStartedAt = at;
      firstTokenAt = undefined;
      decodeStartedAt = undefined;
      segmentEndedAt = undefined;
      providerOutput = 0;
      providerAdvances = 0;
      firstProviderSample = undefined;
      rawStreamTokens = 0;
      streamTokens = 0;
      hasSeenDelta = false;
      firstSampleTokens = 0;
      firstSampleRawTokens = 0;
      liveBaseAt = undefined;
      liveBaseTokens = 0;
      samples = [];
      usage = {};
      lastLive = undefined;
      currentModelKey = normalizeModelKey(model);
    },
    onStream(update: StreamUpdate): boolean {
      if (!streaming || update.at < lastStreamAt) return false;
      let prevCount = liveCount();

      if (update.output !== undefined && update.output > providerOutput) {
        providerAdvances += 1;
        providerOutput = update.output;
        if (providerAdvances === 1) {
          firstProviderSample = { t: update.at, tokens: update.output };
        } else if (providerAdvances === 2 && firstProviderSample) {
          if (firstTokenAt === undefined || firstProviderSample.t < firstTokenAt) {
            firstTokenAt = firstProviderSample.t;
            decodeStartedAt = firstProviderSample.t;
            firstSampleTokens = firstProviderSample.tokens;
            firstSampleRawTokens = firstProviderSample.tokens;
            liveBaseAt = firstProviderSample.t;
            liveBaseTokens = firstProviderSample.tokens;
            lastTokenUpdateAt = firstProviderSample.t;
            pushSample(firstProviderSample.t, firstProviderSample.tokens);
          } else if (liveBaseAt === firstProviderSample.t) {
            liveBaseTokens = Math.max(liveBaseTokens, firstProviderSample.tokens);
            firstSampleTokens = Math.max(firstSampleTokens, firstProviderSample.tokens);
            pushSample(firstProviderSample.t, liveBaseTokens);
          }
          prevCount = Math.max(prevCount, firstProviderSample.tokens);
          firstProviderSample = undefined;
        }
      }

      const isDeltaType = update.type === undefined
        || update.type === "text_delta"
        || update.type === "thinking_delta"
        || update.type === "toolcall_delta";
      const isBoundaryType = update.type !== undefined
        && (/(?:^|_)(?:start|end)$/.test(update.type) || update.type === "done" || update.type === "error");

      let nextRawStream = rawStreamTokens;
      if (typeof update.delta === "string" && isDeltaType) {
        hasSeenDelta = true;
        nextRawStream += estimateTextTokens(update.delta);
      } else if (!hasSeenDelta && !isBoundaryType && update.content !== undefined) {
        nextRawStream = Math.max(rawStreamTokens, estimateContentTokens(update.content));
      }
      const nextStream = nextRawStream * calibrationRatio();
      const nextTokens = Math.max(trustedProvider(), nextStream);

      // Regressing or repeated samples must not move the clock. The 500ms timer
      // still decays the live rate when tokens actually stop arriving.
      if (nextTokens <= prevCount && prevCount > 0) return false;

      lastStreamAt = update.at;
      lastNow = update.at;
      rawStreamTokens = nextRawStream;
      streamTokens = nextStream;
      readUsage(update.usage, usage);

      if (nextTokens > 0) {
        if (firstTokenAt === undefined) {
          firstTokenAt = update.at;
          decodeStartedAt = update.at;
          firstSampleTokens = nextTokens;
          firstSampleRawTokens = nextRawStream;
          liveBaseAt = update.at;
          liveBaseTokens = nextTokens;
          pushSample(update.at, nextTokens);
        } else if (update.at === firstTokenAt && samples.length <= 1) {
          firstSampleTokens = nextTokens;
          firstSampleRawTokens = nextRawStream;
          liveBaseAt = update.at;
          liveBaseTokens = nextTokens;
          pushSample(update.at, nextTokens);
        } else {
          const singleDelta = nextTokens - prevCount;
          const cut = update.at - SPEED_WINDOW_MS;
          let windowBaseTokens = liveBaseTokens;
          for (const sample of samples) {
            if (sample.t <= cut) windowBaseTokens = sample.tokens;
            else break;
          }
          const otherWindowDeltas = Math.max(0, prevCount - windowBaseTokens);
          const isMidStreamSpike = singleDelta > SPIKE_MIN_TOKENS && (
            (otherWindowDeltas > 0 && singleDelta > otherWindowDeltas)
            || (otherWindowDeltas === 0 && update.at - lastTokenUpdateAt > SPEED_WINDOW_MS)
          );
          if (isMidStreamSpike) {
            liveBaseAt = update.at;
            liveBaseTokens = nextTokens;
            samples = [{ t: update.at, tokens: nextTokens }];
          } else {
            pushSample(update.at, nextTokens);
          }
        }
        lastTokenUpdateAt = update.at;
      }
      return publish(update.at);
    },
    refresh(at: number): boolean {
      lastNow = at;
      if (streaming && liveBaseAt !== undefined) pushSample(at, liveCount());
      return publish(at);
    },
    onAssistantEnd(finalUsage: UsageLike | undefined, at: number): boolean {
      if (at >= lastStreamAt) lastStreamAt = at;
      lastNow = at;
      streaming = false;
      segmentEndedAt = at;
      readUsage(finalUsage, usage);
      const visible = rawStreamTokens > 0 ? streamTokens : liveCount();
      const reported = finiteNumber(finalUsage?.output);
      if (reported !== undefined && reported >= providerOutput) providerOutput = reported;
      if (usage.output === undefined && providerOutput > 0) usage.output = providerOutput;
      const count = reported !== undefined && reported >= DECODE_SPEED_MIN_OUTPUT
        ? reported
        : Math.max(providerOutput, streamTokens);

      if (
        (usage.reasoning === undefined || usage.reasoning === 0)
        && reported !== undefined
        && reported >= 64
        && rawStreamTokens > 0
      ) {
        const rawRatio = reported / rawStreamTokens;
        if (rawRatio > CALIBRATION_MIN && rawRatio < CALIBRATION_MAX) {
          const prevRatio = calibrationRatio();
          const nextRatio = Math.min(
            CALIBRATION_MAX,
            Math.max(CALIBRATION_MIN, prevRatio * (1 - CALIBRATION_ALPHA) + rawRatio * CALIBRATION_ALPHA),
          );
          calibrationRatios.set(currentModelKey, nextRatio);
        }
      }

      if (count > 0 && firstTokenAt === undefined) firstTokenAt = assistantStartedAt ?? at;
      const hiddenOrBurst = count - visible > Math.max(32, 0.35 * count)
        || firstSampleTokens > 0.5 * count
        || firstSampleRawTokens > 0.5 * count;
      decodeStartedAt = hiddenOrBurst ? (assistantStartedAt ?? firstTokenAt) : firstTokenAt;

      const elapsedMs = decodeStartedAt !== undefined ? at - decodeStartedAt : 0;
      const reliable = count >= RELIABLE_MIN_OUTPUT && elapsedMs >= RELIABLE_MIN_ELAPSED_MS;
      lastLive = undefined;
      let average: number | undefined;
      if (reliable) {
        runTokens += count;
        runElapsedMs += elapsedMs;
        average = outputSpeed(runTokens, 0, runElapsedMs);
        if (average !== undefined) {
          displayed = average;
          lastReliable = average;
        }
      } else {
        displayed = lastReliable;
      }
      frozen = collect();
      return average !== undefined;
    },
    noteNested(output: unknown, startedAt: number, endedAt: number): boolean {
      if (displayed !== undefined) return false;
      const rate = outputSpeed(output, startedAt, endedAt);
      if (rate === undefined) return false;
      displayed = rate;
      lastReliable = rate;
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
      lastReliable = undefined;
      lastLive = undefined;
      streaming = false;
      lastPublish = 0;
      lastStreamAt = Number.NEGATIVE_INFINITY;
      lastTokenUpdateAt = Number.NEGATIVE_INFINITY;
      lastNow = 0;
      turnStartedAt = undefined;
      assistantStartedAt = undefined;
      firstTokenAt = undefined;
      decodeStartedAt = undefined;
      segmentEndedAt = undefined;
      providerOutput = 0;
      providerAdvances = 0;
      firstProviderSample = undefined;
      rawStreamTokens = 0;
      streamTokens = 0;
      hasSeenDelta = false;
      firstSampleTokens = 0;
      firstSampleRawTokens = 0;
      liveBaseAt = undefined;
      liveBaseTokens = 0;
      samples = [];
      usage = {};
      frozen = undefined;
      runTokens = 0;
      runElapsedMs = 0;
      currentModelKey = "__default__";
      calibrationRatios.clear();
    },
  };
}
