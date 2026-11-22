import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ansiColor, type RGB } from "./minimal-theme.ts";

export type BadgeStyle = "round" | "square";
export type BadgeTone = "success" | "error" | "warning" | "action" | "info" | "muted";

export type BadgeThemeLike = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold"> & {
  getBgAnsi?(token: "userMessageBg" | "selectedBg"): string;
  getColorMode?(): string;
};

export interface ParsedSemanticBadge {
  tone: BadgeTone;
  label: string;
}

const CAP_LEFT = "\uE0B6";
const CAP_RIGHT = "\uE0B4";

export function isBadgeStyle(value: unknown): value is BadgeStyle {
  return value === "round" || value === "square";
}

const KEYWORD_TONES = new Map<string, { tone: BadgeTone; prefix?: string }>([
  ["亲眼确认", { tone: "success" }],
  ["已确认", { tone: "success" }],
  ["已观测", { tone: "success" }],
  ["实测", { tone: "success" }],
  ["实锤", { tone: "success" }],
  ["正常", { tone: "success" }],
  ["通过", { tone: "success" }],
  ["完成", { tone: "success" }],
  ["推荐", { tone: "success", prefix: "★ " }],
  ["observed", { tone: "success" }],
  ["verified", { tone: "success" }],
  ["confirmed", { tone: "success" }],
  ["done", { tone: "success" }],
  ["passed", { tone: "success" }],
  ["recommended", { tone: "success", prefix: "★ " }],

  ["失败", { tone: "error" }],
  ["卡住", { tone: "error" }],
  ["阻断", { tone: "error" }],
  ["高风险", { tone: "error", prefix: "! " }],
  ["高危", { tone: "error", prefix: "! " }],
  ["破坏性", { tone: "error", prefix: "! " }],
  ["failed", { tone: "error" }],
  ["blocked", { tone: "error" }],
  ["destructive", { tone: "error", prefix: "! " }],
  ["high risk", { tone: "error", prefix: "! " }],
  ["high-risk", { tone: "error", prefix: "! " }],

  ["还没查", { tone: "warning", prefix: "? " }],
  ["未验证", { tone: "warning", prefix: "? " }],
  ["待核实", { tone: "warning", prefix: "? " }],
  ["待查", { tone: "warning", prefix: "? " }],
  ["盲区", { tone: "warning", prefix: "? " }],
  ["unverified", { tone: "warning", prefix: "? " }],
  ["unchecked", { tone: "warning", prefix: "? " }],

  ["等你定", { tone: "action", prefix: "● " }],
  ["待拍板", { tone: "action", prefix: "● " }],
  ["待决策", { tone: "action", prefix: "● " }],
  ["需确认", { tone: "action", prefix: "● " }],
  ["decision", { tone: "action" }],
  ["needs you", { tone: "action", prefix: "● " }],
  ["needs-you", { tone: "action", prefix: "● " }],

  ["合理推测", { tone: "info" }],
  ["推断", { tone: "info" }],
  ["推测", { tone: "info" }],
  ["排查完毕", { tone: "info" }],
  ["共享", { tone: "info" }],
  ["共享表", { tone: "info" }],
  ["跨服务共享", { tone: "info" }],
  ["影响用户", { tone: "info" }],
  ["影响范围", { tone: "info" }],
  ["关联影响", { tone: "info" }],
  ["外部影响", { tone: "info" }],
  ["折中", { tone: "info" }],
  ["inferred", { tone: "info" }],
  ["investigate", { tone: "info" }],
  ["shared", { tone: "info" }],
  ["impact", { tone: "info" }],

  ["跳过", { tone: "muted", prefix: "» " }],
  ["未执行", { tone: "muted", prefix: "» " }],
  ["skipped", { tone: "muted", prefix: "» " }],
]);

const HAS_WORD_CHAR = /[\p{L}\u4e00-\u9fff]/u;

