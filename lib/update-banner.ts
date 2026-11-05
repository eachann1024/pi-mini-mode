import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import type { UiLanguage } from "./settings.ts";

export const UPDATE_RELEASE_DATE = "2026-11-05";
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

interface ReleaseNoteText {
  highlights: string;
  features?: readonly string[];
  fixes?: readonly string[];
}

interface ReleaseEntry {
  version: string;
  date: string;
  zh: ReleaseNoteText;
  en: ReleaseNoteText;
}

export const RELEASE_HISTORY: readonly ReleaseEntry[] = [
  {
    version: "2.0.20",
    date: "2026-11-05",
    zh: {
      highlights: "百轮长对话滚动、输入和点击保持流畅。",
      fixes: [
        "150 轮滚动中位响应由约 271ms 降到 7ms，300 轮由约 585ms 降到 11ms",
        "鼠标悬停按行定位，中文、emoji 和链接命中与原来一致",
        "主题切换和旧消息更新时正确清理显示缓存",
      ],
    },
    en: {
      highlights: "Long conversations stay responsive while scrolling, typing, and clicking.",
      fixes: [
        "Median scroll response for 150 turns dropped from about 271ms to 7ms, and for 300 turns from about 585ms to 11ms",
        "Hover hit testing is per line, with the same results for CJK, emoji, and links",
        "Display caches clear on theme changes and in-place updates to older messages",
      ],
    },
  },
  {
    version: "2.0.19",
    date: "2026-11-05",
    zh: {
      highlights: "长会话更流畅，Token 速度更准，子代理过程可见。",
      features: [
        "原生支持 pi -p 子代理过程树与分步用量，Ctrl+S 展开查看每步 Token 与耗时",
        "升级后首次打开显示一次性更新摘要",
      ],
      fixes: [
        "长会话折叠渲染提速 24×，96 轮会话每帧耗时由 121ms 降至 5ms",
        "修正思考场景下 Token 速度虚高（500+ tok/s）",
      ],
    },
    en: {
      highlights: "Smoother long sessions, more accurate token speed, visible subagent progress.",
      features: [
        "Built-in pi -p subagent tree with per-step usage; press Ctrl+S to inspect tokens and duration",
        "One-time release summary shown on first launch after upgrade",
      ],
      fixes: [
        "24× faster collapsed-turn rendering; 96-turn frame time down from 121ms to 5ms",
        "Fixed inflated token speed (500+ tok/s) while thinking",
      ],
    },
  },
  {
    version: "2.0.18",
    date: "2026-11-05",
    zh: {
      highlights: "图片路径展开更清晰。",
      fixes: ["展开时图片路径与相邻非空白字符之间自动补空格"],
    },
    en: {
      highlights: "Clearer image path expansion.",
      fixes: ["Image paths are padded with spaces on expand when adjacent to non-whitespace"],
    },
  },
  {
    version: "2.0.17",
    date: "2026-11-01",
    zh: {
      highlights: "文件链接体验统一。",
      fixes: ["统一终端文件链接，并增加跨终端可用的悬停反馈"],
    },
    en: {
      highlights: "Consistent file links.",
      fixes: ["Unified terminal file links with portable hover feedback"],
    },
  },
  {
    version: "2.0.16",
    date: "2026-10-28",
    zh: {
      highlights: "思考提示语随界面语言显示。",
      fixes: ["思考兜底文案按所选语言本地化"],
    },
    en: {
      highlights: "Thinking text follows the UI language.",
      fixes: ["Thinking fallback text is localized to the selected language"],
    },
  },
  {
    version: "2.0.15",
    date: "2026-10-18",
    zh: {
      highlights: "Token 速度刷新更及时。",
      fixes: ["Token 速度每秒刷新两次"],
    },
    en: {
      highlights: "More responsive token speed.",
      fixes: ["Token speed refreshes twice a second"],
    },
  },
];

export interface UpdateDay {
  date: string;
  versionLabel: string;
  highlights: string;
  features: string[];
  fixes: string[];
}

function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}

