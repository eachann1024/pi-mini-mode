import { sliceByColumn, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** OSC 8 identifies targets; standard mouse events and SGR supply hover feedback.
 * Cmd is not a modifier in SGR mouse reports. The terminal owns Cmd underlining;
 * Ctrl reports can provide the same feedback inside a mouse-capturing TUI.
 */
const LINK_CACHE_MAX = 2000;
const LINK_CACHE_MAX_SOURCE = 16384;
const NO_LINKS: readonly LinkSpan[] = [];
const linkSpans = new Map<string, LinkSpan[]>();

interface LinkSpan {
  start: number;
  end: number;
  url: string;
}

function readAnsi(line: string, pos: number): number {
  if (line.charCodeAt(pos) !== 0x1b) return 0;
  const next = line[pos + 1];
  if (next === "[") {
    let end = pos + 2;
    while (end < line.length && !/[mGKHJ]/.test(line[end])) end++;
    return end < line.length ? end + 1 - pos : 0;
  }
  if (next === "]" || next === "_") {
    let end = pos + 2;
    while (end < line.length) {
      if (line[end] === "\x07") return end + 1 - pos;
      if (line[end] === "\x1b" && line[end + 1] === "\\") return end + 2 - pos;
      end++;
    }
  }
  return 0;
}

/** One left-to-right pass. Columns follow the same ANSI skipping rules as Pi's hit test. */
function parseLinkSpans(line: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let column = 0;
  let index = 0;
  let active: string | undefined;
  let start = 0;
  const close = (next: string | undefined) => {
    if (active !== undefined && column > start) {
      const previous = spans.at(-1);
      if (previous && previous.url === active && previous.end === start) previous.end = column;
      else spans.push({ start, end: column, url: active });
    }
    active = next;
    start = column;
  };
  while (index < line.length) {
    let textEnd = index;
    while (textEnd < line.length && !(line.charCodeAt(textEnd) === 0x1b && readAnsi(line, textEnd) > 0)) textEnd++;
    if (textEnd > index) {
      column += visibleWidth(line.slice(index, textEnd));
      index = textEnd;
    }
    if (index >= line.length) break;
    const length = readAnsi(line, index);
    if (line.startsWith("\x1b]8;", index)) {
      const match = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(line.slice(index, index + length));
      if (match) close(match[1] || undefined);
    }
    index += length;
  }
  close(undefined);
  return spans;
}

function linksFor(line: string): readonly LinkSpan[] {
  if (!line.includes("\x1b]8;")) return NO_LINKS;
  if (line.length > LINK_CACHE_MAX_SOURCE) return parseLinkSpans(line);
  const cached = linkSpans.get(line);
  if (cached) {
    linkSpans.delete(line);
    linkSpans.set(line, cached);
    return cached;
  }
  const parsed = parseLinkSpans(line);
  if (linkSpans.size >= LINK_CACHE_MAX) {
    const first = linkSpans.keys().next().value;
    if (first !== undefined) linkSpans.delete(first);
  }
  linkSpans.set(line, parsed);
  return parsed;
}

function spanAt(spans: readonly LinkSpan[], column: number): LinkSpan | undefined {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (column < span.start) hi = mid - 1;
    else if (column >= span.end) lo = mid + 1;
    else return span;
  }
  return undefined;
}

export function createLinkHover(highlight: (text: string) => string) {
  let rows: string[] = [];
  let width = 0;
  let hovered: { row: number; start: number; end: number; source: string; underline: boolean } | undefined;
  const clear = () => { const changed = !!hovered; hovered = undefined; return changed; };
  return {
    clear,
    handleMouse(event: TuiMouseEvent): boolean {
      if (event.type !== "move") return clear();
      const source = rows[event.y];
      if (!source || event.x < 0 || event.x >= visibleWidth(source)) return clear();
      const underline = event.ctrl;
      if (hovered?.row === event.y && hovered.source === source
        && event.x >= hovered.start && event.x < hovered.end) {
        const changed = hovered.underline !== underline;
        hovered.underline = underline;
        return changed;
      }
      const span = spanAt(linksFor(source), event.x);
      if (!span) return clear();
      hovered = { row: event.y, start: span.start, end: span.end, source, underline };
      return true;
    },
    render(lines: string[], columns: number): string[] {
      if (columns !== width || hovered && lines[hovered.row] !== hovered.source) clear();
      rows = lines;
      width = columns;
      if (!hovered) return lines;
      const { row, start, end, underline } = hovered;
      const line = lines[row];
      // A slice replays preceding ANSI state. Remove its old background so
      // user-message/code surfaces cannot cover the hover background.
      let label = highlight(sliceByColumn(line, start, end - start)
        .replace(/\x1b\[(?:4[0-9]|10[0-7]|48;(?:2;\d+;\d+;\d+|5;\d+))m/g, ""));
      if (underline) label = "\x1b[4m" + label.replace(/\x1b\[(?:0|24)?m/g, reset => reset + "\x1b[4m") + "\x1b[24m";
      const result = [...lines];
      // Column slicing omits zero-width sequences after the final cell.
      // Retain them (including image placement), then isolate the row's state.
      const trailing = line.match(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\))+$/)?.[0] ?? "";
      result[row] = sliceByColumn(line, 0, start) + label + sliceByColumn(line, end, Math.max(0, visibleWidth(line) - end))
        + trailing + "\x1b]8;;\x07\x1b[0m";
      return result;
    },
  };
}