export function parseSemanticBadge(raw: string): ParsedSemanticBadge | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner || inner.length > 32 || /[\r\n`[\]"]/.test(inner) || !HAS_WORD_CHAR.test(inner)) return undefined;

  if (/^(?:✓|✔|★)\s*\S/.test(inner)) return { tone: "success", label: inner.replace(/^(✓|✔|★)\s*/, "$1 ") };
  if (/^(?:×|✕)\s*\S/.test(inner)) return { tone: "error", label: inner.replace(/^(×|✕)\s*/, "$1 ") };
  if (/^[?？]\s*\S/.test(inner)) return { tone: "warning", label: `? ${inner.slice(1).trim()}` };
  if (/^(?:●|⑂)\s*\S/.test(inner)) return { tone: "action", label: inner.replace(/^(●|⑂)\s*/, "$1 ") };
  if (/^~\s*\S/.test(inner)) return { tone: "info", label: `~ ${inner.slice(1).trim()}` };
  if (/^(?:»|⏭)\s*\S/.test(inner)) return { tone: "muted", label: `» ${inner.slice(1).trim()}` };
  if (/^!\s+\S/.test(inner)) return { tone: "error", label: `! ${inner.slice(1).trim()}` };

  if (inner.startsWith("!")) {
    const body = inner.slice(1).trim();
    if (!body) return undefined;
    const hit = KEYWORD_TONES.get(body.toLowerCase());
    if (hit) return { tone: hit.tone, label: hit.prefix && !body.startsWith(hit.prefix.trim()) ? `${hit.prefix}${body}` : body };
  }
  return undefined;
}

export function isDecisionBadgeText(source: string): boolean {
  for (const match of source.matchAll(/\[[^\]\r\n`]{1,32}\]/g)) {
    if (parseSemanticBadge(match[0])?.tone === "action") return true;
  }
  return false;
}

type BadgeRewrite = (candidate: string, parsed: ParsedSemanticBadge, inCode: boolean) => string | undefined;

function rewriteInlineSegment(line: string, rewrite: BadgeRewrite): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let ticks = 1;
      while (line[index + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const close = line.indexOf(fence, index + ticks);
      if (close < 0) {
        result += line.slice(index);
        break;
      }
      const inner = line.slice(index + ticks, close).trim();
      const parsed = inner.length <= 34 ? parseSemanticBadge(inner) : undefined;
      result += (parsed && rewrite(inner, parsed, true)) ?? line.slice(index, close + ticks);
      index = close + ticks;
      continue;
    }
    if (line[index] === "[" && line[index - 1] !== "!" && line[index - 1] !== "\\") {
      const close = line.indexOf("]", index + 1);
      if (close > index + 1 && close - index <= 34) {
        const next = line[close + 1] ?? "";
        const candidate = line.slice(index, close + 1);
        const parsed = next !== "(" && next !== "[" && next !== ":" ? parseSemanticBadge(candidate) : undefined;
        if (parsed) {
          result += rewrite(candidate, parsed, false) ?? candidate;
          index = close + 1;
          continue;
        }
      }
    }
    result += line[index];
    index++;
  }
  return result;
}

/** Apply a badge rewrite to prose lines, leaving fenced code blocks and reference definitions alone. */
function rewriteSemanticBadges(source: string, rewrite: BadgeRewrite): string {
  if (!source.includes("[")) return source;
  const lines = source.split("\n");
  let fenceChar = "";
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && /^ {0,3}[`~]+[ \t]*$/.test(line)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar || /^ {0,3}\[[^\]]+\]:/.test(line) || !line.includes("[")) continue;
    lines[i] = rewriteInlineSegment(line, rewrite);
  }
  return lines.join("\n");
}

/** Wrap standalone semantic badge tokens outside code fences and links into inline code spans. */
export function transformSemanticBadges(source: string): string {
  return rewriteSemanticBadges(source, (candidate, _parsed, inCode) => (inCode ? undefined : `\`${candidate}\``));
}

const PLAIN_ICON: Record<BadgeTone, string> = {
  success: "✅", error: "❌", warning: "❓", action: "👉", info: "🔎", muted: "⏭️",
};

/** Emoji + text form of a badge for surfaces that cannot paint pills. */
export function plainBadgeLabel(parsed: ParsedSemanticBadge): string {
  const raw = parsed.label.trim();
  const text = raw.replace(/^(?:[✓✔★×✕?？●⑂~»⏭!]\s*)+/u, "").trim() || raw;
  let icon = PLAIN_ICON[parsed.tone];
  if (raw.startsWith("★")) icon = "⭐";
  else if (parsed.tone === "error" && raw.startsWith("!")) icon = "⚠️";
  return `${icon} ${text}`;
}

