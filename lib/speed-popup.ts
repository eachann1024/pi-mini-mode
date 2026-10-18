import type { OverlayOptions } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SpeedMetric } from "./token-speed.ts";

export const SPEED_POPUP_WIDTH = 36;

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};

export interface SpeedHit {
  start: number;
  end: number;
}

export interface PopupPlace {
  row: number;
  col: number;
  width: number;
  height: number;
}

/** Column span of the speed text. String indexes are converted to terminal columns. */
export function speedHit(line: string, speedText: string): SpeedHit | undefined {
  if (!speedText) return undefined;
  const plain = stripTerminalSequences(line);
  const index = plain.lastIndexOf(speedText);
  if (index < 0) return undefined;
  const start = visibleWidth(plain.slice(0, index));
  return { start, end: start + visibleWidth(speedText) };
}

/**
 * Pin the popup above the status bar, right edge on the indicator.
 * `pinRight` keeps that edge fixed so later redraws do not follow the pointer.
 */
export function placeSpeedPopup(input: {
  rows: number;
  columns: number;
  width: number;
  height: number;
  indicatorRow: number;
  indicatorEnd: number;
  pinRight?: number;
}): PopupPlace {
  const columns = Math.max(1, input.columns);
  const width = Math.max(1, Math.min(input.width, columns));
  const above = Math.max(0, input.indicatorRow);
  const height = Math.max(1, Math.min(input.height, Math.max(1, above || 1)));
  const right = input.pinRight ?? input.indicatorEnd;
  let col = right - width;
  col = Math.max(0, Math.min(col, columns - width));
  let row = above > 0 ? input.indicatorRow - height : 0;
  if (row < 0) row = 0;
  if (above > 0 && row + height > input.indicatorRow) row = Math.max(0, input.indicatorRow - height);
  return { row, col, width, height };
}

function pad(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function renderSpeedPopup(theme: Theme, metrics: readonly SpeedMetric[], width: number): string[] {
  const inner = Math.max(1, width - 2);
  const body = metrics.map((metric) => {
    const label = theme.fg("muted", metric.label);
    const value = theme.fg(metric.color ?? "text", metric.value);
    const gap = inner - visibleWidth(label) - visibleWidth(value);
    const line = gap >= 1 ? `${label}${" ".repeat(gap)}${value}` : `${label} ${value}`;
    return truncateToWidth(line, inner, "…");
  });
  const border = (left: string, fill: string, right: string) => theme.fg("border", `${left}${fill.repeat(inner)}${right}`);
  const row = (text: string) => `${theme.fg("border", "│")}${theme.bg("customMessageBg", pad(text, inner))}${theme.fg("border", "│")}`;
  return [border("╭", "─", "╮"), ...body.map(row), border("╰", "─", "╯")];
}

interface HoverTui {
  terminal?: { rows: number; columns: number; write?: (data: string) => void };
  requestRender?: () => void;
  showOverlay?: (
    component: { render: (width: number) => string[]; invalidate: () => void; handleMouse?: (event: { type: string }) => { handled?: boolean; render?: boolean } | undefined },
    options: OverlayOptions,
  ) => { hide: () => void; getBounds: () => { row: number; col: number; width: number; height: number } | undefined };
  handleViewportInput?: (data: string) => unknown;
}

export interface SpeedHover {
  hover(x: number, y: number, moving: boolean): void;
  relayout(): void;
  dispose(): void;
}

export function attachSpeedHover(
  tui: HoverTui,
  theme: Theme,
  read: () => { metrics: SpeedMetric[]; hit?: SpeedHit },
): SpeedHover {
  let open = false;
  let pointer = false;
  let pinRight: number | undefined;
  let placed: PopupPlace | undefined;
  let indicatorRow = Math.max(0, (tui.terminal?.rows ?? 1) - 1);
  const options: OverlayOptions = {
    width: SPEED_POPUP_WIDTH,
    row: 0,
    col: 0,
    nonCapturing: true,
    visible: () => open,
  };
  let handle: { hide: () => void; getBounds: () => { row: number; col: number; width: number; height: number } | undefined } | undefined;
  const component = {
    render(width: number) {
      return renderSpeedPopup(theme, read().metrics, width);
    },
    invalidate() {},
    handleMouse(event: { type: string }) {
      if (event.type === "move") return { handled: true, render: false };
      close();
      return { handled: true, render: true };
    },
  };

  const setPointer = (next: boolean) => {
    if (pointer === next || !tui.terminal?.write) return;
    pointer = next;
    tui.terminal.write(`\x1b]22;${next ? "pointer" : "default"}\x07`);
  };

  const layout = () => {
    const metrics = read().metrics;
    const columns = Math.max(1, tui.terminal?.columns ?? SPEED_POPUP_WIDTH);
    const rows = Math.max(1, tui.terminal?.rows ?? indicatorRow + 1);
    indicatorRow = Math.min(indicatorRow, rows - 1);
    const width = Math.min(SPEED_POPUP_WIDTH, columns);
    const height = renderSpeedPopup(theme, metrics, width).length;
    const hit = read().hit;
    const indicatorEnd = hit?.end ?? columns;
    const place = placeSpeedPopup({
      rows, columns, width, height, indicatorRow, indicatorEnd, pinRight,
    });
    if (pinRight === undefined) pinRight = place.col + place.width;
    placed = place;
    options.width = place.width;
    options.row = place.row;
    options.col = place.col;
    options.maxHeight = place.height;
    options.margin = { top: 0, left: 0, right: 0, bottom: Math.max(0, rows - indicatorRow) };
  };

  const ensure = () => {
    if (handle || !tui.showOverlay) return;
    handle = tui.showOverlay(component, options);
  };

  const close = () => {
    if (!open && !pointer) return;
    open = false;
    pinRight = undefined;
    placed = undefined;
    setPointer(false);
    tui.requestRender?.();
  };

  const hover = (x: number, y: number, moving: boolean) => {
    const { metrics, hit } = read();
    const rows = Math.max(1, tui.terminal?.rows ?? y + 1);
    if (y >= 0 && y < rows && hit && y === rows - 1) indicatorRow = y;
    const onIndicator = !!hit && moving && y === indicatorRow && x >= hit.start && x < hit.end;
    const onPopup = !!placed && open && x >= placed.col && x < placed.col + placed.width && y >= placed.row && y < placed.row + placed.height;
    if (!moving || (!onIndicator && !onPopup) || metrics.length === 0) {
      close();
      return;
    }
    const wasOpen = open;
    if (!wasOpen) pinRight = undefined;
    layout();
    open = true;
    ensure();
    setPointer(onIndicator);
    if (!wasOpen) tui.requestRender?.();
  };

  const previous = tui.handleViewportInput?.bind(tui);
  const wrapped = (data: string) => {
    if (data === "\x1b[O") close();
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse && (Number(mouse[1]) & 64) === 0) {
      const button = Number(mouse[1]);
      const x = Number(mouse[2]) - 1;
      const y = Number(mouse[3]) - 1;
      const moving = (button & 32) !== 0 && mouse[4] === "M";
      hover(x, y, moving);
    }
    return previous?.(data);
  };
  if (previous) tui.handleViewportInput = wrapped;

  return {
    hover,
    relayout() {
      if (!open) return;
      layout();
      tui.requestRender?.();
    },
    dispose() {
      open = false;
      setPointer(false);
      handle?.hide();
      handle = undefined;
      if (previous && tui.handleViewportInput === wrapped) tui.handleViewportInput = previous;
    },
  };
}
