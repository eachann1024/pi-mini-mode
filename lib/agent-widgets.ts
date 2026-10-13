import { diagramMarkdown, renderMinimalMarkdown } from "./minimal-markdown.ts";
import { plain } from "./agent-state.ts";
import { agentSummary, liveAgentRows, runningGlyph, type AgentDeadlines } from "./agent-render.ts";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

const isAgentWidget = (source: string) => /^(?:[●○◉✓✗×\u2800-\u28ff]\s*)?(?:async subagent|Async agents|subagents\b|[│├└─\s]*async workflow)/i.test(source);
/** Presentation adapter for pi-subagents' independently updated widget.
 * Unknown widget formats pass through unchanged; no task state is inferred.
 */
export function restyleAgentWidget(lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
  const content = lines.map(plain).filter(Boolean);
  if (!content.length || !isAgentWidget(content[0])) return lines;
  const details = content.slice(1).map(line => line
    .replace(/^[│├└─\s]+/, "")
    .replace(/(?:[·•]\s*)?Press\s+ctrl\+.*$/i, "")
    .replace(/(?:[·•]\s*)?Ctrl\+Alt\+F\s+Fleet.*$/i, "").trim())
    .filter(line => line && !/^async workflow\b|^[…+] .*lines hidden\b/i.test(line));
  const isHeading = (line: string) => /^(?:[└├]─\s*)?[●○◉✓✗×◦■\u2800-\u28ff]\s/.test(line)
    && !/^[│⎿]/.test(line);
  const blocks: string[][] = [];
  for (const line of details) {
    if (!blocks.length || isHeading(line)) blocks.push([line]);
    else blocks[blocks.length - 1].push(line);
  }
  const isDone = (block: string[]) => /\b(complete|completed|done|success|succeeded)\b/i.test(block[0]) || /^✓/.test(block[0]);
  const isFailed = (block: string[]) => /\b(failed|error|rejected|stopped|cancelled|canceled|aborted)\b/i.test(block[0]) || /^[✗×]/.test(block[0]);
  const done = blocks.filter(block => isDone(block) && !isFailed(block)).length;
  const errors = blocks.filter(isFailed).length;
  const visible = blocks.filter(block => expanded || isFailed(block) || !isDone(block));
  const rows = [agentSummary(theme, width, blocks.length - done - errors, done, errors, expanded)];
  if (!blocks.length) rows.push(truncateToWidth(theme.fg("text", content[0]), width));
  const markdown = (text: string, available: number) => renderMinimalMarkdown(text, Math.max(1, available), getMarkdownTheme(), theme.getBgAnsi?.("userMessageBg") ?? "",
    { color: value => theme.fg("text", value) }, diagramMarkdown);
  // ponytail: native widget exposes bounded live previews, not the full child transcript.
  visible.forEach((block, index) => {
    const heading = block[0].replace(/^(?:[└├]─\s*)?[●○◉✓✗×◦■\u2800-\u28ff]\s*/, "");
    const badge = heading.match(/\(([^()]+?)(?:\s*·\s*thinking\s+|[ :]+)(off|minimal|low|medium|high|xhigh|max)\)/)
      ?? heading.match(/\(([^()]+)\)(?=\s*(?:·|$))/);
    const title = heading.split(" · ")[0].replace(/\s*\([^()]*\)\s*$/, "");
    const identity = badge ? theme.fg("accent", theme.bold(title)) + theme.fg("muted", " · ") + theme.fg("accent", theme.bold(badge[1])) + (badge[2] ? theme.fg("muted", ` ${badge[2]}`) : "")
      : theme.fg("accent", theme.bold(heading.split(" · ")[0]));
    const activity = block.slice(1).filter(line => !/^(?:task|output)\s*:/i.test(line));
    const latest = activity.at(-1)?.replace(/^[⎿│]\s*/, "") || block.slice(1).find(line => /^task\s*:/i.test(line)) || heading;
    const glyph = /\b(failed|error|rejected)\b/i.test(heading) || /^[✗×]/.test(block[0]) ? "×"
      : /\b(running|active|starting|queued|pending)\b/i.test(heading) || /^[\u2800-\u28ff]/.test(block[0]) ? runningGlyph() : "●";
    const prefix = theme.fg("accent", index === visible.length - 1 ? "└─ " : "├─ ")
      + theme.fg(glyph === "×" ? "error" : "accent", glyph + " ") + identity + theme.fg("text", " : ");
    const summary = /\b(failed|error)\b/i.test(heading + " " + latest)
      ? theme.fg("error", latest)
      : markdown(latest, Math.max(1, visibleWidth(latest) + 1)).join(" ");
    rows.push(truncateToWidth(prefix + summary, width));
  });
  return rows;
}