/** Degrade badge tokens (bare or backtick-wrapped) to bold emoji text, e.g. history shown without pills. */
export function plainSemanticBadges(source: string): string {
  return rewriteSemanticBadges(source, (_candidate, parsed) => `**${plainBadgeLabel(parsed)}**`);
}

const DARK_PALETTE: Record<BadgeTone, { bg: RGB; fg: RGB }> = {
  success: { bg: [22, 56, 40], fg: [134, 239, 172] },
  error: { bg: [67, 25, 36], fg: [253, 164, 175] },
  warning: { bg: [63, 43, 18], fg: [253, 224, 71] },
  action: { bg: [59, 38, 20], fg: [253, 186, 116] },
  info: { bg: [23, 46, 77], fg: [147, 197, 253] },
  muted: { bg: [39, 38, 48], fg: [212, 212, 216] },
};

const LIGHT_PALETTE: Record<BadgeTone, { bg: RGB; fg: RGB }> = {
  success: { bg: [220, 252, 231], fg: [20, 83, 45] },
  error: { bg: [255, 228, 230], fg: [136, 19, 55] },
  warning: { bg: [254, 243, 199], fg: [120, 53, 15] },
  action: { bg: [255, 237, 213], fg: [124, 45, 18] },
  info: { bg: [219, 234, 254], fg: [30, 58, 138] },
  muted: { bg: [236, 234, 242], fg: [63, 61, 71] },
};

const FALLBACK_TOKEN: Record<BadgeTone, "success" | "error" | "warning" | "accent" | "muted"> = {
  success: "success",
  error: "error",
  warning: "warning",
  action: "warning",
  info: "accent",
  muted: "muted",
};

function mixRgb(a: RGB, b: RGB, weight: number): RGB {
  return [
    Math.round(a[0] * (1 - weight) + b[0] * weight),
    Math.round(a[1] * (1 - weight) + b[1] * weight),
    Math.round(a[2] * (1 - weight) + b[2] * weight),
  ];
}

function toCube256(rgb: RGB): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const indices = rgb.map((value) =>
    levels.reduce((best, level, i) => (Math.abs(level - value) < Math.abs(levels[best] - value) ? i : best), 0),
  );
  return 16 + indices[0] * 36 + indices[1] * 6 + indices[2];
}

function ansiFg(rgb: RGB, mode?: string): string {
  return mode === "256color" ? `\x1b[38;5;${toCube256(rgb)}m` : `\x1b[38;2;${rgb.join(";")}m`;
}

function ansiBg(rgb: RGB, mode?: string): string {
  return mode === "256color" ? `\x1b[48;5;${toCube256(rgb)}m` : `\x1b[48;2;${rgb.join(";")}m`;
}

export function renderSemanticBadge(raw: string, theme: BadgeThemeLike, style: BadgeStyle = "round"): string | undefined {
  const parsed = parseSemanticBadge(raw);
  if (!parsed) return undefined;
  const token = FALLBACK_TOKEN[parsed.tone];
  const themeAccentRgb = ansiColor(theme.fg(token, ""));
  const surfaceRgb = ansiColor(theme.getBgAnsi?.("userMessageBg") ?? "");
  if (!themeAccentRgb && !surfaceRgb) {
    return theme.fg(token, theme.bold(`[${parsed.label}]`));
  }
  const isLight = surfaceRgb ? (0.299 * surfaceRgb[0] + 0.587 * surfaceRgb[1] + 0.114 * surfaceRgb[2]) >= 140 : false;
  const preset = (isLight ? LIGHT_PALETTE : DARK_PALETTE)[parsed.tone];
  const bg = themeAccentRgb ? mixRgb(preset.bg, themeAccentRgb, 0.15) : preset.bg;
  const fg = themeAccentRgb ? mixRgb(preset.fg, themeAccentRgb, 0.2) : preset.fg;
  const mode = theme.getColorMode?.();
  const bgCode = ansiBg(bg, mode);
  const fgCode = ansiFg(fg, mode);
  if (style === "round") {
    const capFg = ansiFg(bg, mode);
    return `\x1b[49m${capFg}${CAP_LEFT}${bgCode}${fgCode}\x1b[1m${parsed.label}\x1b[22m\x1b[49m${capFg}${CAP_RIGHT}\x1b[39m`;
  }
  return `${bgCode}${fgCode}\x1b[1m ${parsed.label} \x1b[22m\x1b[49m\x1b[39m`;
}