export function resolveUpdateDays(
  currentVersion: string,
  previousVersion?: string,
  language: UiLanguage = "zh",
): UpdateDay[] {
  const lang: UiLanguage = language === "en" ? "en" : "zh";
  let entries = RELEASE_HISTORY.filter(
    entry => isNewerVersion(entry.version, previousVersion) && !isNewerVersion(entry.version, currentVersion),
  );
  if (!previousVersion || entries.length === 0) {
    const latest = RELEASE_HISTORY[0]?.date;
    entries = RELEASE_HISTORY.filter(entry => entry.date === latest);
  }
  const dates = uniq(entries.map(entry => entry.date)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return dates.map(date => {
    const group = entries.filter(entry => entry.date === date);
    const versions = group.map(entry => entry.version);
    const oldest = versions[versions.length - 1];
    const newest = versions[0];
    const versionLabel = oldest === newest ? `v${newest}` : `v${oldest} – v${newest}`;
    const notes = group.map(entry => entry[lang]);
    return {
      date,
      versionLabel,
      highlights: notes.map(n => n.highlights).join(lang === "en" ? " " : ""),
      features: uniq(notes.flatMap(n => n.features ?? [])),
      fixes: uniq(notes.flatMap(n => n.fixes ?? [])),
    };
  });
}

function notesForRelease(version: string, previousVersion: string | undefined, language: UiLanguage): UpdateDay[] {
  if (!previousVersion) {
    const entry = RELEASE_HISTORY.find(item => item.version === version) ?? RELEASE_HISTORY[0];
    if (!entry) return [];
    const note = entry[language];
    return [{
      date: entry.date,
      versionLabel: `v${entry.version}`,
      highlights: note.highlights,
      features: [...(note.features ?? [])],
      fixes: [...(note.fixes ?? [])],
    }];
  }
  return resolveUpdateDays(version, previousVersion, language);
}

export function formatGitHubReleaseNotes(version: string = PACKAGE_VERSION, previousVersion?: string): string {
  const sections: string[] = [];
  for (const lang of ["zh", "en"] as const) {
    const days = notesForRelease(version, previousVersion, lang);
    const zh = lang === "zh";
    const lines: string[] = [];
    for (const day of days) {
      lines.push(`### ${day.date} ${day.versionLabel}`, "");
      lines.push(zh ? `🌈 本次更新重点：${day.highlights}` : `🌈 Highlights: ${day.highlights}`, "");
      if (day.features.length > 0) {
        lines.push(zh ? "✨ 新功能" : "✨ New", "", ...day.features.map(i => `- ${i}`), "");
      }
      if (day.fixes.length > 0) {
        lines.push(zh ? "🐛 修复" : "🐛 Fixes", "", ...day.fixes.map(i => `- ${i}`), "");
      }
    }
    sections.push(lines.join("\n").trimEnd());
  }
  return sections.join("\n\n---\n\n") + "\n";
}

function stripOsc8(text: string): string {
  return text.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

function widthOf(text: string): number {
  return visibleWidth(stripOsc8(text));
}

export function renderUpdateBanner(
  theme: Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">,
  width: number,
  options: { version?: string; previousVersion?: string; language?: UiLanguage; collapsed?: boolean } = {},
): { rows: string[]; headerRows: number } {
  if (width < 24) return { rows: [], headerRows: 0 };
  const version = options.version ?? PACKAGE_VERSION;
  const lang: UiLanguage = options.language ?? "zh";
  const collapsed = options.collapsed ?? false;
  const days = resolveUpdateDays(version, options.previousVersion, lang);
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

  const leftHeader = theme.bold(theme.fg("accent", `pi-mini-mode v${version}`));
  const rightHeader = theme.fg(
    "muted",
    collapsed ? (lang === "en" ? "[Expand]" : "[展开]") : (lang === "en" ? "[Collapse]" : "[收起]"),
  );

  const rows: string[] = [
    topBorder,
    boxLine(splitLine(leftHeader, rightHeader)),
  ];

  if (collapsed) {
    rows.push(bottomBorder);
    return { rows, headerRows: 3 };
  }

  const en = lang === "en";
  days.forEach((day, idx) => {
    rows.push(idx === 0 ? boxLine("") : midBorder);
    rows.push(boxLine(theme.bold(theme.fg("text", day.date)) + "  " + theme.fg("muted", day.versionLabel)));
    const pushWrapped = (text: string) => {
      for (const line of wrapTextWithAnsi(theme.fg("muted", text), innerWidth)) rows.push(boxLine(line));
    };
    pushWrapped(en ? `🌈 Highlights: ${day.highlights}` : `🌈 本次更新重点：${day.highlights}`);
    if (day.features.length > 0) {
      rows.push(boxLine(theme.bold(theme.fg("text", en ? "✨ New" : "✨ 新功能"))));
      for (const item of day.features) pushWrapped(`- ${item}`);
    }
    if (day.fixes.length > 0) {
      rows.push(boxLine(theme.bold(theme.fg("text", en ? "🐛 Fixes" : "🐛 修复"))));
      for (const item of day.fixes) pushWrapped(`- ${item}`);
    }
  });

  rows.push(bottomBorder);
  return { rows, headerRows: 3 };
}
