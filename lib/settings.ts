import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETTINGS_FILE_NAME = "pi-mini-mode.json";

export interface MiniLensSettings {
  "pi-mini-mode-model-show": boolean;
  "pi-mini-mode-thinking-show": boolean;
  "pi-mini-mode-project-branch-show": boolean;
  "pi-mini-mode-branch-show": boolean;
  "pi-mini-mode-ch-show": boolean;
  "pi-mini-mode-session-tokens-show": boolean;
  "pi-mini-mode-cache-tokens-show": boolean;
  "pi-mini-mode-cache-miss-show": boolean;
  "pi-mini-mode-cost-show": boolean;
  "pi-mini-mode-mcp-show": boolean;
  "pi-mini-mode-context-show": boolean;
  "pi-mini-mode-context-dots-show": boolean;
  "pi-mini-mode-context-percent-show": boolean;
  "pi-mini-mode-speed-show": boolean;
  "pi-mini-mode-speed-unit-show": boolean;
  "pi-mini-mode-minimal-show": boolean;
  "pi-mini-mode-minimal-record-limit": number;
  "pi-mini-mode-input-enhancements": boolean;
  "pi-mini-mode-image-preview": "hover" | "inline";
  onboardingCompleted: boolean;
  footerOrder?: string[];
}

export const DEFAULT_SETTINGS: Readonly<MiniLensSettings> = {
  "pi-mini-mode-model-show": true,
  "pi-mini-mode-thinking-show": true,
  "pi-mini-mode-project-branch-show": true,
  "pi-mini-mode-branch-show": false,
  "pi-mini-mode-ch-show": true,
  "pi-mini-mode-session-tokens-show": true,
  "pi-mini-mode-cache-tokens-show": false,
  "pi-mini-mode-cache-miss-show": true,
  "pi-mini-mode-cost-show": true,
  "pi-mini-mode-mcp-show": false,
  "pi-mini-mode-context-show": true,
  "pi-mini-mode-context-dots-show": true,
  "pi-mini-mode-context-percent-show": true,
  "pi-mini-mode-speed-show": true,
  "pi-mini-mode-speed-unit-show": true,
  "pi-mini-mode-minimal-show": true,
  "pi-mini-mode-minimal-record-limit": 6,
  "pi-mini-mode-input-enhancements": true,
  "pi-mini-mode-image-preview": "inline",
  onboardingCompleted: false,
};

export const SETTING_IDS = Object.keys(DEFAULT_SETTINGS) as Array<Exclude<keyof MiniLensSettings, "footerOrder">>;
export const FOOTER_FIELDS = ["project-branch", "model", "thinking", "branch", "session-tokens", "cache-tokens", "cache-miss", "ch", "cost", "mcp", "context", "context-percent", "speed"] as const;
export const FOOTER_STYLE_OPTIONS = ["context-dots", "speed-unit"] as const;

export const COPY = {
  preview: "预览（示例数据）", minimal: "极简输出",
  model: "显示模型", thinking: "显示思考等级", total: "显示会话总 token", cached: "显示会话缓存 token", miss: "显示缓存 miss", totalLabel: "Total", cachedLabel: "Cached", cacheHitLabel: "CH", cacheHit: "显示缓存命中率 (CH)", price: "显示会话价格", mcp: "显示已启用 MCP 服务器", context: "显示上下文 token 与进度条", dots: "↳ 使用点阵进度条", percent: "显示上下文百分比", speed: "显示最近生成速度", speedUnit: "↳ 显示 tok/s 单位", inputEnhancements: "输入增强",
  totalDescription: "Total：当前会话分支上的全部 token，含工具上报的 LLM 用量。", cachedDescription: "Cached：累计 cache-read + cache-write token（包含在 Total 中）。", cacheHitDescription: "CH（cache hit）：cache-read / (input + cache-read)。Cache write 不计入此比率。",
  enableMinimalDescription: "开启统一折叠思考、工具和技能过程；关闭恢复 Pi 默认会话历史。",
  inputEnhancementsDescription: "原生 Ctrl+V 粘贴图片（Windows/WSL：Alt+V）；图片显示为 [image1] 标签，默认在输入框上方显示内联卡片（可切换光标悬停模式）。空白后 / 选择技能并在光标处插入。Cmd+点击带下划线的图片标签或消息文件路径，用系统默认应用打开；预览及点击需终端支持。关闭仅恢复原生行为。",
  tuiRequired: "/pi-mini-mode-settings 需要 TUI 模式", saveFailed: "无法保存 Pi Mini Mode 设置", onboarding: "默认开启输入增强和极简输出；极简输出需要全屏模式。仅显示分支、缓存 token 和 MCP 服务数默认关闭。选择「打开浏览器设置」可调整字段、预览方式和功能开关；推荐配置会保存主题和全屏模式。以后可用 /pi-mini-mode-settings 修改。", keepDefaults: "保留默认", configureNow: "打开浏览器设置", applyRecommended: "应用推荐配置", chooseTheme: "选择主题（主题立即应用；全屏模式需重启 Pi）", themeSaved: "已保存主题和全屏模式。请重启 Pi 以启用全屏；项目设置或命令行参数可能覆盖全局设置。", themeSaveFailed: "无法保存推荐的 Pi 主题和全屏模式；未完成首次配置。", themeApplyFailed: "推荐设置已保存，但当前主题未能立即应用；请重启 Pi。",
} as const;

