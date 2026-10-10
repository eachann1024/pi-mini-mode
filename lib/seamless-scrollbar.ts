import { ScrollView } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function installSeamlessScrollbar(tui: unknown, theme: Theme): (() => void) | undefined {
  const host = tui as { mode?: string; layoutRoot?: { children?: unknown[] } };
  // ponytail: Pi's fullscreen root owns the scroll view; use its public scrollbar style until Pi exposes a scrollbar renderer hook.
  const view = host.mode !== "regular" ? host.layoutRoot?.children?.[0] : undefined;
  if (!(view instanceof ScrollView)) return;
  const scrollbar = view as { scrollbarThumbStyle: (text: string) => string };
  const original = scrollbar.scrollbarThumbStyle;
  // Reverse-video space paints the full cell, avoiding glyph seams between terminal rows.
  scrollbar.scrollbarThumbStyle = () => theme.fg("scrollbarThumb", "\x1b[7m \x1b[27m");
  return () => { scrollbar.scrollbarThumbStyle = original; };
}
