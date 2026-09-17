import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type RGB = [number, number, number];
function ansiColor(ansi: string): RGB | undefined {
  const rgb = ansi.match(/(?:38|48);2;(\d+);(\d+);(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const indexed = ansi.match(/(?:38|48);5;(\d+)/);
  if (!indexed) return;
  const n = Number(indexed[1]);
  if (n >= 232) return [8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10];
  if (n >= 16) {
    const levels = [0, 95, 135, 175, 215, 255];
    return [levels[Math.floor((n - 16) / 36)], levels[Math.floor((n - 16) / 6) % 6], levels[(n - 16) % 6]];
  }
}

/** Expanded heading: full-width selectedBg, keeping inner fg after resets.
 * theme.bg only wraps the ends; older themes without getBgAnsi lose fill after \x1b[0m. */
export function paintExpandedHeading(theme: ExtensionContext["ui"]["theme"], line: string): string {
  const background = theme.getBgAnsi?.("selectedBg") ?? "";
  return background
    ? background + line.replace(/\x1b\[(?:0|49)?m/g, reset => reset + background) + "\x1b[49m"
    : theme.bg("selectedBg", line);
}

/** User uses the theme's soft surface directly; process keeps its secondary tint.
 * A row inside an expanded heading (selected) keeps the band instead: the
 * blended tint and the user surface both collapse into it. */
export function minimalSurface(theme: ExtensionContext["ui"]["theme"], text: string, user = false, selected = false): string {
  const background = theme.getBgAnsi?.(selected ? "selectedBg" : "userMessageBg") ?? "";
  if (user || selected) return background
    ? background + text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background) + "\x1b[49m"
    : theme.bg(selected ? "selectedBg" : "userMessageBg", text);
  const base = ansiColor(background);
  const accent = ansiColor(theme.fg("accent", "")) ?? ansiColor(theme.fg("success", ""));
  if (!base || !accent) return theme.bg("userMessageBg", text);
  const weight = 0.07;
  const rgb = base.map((value, i) => Math.round(value * (1 - weight) + accent[i] * weight));
  let prefix = `\x1b[48;2;${rgb.join(";")}m`;
  if (theme.getColorMode?.() === "256color") {
    const levels = [0, 95, 135, 175, 215, 255];
    const indices = rgb.map((value) => levels.reduce((best, level, i) => Math.abs(level - value) < Math.abs(levels[best] - value) ? i : best, 0));
    prefix = `\x1b[48;5;${16 + indices[0] * 36 + indices[1] * 6 + indices[2]}m`;
  }
  // Restore the surface after Markdown's inline reset sequences.
  return prefix + text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + prefix) + "\x1b[49m";
}