// Only hide the passive native agent summary, preserving the interactive fleet and external jobs/panes.
const isAgentFleetSummary = (lines: string[]) => {
  const content = lines.map(plain).filter(Boolean);
  return content.length === 1 && /^\d+ active agents?\b/.test(content[0])
    && !/\b(?:jobs?|panes?)\b/.test(content[0]);
};

/** Pi 0.85 widget containers: preserve unrelated widgets and their lifecycle. */
export function attachAgentWidgets(tui: unknown, theme: Theme, expanded: () => boolean, statuses?: () => Record<string, unknown>[], inline = false): () => void {
  const host = tui as { children?: Array<Component & { children?: Component[] }> };
  if (host.children?.length !== 7) return () => {};
  const restores: Array<() => void> = [];
  const deadlines: AgentDeadlines = new Map();
  for (const index of [3, 5]) {
    const container = host.children[index];
    if (!Array.isArray(container?.children)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(container, "render");
    const mouseDescriptor = Object.getOwnPropertyDescriptor(container, "handleMouse");
    const render = (width: number) => {
      const live = !inline && statuses ? liveAgentRows(statuses(), theme, width, expanded(), deadlines) : [];
      let inserted = false;
      const rows = container.children!.flatMap(child => {
        const original = child.render(width);
        if (inline && (isAgentWidget(original.map(plain).find(Boolean) ?? "") || isAgentFleetSummary(original))) return [];
        if (statuses && live.length && isAgentFleetSummary(original)) return [];
        const source = original.map(plain).find(Boolean) ?? "";
        const agentWidget = isAgentWidget(source);
        if (statuses && agentWidget) {
          if (inserted || index !== 3) return [];
          inserted = true;
          return live;
        }
        return restyleAgentWidget(original, theme, width, expanded());
      });
      if (index === 3 && !inserted) rows.push(...live);
      return rows;
    };
    const mouse: NonNullable<Component["handleMouse"]> = (event) => {
      let y = 0;
      let inserted = false;
      const live = !inline && statuses ? liveAgentRows(statuses(), theme, event.width, expanded(), deadlines) : [];

      for (const child of container.children!) {
        const original = child.render(event.width);
        if (inline && (isAgentWidget(original.map(plain).find(Boolean) ?? "") || isAgentFleetSummary(original))) continue;
        if (statuses && live.length && isAgentFleetSummary(original)) continue;
        const agentWidget = isAgentWidget(original.map(plain).find(Boolean) ?? "");
        const shown = statuses && agentWidget ? (index === 3 && !inserted ? live : [])
          : restyleAgentWidget(original, theme, event.width, expanded());
        if (agentWidget) inserted = true;
        if (event.y >= y && event.y < y + shown.length) {
          // Do not route clicks into native controls hidden by the compact view.
          return shown === original ? child.handleMouse?.({ ...event, y: event.y - y, height: shown.length }) : undefined;
        }
        y += shown.length;
      }
    };
    container.render = render;
    container.handleMouse = mouse;
    restores.push(() => {
      if (container.handleMouse === mouse) {
        if (mouseDescriptor) Object.defineProperty(container, "handleMouse", mouseDescriptor);
        else delete container.handleMouse;
      }
      if (container.render !== render) return;
      if (descriptor) Object.defineProperty(container, "render", descriptor);
      else delete (container as Partial<Component>).render;
    });
  }
  return () => { deadlines.clear(); restores.forEach(restore => restore()); };
}
