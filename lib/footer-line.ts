import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { COPY, type MiniLensSettings } from "./settings.ts";
import { cacheHit, finiteNumber, formatSpeed, formatTokens, formatUsd, speedColor, type CacheWaste, type SessionUsage } from "./usage.ts";

const PLANNOTATOR_STATUS_KEY = "plannotator";
const PLANNOTATOR_PLANNING_LABEL = "⏸ plan";
const PLAN_CAP_LEFT = "\uE0B6";
const PLAN_CAP_RIGHT = "\uE0B4";
const PLAN_BG = "250;204;21";
const PLAN_FG = "19;18;23";

function plannotatorStatusText(text: string | undefined): string {
  return stripVTControlCharacters(text ?? "").replace(/\s+/g, " ").trim();
}

/** Exact plannotator planning label from @plannotator/pi-extension (`⏸ plan`). */
export function isPlannotatorPlanningStatus(text: string | undefined): boolean {
  return plannotatorStatusText(text) === PLANNOTATOR_PLANNING_LABEL;
}

/** Scheme B PLAN capsule. visibleWidth===1 only protects columns; it is not a font check. */
export function planCapsule(): string {
  const paint = (text: string) => `\x1b[48;2;${PLAN_BG}m\x1b[38;2;${PLAN_FG}m${text}\x1b[39m\x1b[49m`;
  if (visibleWidth(PLAN_CAP_LEFT) === 1 && visibleWidth(PLAN_CAP_RIGHT) === 1) {
    const cap = (ch: string) => `\x1b[38;2;${PLAN_BG}m${ch}\x1b[39m`;
    return `${cap(PLAN_CAP_LEFT)}${paint("PLAN")}${cap(PLAN_CAP_RIGHT)}`;
  }
  return paint(" PLAN ");
}

function plannotatorPlanTag(statuses: ReadonlyMap<string, string> | undefined): string {
  const text = statuses?.get(PLANNOTATOR_STATUS_KEY);
  return isPlannotatorPlanningStatus(text) ? planCapsule() : "";
}

function progressBar(percent: number, dots: boolean, width: number): string {
  const filled = Math.round(width * Math.max(0, Math.min(100, percent)) / 100);
  return (dots ? "⣿" : "█").repeat(filled) + (dots ? "⣀" : "░").repeat(width - filled);
}

function renderRight(
  theme: ExtensionContext["ui"]["theme"],
  settings: MiniLensSettings,
  percentText: string,
  speed: number | undefined,
  highlighted?: keyof MiniLensSettings,
): string {
  const fields: string[] = [];
  if (settings["pi-mini-mode-context-percent-show"] && percentText) fields.push(highlighted === "pi-mini-mode-context-percent-show" ? theme.bg("selectedBg", theme.fg("accent", theme.bold(percentText))) : theme.fg("accent", percentText));
  if (settings["pi-mini-mode-speed-show"] && speed !== undefined) {
    const text = formatSpeed(speed, settings["pi-mini-mode-speed-unit-show"]);
    fields.push(highlighted === "pi-mini-mode-speed-show" || highlighted === "pi-mini-mode-speed-unit-show"
      ? theme.bg("selectedBg", theme.fg("accent", theme.bold(text)))
      : theme.fg(speedColor(speed), text));
  }
  return fields.join("  ");
}

const SETTINGS_PREVIEW_CONTEXT = {
  cwd: "/work/pi-mini-mode",
  model: { id: "deepseek-v4-flash" },
  thinkingLevel: "high",
  getContextUsage: () => ({ tokens: 500, contextWindow: 1_000_000, percent: 1 }),
} as unknown as ExtensionContext;

const SETTINGS_PREVIEW_USAGE: SessionUsage = {
  totalTokens: 45_000,
  input: 15_000,
  output: 5_000,
  cacheRead: 10_000,
  cacheWrite: 15_000,
  cost: 0.012,
};

export function settingsPreviewLine(
  theme: ExtensionContext["ui"]["theme"],
  settings: MiniLensSettings,
  width = 140,
  highlighted?: keyof MiniLensSettings,
): string {
  return statusLine(SETTINGS_PREVIEW_CONTEXT, theme, width, SETTINGS_PREVIEW_USAGE, settings, 120, highlighted, 3, undefined, "main");
}

