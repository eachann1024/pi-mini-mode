import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, truncateToWidth } from "@earendil-works/pi-tui";
import type { PreviewState } from "./input-enhancements-types.ts";

export function positionedGraphic(sequence: string, up: number, right: number): string {
  // Pi <=0.87's ANSI slicer needs an SGR terminator after relative motion.
  // Otty places Kitty graphics against the last committed cursor while DEC 2026
  // buffers text/cursor updates. Commit the target before the APC, then resume
  // Pi's synchronized frame. Other terminals retain their atomic rendering.
  const flush = process.env.TERM_PROGRAM?.toLowerCase() === "otty"
    && !process.env.TMUX && !process.env.STY && !/^(tmux|screen)/i.test(process.env.TERM ?? "")
    && sequence.startsWith("\x1b_G");
  return `\x1b[s\x1b[${up}A\x1b[${right}C\x1b[0m${flush ? "\x1b[?2026l\x1b[0m" : ""}${sequence}\x1b[u${flush ? "\x1b[?2026h" : ""}\x1b[0m`;
}

export function imageLayoutKey(): string {
  const cells = getCellDimensions();
  return `${getCapabilities().images}:${cells.widthPx}:${cells.heightPx}`;
}

/** A tightly sized image frame. Draw after clearing its interior, never a path-only tooltip. */
export function previewLines(preview: PreviewState, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  if (!preview.path) return [];
  const graphic = preview.graphic;
  const innerWidth = Math.max(1, Math.min(width - 2, graphic?.columns ?? 26));
  const border = (text: string) => theme.fg("border", text);
  const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
  if (graphic) {
    for (let row = 0; row < graphic.rows; row++) lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
  } else lines.push(border("│") + truncateToWidth(preview.note ?? "无法预览图片", innerWidth, "", true) + border("│"));
  const draw = graphic ? positionedGraphic(graphic.sequence, graphic.rows, 1) : "";
  lines.push(draw + border(`╰${"─".repeat(innerWidth)}╯`));
  return lines;
}
