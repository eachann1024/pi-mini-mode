import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Latest sentence, retaining its predecessor while a new sentence is still short. */
export function thinkingPreview(source: string, columns: number, maxRows = 1): string {
  if (columns <= 0) return "";
  const paragraphs = stripVTControlCharacters(source).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const paragraph = paragraphs.at(-1) ?? "";
  if (!paragraph) return "";
  const parts = [...sentences.segment(paragraph)].map(part => part.segment.trim()).filter(Boolean);
  let latest = parts.at(-1) ?? paragraph;
  if (visibleWidth(latest) < 12 && parts.length > 1) latest = `${parts.at(-2)} ${latest}`;
  const fits = (text: string) => visibleWidth(text) <= columns * maxRows && new Text(text, 0, 0).render(columns).length <= maxRows;
  if (fits(latest)) return latest;

  // Keep a contiguous suffix starting at a word boundary instead of sliding mid-word.
  let suffix = "";
  for (const { segment } of [...words.segment(latest)].reverse()) {
    if (!fits(`…${(segment + suffix).trimStart()}`)) break;
    suffix = segment + suffix;
  }
  if (!suffix.trim()) {
    // An oversized word/path still respects emoji and combining-character boundaries.
    for (const { segment } of [...graphemes.segment(latest)].reverse()) {
      if (!fits(`…${segment + suffix}`)) break;
      suffix = segment + suffix;
    }
  }
  return suffix.trim() ? `…${suffix.trimStart()}` : "";
}
