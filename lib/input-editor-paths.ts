import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getOsc8LinkAtColumn, sliceByColumn, stripTerminalSequences, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";
import { inputCapabilities, linkRenderedPath, localPath, webPaths } from "./file-links.ts";
import { imagePathsInLine, type ImagePathMatch } from "./input-image-paths.ts";

// ponytail: Pi 0.85 editor layout mapping; unknown editors use visible-line matching.
export function editorImagePaths(editor: EditorComponent, text: string): ImagePathMatch[] {
  const attachments = (editor as EditorComponent & { imageAttachments?: Map<string, string> }).imageAttachments;
  const paths = imagePathsInLine(text);
  for (const match of text.matchAll(/\[img\d+\]/g)) {
    const path = attachments?.get(match[0]);
    if (path) paths.push({ path, start: match.index, end: match.index + match[0].length, startCol: visibleWidth(text.slice(0, match.index)), endCol: visibleWidth(text.slice(0, match.index + match[0].length)) });
  }
  return paths.sort((a, b) => a.start - b.start);
}

export function editorPaths(editor: EditorComponent, row: number, width: number, includeWeb = false, compactImages = false) {
  const core = editor as EditorComponent & { lastWidth?: number; scrollOffset?: number; renderedVisibleLineCount?: number; getPaddingX?(): number; buildVisualLineMap?(width: number): Array<{ logicalLine: number; startCol: number; length: number }> };
  if (!core.buildVisualLineMap || !core.lastWidth) return imagePathsInLine(editor.render(width)[row] ?? "");
  if (row < 1 || row > (core.renderedVisibleLineCount ?? 0)) return [];
  const chunk = core.buildVisualLineMap(core.lastWidth)[(core.scrollOffset ?? 0) + row - 1];
  if (!chunk) return [];
  const source = editor.getText().split("\n")[chunk.logicalLine] ?? "";
  const padding = Math.min(core.getPaddingX?.() ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
  return [...editorImagePaths(editor, source), ...(includeWeb ? webPaths(source) : [])].filter(match => match.end > chunk.startCol && match.start < chunk.startCol + chunk.length).map(match => ({
    ...match,
    startCol: padding + visibleWidth(source.slice(chunk.startCol, Math.max(chunk.startCol, match.start)))
      + (compactImages && /^\[img\d+\]$/.test(source.slice(match.start, match.end)) ? 1 : 0),
    endCol: padding + visibleWidth(source.slice(chunk.startCol, Math.min(chunk.startCol + chunk.length, compactImages && /^\[img\d+\]$/.test(source.slice(match.start, match.end))
      ? match.start + 1 + visibleWidth(`  #${source.slice(match.start + 4, match.end - 1)}`) : match.end))),
  }));
}

export function hideImageLabels(line: string, labels: Set<string>, theme: ExtensionContext["ui"]["theme"], original: string): string {
  const markerIndex = original.indexOf(CURSOR_MARKER);
  const cursorCol = markerIndex < 0 ? -1 : visibleWidth(original.slice(0, markerIndex));
  const plain = stripTerminalSequences(line);
  const clean = line.replaceAll(CURSOR_MARKER, "").replaceAll("\x1b[7m", "");
  const reset = "\x1b]8;;\x07\x1b[0m";
  const caret = (cell: string) => reset + CURSOR_MARKER + `\x1b[7m${cell}\x1b[27m`;
  const textSlice = (start: number, length: number) => {
    const part = sliceByColumn(clean, start, length, true);
    if (getOsc8LinkAtColumn(clean, start)) return part;
    return part.replace(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\))*/,
      leading => leading.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
  };
  const textSpan = (start: number, end: number) => {
    if (cursorCol < start || cursorCol >= end) return textSlice(start, end - start);
    const cell = stripTerminalSequences(sliceByColumn(clean, cursorCol, 1));
    return textSlice(start, cursorCol - start) + caret(cell)
      + textSlice(cursorCol + visibleWidth(cell), end - cursorCol - visibleWidth(cell));
  };
  const parts: string[] = [];
  let previous = 0;
  for (const match of plain.matchAll(/\[img\d+\]/g)) {
    if (!labels.has(match[0])) continue;
    const start = visibleWidth(plain.slice(0, match.index));
    const end = start + visibleWidth(match[0]);
    const icon = theme.fg("accent", `  #${match[0].slice(4, -1)}`);
    const url = getOsc8LinkAtColumn(line, start);
    const chip = url ? `\x1b]8;;${url}\x07${icon}\x1b]8;;\x07` : icon;
    // [imgN] fits exactly one insertion cell plus the visible chip; no hidden padding.
    // Emit the caret before styling the chip: slicing styled output replays stale ANSI resets.
    parts.push(textSpan(previous, start), reset, cursorCol === start ? caret(" ") : " ", chip);
    previous = end;
  }
  parts.push(textSpan(previous, visibleWidth(plain)), reset);
  return parts.join("");
}

export function linkImagePaths(lines: string[], editor: EditorComponent, cwd: string, width: number): string[] {
  if (!inputCapabilities().hyperlinks) return lines;
  return lines.map((line, row) => {
    for (const match of editorPaths(editor, row, width, true).reverse()) line = linkRenderedPath(line, match.startCol, match.endCol, /^https?:\/\//i.test(match.path) ? match.path : localPath(match.path, cwd));
    // Isolate editor rows from inherited terminal link/color state.
    const reset = "\x1b]8;;\x07\x1b[0m";
    return reset + line + reset;
  });
}
