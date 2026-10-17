import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Live previews follow the tail to fill maxRows stably; completed previews retain the beginning of the first paragraph. */
export function thinkingPreview(source: string, columns: number, maxRows = 1, live = false): string {
  if (columns <= 0 || maxRows <= 0) return "";
  const paragraphs = stripVTControlCharacters(source).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  // Completed previews show only the first paragraph to keep multi-paragraph details collapsed.
  // Live previews draw from recent thinking across lines to keep the tail informative.
  const target = live ? paragraphs.join(" ") : (paragraphs[0] ?? "");
  if (!target) return "";
  const fits = (text: string) => visibleWidth(text) <= columns * maxRows && new Text(text, 0, 0).render(columns).length <= maxRows;
  if (fits(target)) return target;

  let result = "";
  const marked = (text: string) => live ? `…${text.trimStart()}` : `${text.trimEnd()}…`;
  const segments = [...words.segment(target)];
  for (const { segment } of live ? segments.reverse() : segments) {
    const candidate = live ? segment + result : result + segment;
    if (!fits(marked(candidate))) break;
    result = candidate;
  }
  if (!result.trim() || (live && new Text(marked(result), 0, 0).render(columns).length < maxRows)) {
    // Fill remaining space with graphemes if word boundaries left it short.
    const prefix = live ? target.slice(0, target.length - result.length) : target.slice(result.length);
    const characters = [...graphemes.segment(prefix)];
    for (const { segment } of live ? characters.reverse() : characters) {
      const candidate = live ? segment + result : result + segment;
      if (!fits(marked(candidate))) break;
      result = candidate;
    }
  }
  return result.trim() ? marked(result) : "…";
}
