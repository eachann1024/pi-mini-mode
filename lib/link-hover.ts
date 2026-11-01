import { getOsc8LinkAtColumn, sliceByColumn, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** OSC 8 identifies targets; standard mouse events and SGR supply hover feedback.
 * Cmd is not a modifier in SGR mouse reports. The terminal owns Cmd underlining;
 * Ctrl reports can provide the same feedback inside a mouse-capturing TUI.
 */
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
      const url = getOsc8LinkAtColumn(source, event.x);
      if (!url) return clear();
      let start = event.x, end = event.x + 1;
      while (start > 0 && getOsc8LinkAtColumn(source, start - 1) === url) start--;
      while (end < visibleWidth(source) && getOsc8LinkAtColumn(source, end) === url) end++;
      hovered = { row: event.y, start, end, source, underline };
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