export const RECOMMENDED_THEMES = ["cc-dark", "cc-light"] as const;
export type RecommendedTheme = typeof RECOMMENDED_THEMES[number];

export function settingsPath(agentDir = process.env.PI_MINI_MODE_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent")): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isRecordLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseSettings(value: unknown): MiniLensSettings {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const id of SETTING_IDS) {
    if (id === "pi-mini-mode-image-preview") {
      if (candidate[id] === "hover" || candidate[id] === "inline") settings[id] = candidate[id];
    } else if (id === "pi-mini-mode-minimal-record-limit") {
      if (isRecordLimit(candidate[id])) settings[id] = candidate[id];
    } else if (isBoolean(candidate[id])) settings[id] = candidate[id];
  }
  if (Array.isArray(candidate.footerOrder)) {
    settings.footerOrder = [...new Set(candidate.footerOrder.filter((id): id is typeof FOOTER_FIELDS[number] =>
      typeof id === "string" && (FOOTER_FIELDS as readonly string[]).includes(id)))];
    for (const id of FOOTER_FIELDS) if (!settings.footerOrder.includes(id)) settings.footerOrder.push(id);
  }
  if (settings["pi-mini-mode-branch-show"]) settings["pi-mini-mode-project-branch-show"] = false;
  return settings;
}

/** Rewrite missing defaults, retired switches, and normalized footer order once on load. */
export function settingsNeedBackfill(raw: unknown, parsed: MiniLensSettings): boolean {
  if (!raw || typeof raw !== "object") return true;
  const candidate = raw as Record<string, unknown>;
  for (const id of SETTING_IDS) {
    if (!Object.hasOwn(candidate, id)) return true;
  }
  if (LEGACY_MINIMAL_SETTING_IDS.some(id => Object.hasOwn(candidate, id))) return true;
  if (!Array.isArray(candidate.footerOrder)) return false;
  return JSON.stringify(candidate.footerOrder) !== JSON.stringify(parsed.footerOrder);
}

export async function loadSettings(path = settingsPath()): Promise<{ settings: MiniLensSettings; exists: boolean; backfilled: boolean }> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const settings = parseSettings(raw);
    return { settings, exists: true, backfilled: settingsNeedBackfill(raw, settings) };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, exists: false, backfilled: false };
  }
}

export async function saveSettings(settings: MiniLensSettings, path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export const LEGACY_MINIMAL_SETTING_IDS = [
  "pi-mini-mode-minimal-thinking-show", "pi-mini-mode-minimal-tools-show", "pi-mini-mode-minimal-output-show",
  "pi-mini-mode-minimal-skills-show", "pi-mini-mode-agent-usage-show", "pi-mini-mode-agent-shortcut-show",
] as const;

export function isLegacyMinimalSetting(id: string): boolean {
  return (LEGACY_MINIMAL_SETTING_IDS as readonly string[]).includes(id);
}

export function settingsItems(settings: MiniLensSettings): SettingItem[] {
  const values = ["on", "off"];
  const labels: Record<Exclude<keyof MiniLensSettings, "onboardingCompleted" | "footerOrder" | "pi-mini-mode-image-preview" | "pi-mini-mode-minimal-record-limit">, string> = {
    "pi-mini-mode-project-branch-show": "显示项目名称和分支（互斥）",
    "pi-mini-mode-branch-show": "仅显示分支（思考等级后，互斥）",
    "pi-mini-mode-model-show": COPY.model, "pi-mini-mode-thinking-show": COPY.thinking, "pi-mini-mode-session-tokens-show": COPY.total, "pi-mini-mode-cache-tokens-show": COPY.cached, "pi-mini-mode-cache-miss-show": COPY.miss, "pi-mini-mode-ch-show": COPY.cacheHit, "pi-mini-mode-cost-show": COPY.price, "pi-mini-mode-mcp-show": COPY.mcp, "pi-mini-mode-context-show": COPY.context, "pi-mini-mode-context-dots-show": COPY.dots, "pi-mini-mode-context-percent-show": COPY.percent, "pi-mini-mode-speed-show": COPY.speed, "pi-mini-mode-speed-unit-show": COPY.speedUnit, "pi-mini-mode-minimal-show": COPY.minimal, "pi-mini-mode-input-enhancements": COPY.inputEnhancements,
  };
  return (Object.keys(labels) as Array<keyof typeof labels>).map((id) => ({
    id, label: labels[id],
    description: id === "pi-mini-mode-minimal-show" ? COPY.enableMinimalDescription : id === "pi-mini-mode-input-enhancements" ? COPY.inputEnhancementsDescription : id === "pi-mini-mode-session-tokens-show" ? COPY.totalDescription : id === "pi-mini-mode-cache-tokens-show" ? COPY.cachedDescription : id === "pi-mini-mode-ch-show" ? COPY.cacheHitDescription : undefined,
    currentValue: settings[id] ? values[0] : values[1], values,
  }));
}
