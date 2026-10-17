import { allocateImageId, deleteKittyImage, getCellDimensions, getImageDimensions, getOsc8LinkAtColumn, matchesKey, renderImage, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Enhancements } from "./input-enhancements-types.ts";
import { imageLayoutKey, previewLines } from "./input-image-graphics.ts";
import { IMAGE_MIME, readPreview, type Preview } from "./input-image-paths.ts";
import { inlinePreviewLines } from "./input-inline-images.ts";

export function setPointer(state: Enhancements, pointer: boolean): void {
  if (state.pointer === pointer) return;
  if (pointer || state.pointer) state.tui?.terminal.write(`\x1b]22;${pointer ? "pointer" : "default"}\x07`);
  state.pointer = pointer;
}

/** Show a local file selected in its folder. Windows paste stays available off a file link. */
export function revealInFolder(path: string, launch: typeof spawn = spawn): boolean {
  if (!existsSync(path)) return false;
  // macOS and Windows can select the file. Other desktops open its folder.
  const [command, args] = process.platform === "darwin" ? ["open", ["-R", path]]
    : process.platform === "win32" ? ["explorer.exe", [`/select,${path}`]]
      : ["xdg-open", [dirname(path)]];
  launch(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  return true;
}

function linkedFile(screen: string[] | undefined, x: number, y: number): string | undefined {
  const url = getOsc8LinkAtColumn(screen?.[y] ?? "", x);
  if (!url?.startsWith("file:")) return;
  try {
    const path = fileURLToPath(url);
    return existsSync(path) ? path : undefined;
  } catch { return; }
}

export function handleTerminalInput(state: Enhancements, data: string): { consume?: boolean } | undefined {
  if (data === "\x1b[O") { setPointer(state, false); void requestPreview(state, undefined); }
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (mouse) {
    const button = Number(mouse[1]), x = Number(mouse[2]) - 1, y = Number(mouse[3]) - 1;
    // ponytail: Pi 0.85 has no public screen hit-test API; inspect its last rendered OSC 8 cells.
    const screen = (state.tui as TUI & { previousScreen?: string[] } | undefined)?.previousScreen;
    const moving = !!(button & 32) && mouse[4] === "M";
    // Fullscreen treats a secondary press as selection. Reveal the linked file first.
    if (!moving && mouse[4] === "M" && (button & 3) === 2 && state.enabled()) {
      const path = linkedFile(screen, x, y);
      if (path && revealInFolder(path, state.reveal)) return { consume: true };
    }
    if (!moving) { setPointer(state, false); void requestPreview(state, undefined); return undefined; }
    const cached = state.hoverLink;
    const sameTarget = cached?.row === y && x >= cached.start && x < cached.end;
    const url = state.enabled()
      ? sameTarget ? pathToFileURL(cached.path).href : getOsc8LinkAtColumn(screen?.[y] ?? "", x)
      : undefined;
    let path: string | undefined;
    if (url?.startsWith("file:")) {
      try { const file = fileURLToPath(url); if (IMAGE_MIME[extname(file).toLowerCase()]) path = file; } catch { /* Reject malformed or remote file URLs. */ }
    }
    if (path && (path !== state.requestedPath || !sameTarget)) {
      state.previewAnchor = { x, y };
      if (path === state.requestedPath && state.preview.path) { positionPreview(state); state.previewTui?.requestRender(); }
      let start = x, end = x + 1;
      const line = screen?.[y] ?? "";
      while (start > 0 && getOsc8LinkAtColumn(line, start - 1) === url) start--;
      while (end < visibleWidth(line) && getOsc8LinkAtColumn(line, end) === url) end++;
      state.hoverLink = { row: y, start, end, path };
    } else if (!path) state.hoverLink = undefined;
    setPointer(state, !!path);
    void requestPreview(state, path);
  }
  if (!state.preview.path || !matchesKey(data, "escape")) return undefined;
  void requestPreview(state, undefined);
  return { consume: true };
}

export async function requestPreview(state: Enhancements, path: string | undefined): Promise<void> {
  if (path && state.enabled() && path === state.requestedPath) return;
  if (!path || !state.enabled()) state.hoverLink = undefined;
  if (!path && !state.requestedPath && !state.preview.path) return;
  state.requestedPath = state.enabled() ? path : undefined;
  const token = ++state.previewToken;
  if (!path || !state.enabled()) {
    setPreview(state, undefined);
    return;
  }
  const cells = getCellDimensions();
  const preview = await readPreview(path, state.cwd ?? process.cwd(), {
    widthPx: Math.max(1, (state.tui?.terminal.columns ?? 80) - 2) * cells.widthPx,
    heightPx: Math.max(1, (state.tui?.terminal.rows ?? 24) - 2) * cells.heightPx,
  });
  if (token !== state.previewToken || !state.enabled()) return;
  setPreview(state, preview);
}

function setPreview(state: Enhancements, preview: Preview | undefined): void {
  // Overlay visibility only erases text; explicitly free the image owned by this preview.
  if (state.preview.graphic?.imageId) state.tui?.terminal.write(deleteKittyImage(state.preview.graphic.imageId));
  state.previewSource = preview;
  state.previewLayout = imageLayoutKey();
  const dimensions = preview?.kind === "image" ? getImageDimensions(preview.base64, preview.mimeType) : undefined;
  const bandWidth = state.previewMode() === "inline" && state.editor && state.theme
    ? visibleWidth(inlinePreviewLines(state, state.theme, state.tui?.terminal.columns ?? 80)[0] ?? "") : 0;
  const available = (state.tui?.terminal.columns ?? 80) - (bandWidth ? bandWidth + 4 : 2);
  const graphic = preview?.kind === "image" && dimensions ? renderImage(preview.base64, dimensions, {
    maxWidthCells: Math.max(1, Math.min(Math.floor(dimensions.widthPx / getCellDimensions().widthPx), available)),
    maxHeightCells: Math.max(1, (state.tui?.terminal.rows ?? 24) - 2),
    imageId: allocateImageId(), moveCursor: false,
  }) ?? undefined : undefined;
  state.preview = {
    path: preview?.path, graphic,
    note: preview?.kind === "note" ? preview.note : graphic ? undefined : "终端未能生成图片预览",
  };
  if (state.preview.path && !state.overlayReady) showOverlay(state);
  positionPreview(state);
  state.previewTui?.requestRender();
}

function showOverlay(state: Enhancements): void {
  if (!state.tui || !state.theme) return;
  state.overlayReady = true;
  state.previewOptions = { width: 60, maxHeight: "100%", nonCapturing: true, visible: () => state.enabled() && state.preview.path !== undefined };
  state.previewHandle = state.tui.showOverlay({
    render: width => {
      if (state.previewLayout !== imageLayoutKey()) setPreview(state, state.previewSource);
      return previewLines(state.preview, state.theme!, width);
    },
    invalidate: () => {},
  }, state.previewOptions);
}

export function positionPreview(state: Enhancements): void {
  if (!state.previewOptions || !state.tui || !state.theme) return;
  const { rows, columns } = state.tui.terminal;
  const width = Math.max(3, Math.min((state.preview.graphic?.columns ?? 26) + 2, columns || 80));
  const height = Math.min(rows, previewLines(state.preview, state.theme, width).length);
  const { x, y } = state.previewAnchor ?? { x: 0, y: rows - 2 };
  const previewRow = y + 1 + height <= rows ? y + 1 : Math.max(0, y - height);
  // Keep hover previews out of the draft attachment band. If there is no safe
  // vertical gap, move to the side rather than painting over the thumbnail.
  const band = state.previewMode() === "inline" && state.editor && state.theme
    ? inlinePreviewLines(state, state.theme, columns).length : 0;
  const overlapsBand = band > 0 && previewRow < y && previewRow + height > y - band - 1;
  const bandWidth = band && state.theme && state.editor ? visibleWidth(inlinePreviewLines(state, state.theme, columns)[0] ?? "") : 0;
  const side = Math.min(columns - width, bandWidth + 2);
  const beside = overlapsBand && side >= bandWidth + 2;
  Object.assign(state.previewOptions, { width, col: beside ? side : Math.max(0, Math.min(x, columns - width)),
    row: beside ? Math.max(0, Math.min(y + 1, rows - height)) : previewRow });
}
