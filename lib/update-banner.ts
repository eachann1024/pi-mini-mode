import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import type { UiLanguage } from "./settings.ts";

export const UPDATE_RELEASE_DATE = "2026-11-04";
const MIN_BANNER_VERSION = "2.0.19";

export function isNewerVersion(current: string, previous?: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(current)) return false;
  if (!previous) return true;
  if (!/^\d+\.\d+\.\d+$/.test(previous)) return false;
  const curParts = current.split(".").map(Number);
  const prevParts = previous.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (curParts[i] !== prevParts[i]) return curParts[i] > prevParts[i];
  }
  return false;
}

function readPackageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && /^\d+\.\d+\.\d+$/.test(raw.version)) {
      return isNewerVersion(raw.version, MIN_BANNER_VERSION) ? raw.version : MIN_BANNER_VERSION;
    }
  } catch {
    // Fallback to MIN_BANNER_VERSION when package.json cannot be read.
  }
  return MIN_BANNER_VERSION;
}

export const PACKAGE_VERSION: string = readPackageVersion();

interface UpdateNoteItem {
  title: string;
  desc: string;
}

const UPDATE_ITEMS: Record<UiLanguage, readonly UpdateNoteItem[]> = {
  zh: [
    {
      title: "长会话折叠不卡顿（渲染提速 24×）",
      desc: "已完成的折叠轮次直接复用整块渲染结果并平移鼠标坐标，96 轮长会话每帧耗时由 121ms 降至 5ms。",
    },
    {
      title: "思考场景 Token 速度准确度修复",
      desc: "识别代理整块缓冲的思考突发，改从消息起点计算速度并结合 2.5s 滑窗与 EMA 校准，修正 500+ tok/s 虚高。",
    },
    {
      title: "原生支持 pi -p 子代理过程树与分步用量",
      desc: "无需安装 pi-subagents 即可将 shell 中的 pi -p 调用收纳为子代理行，支持 Ctrl+S 展开查看每步 Token 与耗时。",
    },
  ],
  en: [
    {
      title: "24× Faster Long-Session Rendering",
      desc: "Completed collapsed turns reuse cached block renders with translated mouse coordinates, cutting 96-turn frame time from 121ms to 5ms.",
    },
    {
      title: "Accurate Token Speed with Thinking",
      desc: "Detects buffered thinking bursts, measures from message start, and applies a 2.5s sliding window with EMA calibration.",
    },
    {
      title: "Built-in pi -p Subagent Tree & Step Usage",
      desc: "Collects shell pi -p calls into subagent rows without pi-subagents; press Ctrl+S to inspect per-step tokens and duration.",
    },
  ],
};

function stripOsc8(text: string): string {
  return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

function widthOf(text: string): number {
  return visibleWidth(stripOsc8(text));
}

export function renderUpdateBanner(
  theme: Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">,
  width: number,
  options: { version?: string; language?: UiLanguage; collapsed?: boolean } = {},
): { rows: string[]; headerRows: number } {
  if (width < 24) return { rows: [], headerRows: 0 };
  const version = options.version ?? PACKAGE_VERSION;
  const lang: UiLanguage = options.language ?? "zh";
  const collapsed = options.collapsed ?? false;
  const items = UPDATE_ITEMS[lang] ?? UPDATE_ITEMS.zh;
  const innerWidth = Math.max(1, width - 6);
  const borderV = theme.fg("dim", "│");
  const topBorder = theme.fg("dim", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
  const midBorder = theme.fg("dim", "├" + "─".repeat(Math.max(0, width - 2)) + "┤");
  const bottomBorder = theme.fg("dim", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");

  const boxLine = (content: string): string => {
    const w = widthOf(content);
    const fitted = w > innerWidth ? truncateToWidth(stripOsc8(content), innerWidth, "…") : content;
    const pad = Math.max(0, innerWidth - widthOf(fitted));
    return `${borderV}  ${fitted}${" ".repeat(pad)}  ${borderV}`;
  };

  const splitLine = (left: string, right: string, rightHref?: string): string => {
    const lw = widthOf(left);
    const rw = widthOf(right);
    if (lw + 2 + rw <= innerWidth) {
      const gap = " ".repeat(innerWidth - lw - rw);
      const linkedRight = rightHref ? `\x1b]8;;${rightHref}\x07${right}\x1b]8;;\x07` : right;
      return `${left}${gap}${linkedRight}`;
    }
    if (rw + 4 <= innerWidth) {
      const truncatedLeft = truncateToWidth(stripOsc8(left), Math.max(1, innerWidth - rw - 2), "…");
      const gap = " ".repeat(Math.max(1, innerWidth - widthOf(truncatedLeft) - rw));
      const linkedRight = rightHref ? `\x1b]8;;${rightHref}\x07${right}\x1b]8;;\x07` : right;
      return `${truncatedLeft}${gap}${linkedRight}`;
    }
    return truncateToWidth(stripOsc8(left), innerWidth, "…");
  };

  const leftHeader = theme.bold(
    theme.fg("accent", lang === "en" ? `pi-mini-mode v${version} Release Notes` : `pi-mini-mode v${version} 更新摘要`),
  );
  const rightHeader = theme.fg(
    "muted",
    collapsed
      ? (lang === "en" ? `${UPDATE_RELEASE_DATE} · ${items.length} updates · [Expand]` : `${UPDATE_RELEASE_DATE} · ${items.length} 项更新 · [展开]`)
      : (lang === "en" ? `${UPDATE_RELEASE_DATE} · ${items.length} updates` : `${UPDATE_RELEASE_DATE} · ${items.length} 项更新`),
  );

  const rows: string[] = [
    topBorder,
    boxLine(splitLine(leftHeader, rightHeader)),
  ];

  if (collapsed) {
    rows.push(bottomBorder);
    return { rows, headerRows: 3 };
  }

  rows.push(boxLine(""));
  for (let idx = 0; idx < items.length; idx++) {
    if (idx > 0) rows.push(boxLine(""));
    const item = items[idx];
    rows.push(boxLine(theme.bold(theme.fg("text", `${idx + 1}. ${item.title}`))));
    const wrapped = wrapTextWithAnsi(theme.fg("muted", item.desc), innerWidth);
    for (const line of wrapped) {
      rows.push(boxLine(line));
    }
  }

  rows.push(midBorder);
  const leftFooter = theme.fg(
    "muted",
    lang === "en" ? "Scrolls up with chat · Click header to fold" : "发消息后自动随会话向上滚动 · 点击标题栏可随时折叠",
  );
  const rightFooter = theme.fg("accent", `GitHub Release v${version} ↗`);
  const releaseUrl = `https://github.com/eachann1024/pi-mini-mode/releases/tag/v${version}`;
  rows.push(boxLine(splitLine(leftFooter, rightFooter, releaseUrl)));
  rows.push(bottomBorder);

  return { rows, headerRows: 3 };
}