export function statusLine(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  usageTotals: SessionUsage,
  settings: MiniLensSettings,
  speed: number | undefined,
  highlighted?: keyof MiniLensSettings,
  mcpCount?: number,
  statuses?: ReadonlyMap<string, string>,
  gitBranch?: string | null,
  waste?: CacheWaste,
): string {
  if (highlighted === "pi-mini-mode-context-dots-show") highlighted = "pi-mini-mode-context-show";
  const field = (id: keyof MiniLensSettings, color: Parameters<typeof theme.fg>[0], text: string) =>
    id === highlighted ? theme.bg("selectedBg", theme.fg("accent", theme.bold(text))) : theme.fg(color, text);
  if (width <= 0) return "";
  const model = ctx.model?.id ?? "";
  const thinking = ctx.thinkingLevel ?? "";
  const hit = cacheHit(usageTotals);
  const hitText = hit === undefined ? "" : `${COPY.cacheHitLabel} ${hit.toFixed(1)}%`;
  const cachedTokens = usageTotals.cacheRead + usageTotals.cacheWrite;
  const missText = settings["pi-mini-mode-cache-miss-show"] && waste && waste.missCount > 0 ? `Miss ${formatTokens(waste.missedTokens)}` : "";
  const price = usageTotals.cost > 0 ? formatUsd(usageTotals.cost) : "";
  const contextUsage = ctx.getContextUsage();
  const tokens = finiteNumber(contextUsage?.tokens);
  const contextWindow = finiteNumber(contextUsage?.contextWindow);
  const rawPercent = finiteNumber(contextUsage?.percent);
  const percent = rawPercent === undefined ? undefined : Math.max(0, Math.min(100, rawPercent));
  const percentText = percent === undefined ? "" : `${Math.round(percent)}%`;
  const tokenText = tokens === undefined || contextWindow === undefined ? "" : `${formatTokens(Math.max(0, tokens))}/${formatTokens(Math.max(0, contextWindow))}`;
  const showContext = settings["pi-mini-mode-context-show"] && Boolean(tokenText);
  const mcpText = settings["pi-mini-mode-mcp-show"] && mcpCount !== undefined ? `◇ MCP ${mcpCount}` : "";
  const planTag = plannotatorPlanTag(statuses);
  const branchOnly = settings["pi-mini-mode-branch-show"];
  const branchSetting = branchOnly ? "pi-mini-mode-branch-show" : "pi-mini-mode-project-branch-show";
  const branchText = gitBranch && settings[branchSetting]
    ? stripVTControlCharacters(branchOnly ? gitBranch : `${basename(ctx.cwd)}(${gitBranch})`).replace(/[\x00-\x1f\x7f-\x9f]/g, "") : "";

  if (settings.footerOrder) {
    const values: Record<string, string> = {
      "project-branch": !branchOnly ? branchText : "", branch: branchOnly ? branchText : "",
      model, thinking,
      "session-tokens": usageTotals.totalTokens > 0 ? `${COPY.totalLabel} ${formatTokens(usageTotals.totalTokens)}` : "",
      "cache-tokens": cachedTokens > 0 ? `${COPY.cachedLabel} ${formatTokens(cachedTokens)}` : "",
      "cache-miss": missText,
      ch: hitText, cost: price, mcp: mcpText,
      context: tokenText,
      "context-percent": percentText, speed: speed === undefined ? "" : formatSpeed(speed, settings["pi-mini-mode-speed-unit-show"]),
    };
    const visible = settings.footerOrder.filter(id => settings[`pi-mini-mode-${id}-show` as keyof MiniLensSettings] && values[id]);
    const usedWidth = visibleWidth([planTag, ...visible.map(id => values[id])].filter(Boolean).join("  "));
    const barWidth = Math.max(0, width - usedWidth - 1);
    if (visible.includes("context") && percent !== undefined && barWidth > 0) {
      values.context += ` ${progressBar(percent, settings["pi-mini-mode-context-dots-show"], barWidth)}`;
    }
    return truncateToWidth([planTag, ...settings.footerOrder.map(id => {
      const key = `pi-mini-mode-${id}-show` as keyof MiniLensSettings;
      const color = id === "speed" ? speedColor(speed) : id === "cache-miss" ? "warning" : id === "model" || id === "context-percent" ? "accent" : "muted";
      return settings[key] && values[id] ? field(key, color, values[id]) : "";
    })].filter(Boolean).join("  "), width, "…");
  }
  const right = renderRight(theme, settings, percentText, speed, highlighted);
  const rightWidth = visibleWidth(right);
  if (right && width <= rightWidth) {
    const compactRight = settings["pi-mini-mode-speed-show"] && speed !== undefined
      ? theme.fg(speedColor(speed), formatSpeed(speed, settings["pi-mini-mode-speed-unit-show"]))
      : right;
    return truncateToWidth(compactRight, width, "");
  }

  const leftParts = [
    planTag,
    !branchOnly && branchText && field(branchSetting, "muted", branchText),
    settings["pi-mini-mode-model-show"] && model && field("pi-mini-mode-model-show", "accent", model),
    settings["pi-mini-mode-thinking-show"] && thinking && field("pi-mini-mode-thinking-show", "muted", thinking),
    branchOnly && branchText && field(branchSetting, "muted", branchText),
    settings["pi-mini-mode-session-tokens-show"] && usageTotals.totalTokens > 0 && field("pi-mini-mode-session-tokens-show", "text", `${COPY.totalLabel} ${formatTokens(usageTotals.totalTokens)}`),
    settings["pi-mini-mode-cache-tokens-show"] && cachedTokens > 0 && field("pi-mini-mode-cache-tokens-show", "text", `${COPY.cachedLabel} ${formatTokens(cachedTokens)}`),
    missText && field("pi-mini-mode-cache-miss-show", "warning", missText),
    settings["pi-mini-mode-ch-show"] && hitText && field("pi-mini-mode-ch-show", "text", hitText),
    settings["pi-mini-mode-cost-show"] && price && field("pi-mini-mode-cost-show", "muted", price),
    mcpText && field("pi-mini-mode-mcp-show", "muted", mcpText),
  ].filter((part): part is string => Boolean(part));
  const unstyledLeft = [
    planTag && stripVTControlCharacters(planTag),
    !branchOnly && branchText,
    settings["pi-mini-mode-model-show"] && model,
    settings["pi-mini-mode-thinking-show"] && thinking,
    branchOnly && branchText,
    settings["pi-mini-mode-session-tokens-show"] && usageTotals.totalTokens > 0 && `${COPY.totalLabel} ${formatTokens(usageTotals.totalTokens)}`,
    settings["pi-mini-mode-cache-tokens-show"] && cachedTokens > 0 && `${COPY.cachedLabel} ${formatTokens(cachedTokens)}`,
    missText,
    settings["pi-mini-mode-ch-show"] && hitText,
    settings["pi-mini-mode-cost-show"] && price,
    mcpText,
  ].filter(Boolean).join("  ");
  const leftBudget = Math.min(visibleWidth(unstyledLeft), Math.max(1, width - rightWidth - (showContext ? 20 : 1)), Math.max(0, width - rightWidth - 1));
  const left = leftParts.length > 0 ? truncateToWidth(leftParts.join("  "), leftBudget, "…") : "";
  const leftWidth = visibleWidth(left);
  const middleBudget = showContext ? Math.max(0, width - leftWidth - rightWidth - (left && right ? 4 : left || right ? 1 : 0)) : 0;

  let middle = "";
  if (middleBudget > 0) {
    const visibleToken = truncateToWidth(tokenText, middleBudget, "…");
    const visibleTokenWidth = visibleWidth(visibleToken);
    const barWidth = middleBudget - visibleTokenWidth - 1;
    const filledCell = settings["pi-mini-mode-context-dots-show"] ? "⣿" : "█";
    const emptyCell = settings["pi-mini-mode-context-dots-show"] ? "⣀" : "░";
    const bar = barWidth >= 2 && percent !== undefined
      ? `${field("pi-mini-mode-context-show", "accent", filledCell.repeat(Math.round(barWidth * percent / 100)))}${field("pi-mini-mode-context-show", "borderMuted", emptyCell.repeat(barWidth - Math.round(barWidth * percent / 100)))}`
      : "";
    middle = `${field("pi-mini-mode-context-show", "muted", visibleToken)}${bar ? ` ${bar}` : ""}`;
  }

  const content = [left, middle].filter(Boolean).join("  ");
  if (!right) return truncateToWidth(content, width, "");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(content) - rightWidth));
  return truncateToWidth(`${content}${content ? gap : ""}${right}`, width, "");
}
