import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Live previews follow coherent sentences; completed previews retain the beginning. */
export function thinkingPreview(source: string, columns: number, maxRows = 1, live = false): string {
  if (columns <= 0 || maxRows <= 0) return "";
  const paragraphs = stripVTControlCharacters(source).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const full = paragraphs.join(" ");
  if (!full) return "";
  const fits = (text: string) => visibleWidth(text) <= columns * maxRows && new Text(text, 0, 0).render(columns).length <= maxRows;
  if (fits(full)) return full;
  let excerpt = full;
  if (live) {
    const parts = paragraphs.flatMap(paragraph => [...sentences.segment(paragraph)].map(part => part.segment.trim()).filter(Boolean));
    excerpt = parts.at(-1) ?? full;
    // Keep context across paragraph boundaries while the next sentence is incomplete.
    if (visibleWidth(excerpt) < 12 && parts.length > 1) excerpt = `${parts.at(-2)} ${excerpt}`;
    const marked = excerpt === full ? excerpt : `…${excerpt}`;
    if (fits(marked)) return marked;
  }

  // Only live thinking follows the tail. Tools and completed thinking retain the head.
  let result = "";
  const marked = (text: string) => live ? `…${text.trimStart()}` : `${text.trimEnd()}…`;
  const segments = [...words.segment(excerpt)];
  for (const { segment } of live ? segments.reverse() : segments) {
    const candidate = live ? segment + result : result + segment;
    if (!fits(marked(candidate))) break;
    result = candidate;
  }
  if (!result.trim()) {
    // An oversized word/path still respects emoji and combining-character boundaries.
    const characters = [...graphemes.segment(excerpt)];
    for (const { segment } of live ? characters.reverse() : characters) {
      const candidate = live ? segment + result : result + segment;
      if (!fits(marked(candidate))) break;
      result = candidate;
    }
  }
  return result.trim() ? marked(result) : "…";
}
