import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagramMarkdown, isMarkdownProse, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { clean, record, supervisorNotice, supervisorNoticeBody } from "./transcript-notices.ts";

const renderMarkdownBody = (body: string, width: number, theme?: ExtensionContext["ui"]["theme"]) => isMarkdownProse(body)
  ? renderMinimalMarkdown(body, Math.max(1, width), getMarkdownTheme(), theme?.getBgAnsi?.("userMessageBg") ?? "", undefined, diagramMarkdown)
  : new Text(body, 0, 0).render(Math.max(1, width));

export function compactGoalCard(entry: unknown, theme: ExtensionContext["ui"]["theme"], width: number, expanded: boolean): string[] | undefined {
  const item = record(entry);
  if (item?.customType !== "pi-codex-goal") return;
  const data = record(item.data);
  const goal = record(data?.goal);
  const objective = typeof goal?.objective === "string" ? clean(goal.objective) : undefined;
  // Usage snapshots are rendered by the goal extension too, but are not cards
  // worth adding to the compact transcript.
  if (!objective || width <= 0) return;
  const status = typeof goal?.status === "string" ? clean(goal.status) : "active";
  const control = truncateToWidth(expanded ? "[收起]" : "[详情]", width, "");
  const title = theme.fg(expanded ? "accent" : "muted", `${control} ◉ Goal · ${status}`);
  const hint = theme.fg(expanded ? "accent" : "muted", " · Ctrl+O");
  const summary = truncateToWidth(objective, Math.max(0, width - visibleWidth(title) - visibleWidth(hint) - 3), "…");
  const rows = [truncateToWidth(`${title} · ${theme.fg(expanded ? "accent" : "text", summary)}${hint}`, width, "")];
  if (expanded) rows.push(...renderMarkdownBody(objective, width, theme));
  return rows;
}

export function compactSupervisorNotice(message: unknown, theme: ExtensionContext["ui"]["theme"], width: number, expanded: boolean, label = "", history: unknown[] = [message]): string[] | undefined {
  const notice = supervisorNotice(message);
  if (!notice) return;
  if (width <= 0) return [];
  const { state, color, summary } = notice;
  const effectiveLabel = label || (notice.showLabel ? notice.label ?? "" : "");
  const control = truncateToWidth(expanded ? "[收起]" : "[详情]", width, "");
  const hint = " · Ctrl+O";
  let heading: string;
  let summaryText: string;
  if (expanded) {
    const statusGlyph = color === "error" ? theme.fg("error", "× " + state)
      : color === "warning" ? theme.fg("warning", "⚠ " + state)
      : theme.fg("accent", "ℹ " + state);
    const taskLabel = effectiveLabel ? theme.fg("accent", ` · ${truncateToWidth(effectiveLabel, 20)}`) : "";
    heading = theme.fg("accent", control) + " " + statusGlyph + taskLabel;
    summaryText = theme.fg("accent", summary);
  } else {
    const title = theme.fg(color, `${color === "error" ? "×" : color === "warning" ? "⚠" : "ℹ"} ${state}${effectiveLabel ? ` · ${truncateToWidth(effectiveLabel, 20)}` : ""}`);
    heading = theme.fg("muted", control) + " " + title;
    summaryText = theme.fg(color, summary);
  }
  const hintStyled = theme.fg(expanded ? "accent" : "muted", hint);
  const available = width - visibleWidth(heading) - visibleWidth(hint) - 3;
  const rows = available >= 24
    ? [heading + " · " + truncateToWidth(summaryText, available) + hintStyled]
    : [truncateToWidth(heading, width, ""), truncateToWidth(summaryText, Math.max(0, width - visibleWidth(hint)), "") + truncateToWidth(hintStyled, width, "")];
  if (expanded) {
    const bodies: string[] = [];
    for (const original of history) {
      const body = supervisorNoticeBody(original);
      if (body && !bodies.includes(body)) bodies.push(body);
    }
    for (const body of bodies) {
      rows.push(...renderMarkdownBody(body, width, theme));
    }
  }
  return rows;
}
