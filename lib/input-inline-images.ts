import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allocateImageId, deleteKittyImage, encodeKitty, getCapabilities, getCellDimensions, getImageDimensions, renderImage, truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";
import type { Enhancements } from "./input-enhancements-types.ts";
import { editorImagePaths } from "./input-editor-paths.ts";
import { imageLayoutKey, positionedGraphic } from "./input-image-graphics.ts";
import { readPreview } from "./input-image-paths.ts";

function draftImagePaths(editor: EditorComponent): string[] {
  const source = (editor as EditorComponent & { state?: { lines: string[] } }).state?.lines ?? editor.getText().split("\n");
  return source.flatMap(line => editorImagePaths(editor, line).map(match => match.path));
}

export function clearInlineGraphics(state: Pick<Enhancements, "inlineGraphics" | "tui">): void {
  for (const graphic of state.inlineGraphics.values()) {
    if (graphic.imageId) state.tui?.terminal.write(deleteKittyImage(graphic.imageId));
  }
  state.inlineGraphics.clear();
}

/** Only the editing draft is shown here; history hover remains the separate mode. */
export function syncInlineImages(state: Enhancements): void {
  const paths = state.editor && state.enabled() && state.previewMode() === "inline"
    ? [...new Set(draftImagePaths(state.editor))].slice(0, 15) : [];
  if (!paths.length) clearInlineGraphics(state);
  for (const path of state.inlineImages.keys()) if (!paths.includes(path)) { state.inlineImages.delete(path); clearInlineGraphics(state); }
  for (const path of state.inlinePending.keys()) if (!paths.includes(path)) state.inlinePending.delete(path);
  for (const path of paths) {
    if (state.inlineImages.has(path) || state.inlinePending.has(path)) continue;
    const cwd = state.cwd ?? process.cwd();
    // Cell placement scales the image; keep a bounded copy independent of startup cell metrics.
    const pending = readPreview(path, cwd).catch(() => undefined);
    state.inlinePending.set(path, pending);
    void pending.then(preview => {
      if (state.inlinePending.get(path) !== pending) return;
      state.inlinePending.delete(path);
      if (!state.editor || !state.enabled() || state.previewMode() !== "inline" || !draftImagePaths(state.editor).includes(path)) return;
      state.inlineImages.set(path, preview);
      state.tui?.requestRender();
    });
  }
}

export function inlinePreviewLines(state: Pick<Enhancements, "editor" | "enabled" | "previewMode" | "inlineImages" | "inlinePending" | "inlineGraphics" | "tui">, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  const paths = state.editor && state.enabled() && state.previewMode() === "inline" && width >= 12 ? draftImagePaths(state.editor) : [];
  if (!paths.length) { clearInlineGraphics(state); return []; }
  const cardWidth = Math.min(14, width);
  // ponytail: cards are capped at one row; beyond viewport width show compact numbered tags, upgrade to a gallery when scrolling is supported.
  const count = Math.max(1, Math.floor((width + 2) / (cardWidth + 2)));
  const protocol = getCapabilities().images;
  const layout = `${cardWidth}:${imageLayoutKey()}`;
  const keys = paths.slice(0, count).map((path, index) => `${index}:${path}`);
  if ([...state.inlineGraphics].some(([key, graphic]) => graphic.layout !== layout || !keys.includes(key))) clearInlineGraphics(state);
  const rows: string[] = [];
  const color = (index: number, text: string) => theme.fg((["warning", "accent", "success", "error"] as const)[index % 4], text);
  {
    const cards = paths.slice(0, count).map((path, index) => {
      const key = `${index}:${path}`;
      const preview = state.inlineImages.get(path);
      const dimensions = preview?.kind === "image" ? getImageDimensions(preview.base64, preview.mimeType) : undefined;
      let graphic = state.inlineGraphics.get(key);
      if (preview?.kind === "image" && dimensions && protocol && !graphic) {
        const cells = getCellDimensions();
        const scale = Math.min((cardWidth - 2) * cells.widthPx / dimensions.widthPx, 4 * cells.heightPx / dimensions.heightPx);
        const columns = Math.min(cardWidth - 2, Math.ceil(dimensions.widthPx * scale / cells.widthPx));
        const rows = Math.min(4, Math.ceil(dimensions.heightPx * scale / cells.heightPx));
        const imageId = protocol === "kitty" ? allocateImageId() : undefined;
        // ponytail: bottom-row placement must not register top-row crop metadata; use Pi's encoder until its layout API supports positioned graphics.
        const rendered = protocol === "kitty"
          ? { sequence: encodeKitty(preview.base64, { imageId, columns, rows, moveCursor: false }), imageId, rows, columns }
          : renderImage(preview.base64, dimensions, { maxWidthCells: cardWidth - 2, maxHeightCells: 4, moveCursor: false });
        if (rendered) { graphic = { layout, ...rendered }; state.inlineGraphics.set(key, graphic); }
      }
      const frame = (text: string) => color(index, text);
      const rim = (text: string, top: boolean) => {
        const caption = truncateToWidth(text, cardWidth - 4, "…");
        const fill = cardWidth - 4 - visibleWidth(caption);
        return frame(`${top ? "╭" : "╰"}${"─".repeat(Math.floor(fill / 2))} ${caption} ${"─".repeat(Math.ceil(fill / 2))}${top ? "╮" : "╯"}`);
      };
      const top = rim(`  #${index + 1}`, true);
      const size = preview?.kind === "image" ? `${preview.widthPx}x${preview.heightPx}` : state.inlinePending.has(path) ? "加载中" : "无法预览";
      return { graphic, preview, top, size, rim, frame };
    });
    // OMP's 12x4 inner grid; never grow a tall empty box for a wide image.
    const bodyHeight = 4;
    rows.push(cards.map(card => card.top).join("  "));
    for (let row = 0; row < bodyHeight; row++) rows.push(cards.map(card => {
      const content = row === 0 && !card.graphic ? truncateToWidth(card.preview?.kind === "note" ? card.preview.note : card.size === "加载中" ? "加载中" : "无法预览", cardWidth - 4, "…") : "";
      const left = card.graphic ? Math.floor((cardWidth - 2 - card.graphic.columns) / 2) : 0;
      return card.frame("│") + " ".repeat(left) + " ".repeat(cardWidth - 2 - left - visibleWidth(content)) + content + card.frame("│");
    }).join("  "));
    const bottom = cards.map(card => card.rim(card.size, false)).join("  ");
    // Draw the cleared card first, then place images over its interior from the final row.
    const drawings = cards.map((card, index) => {
      if (!card.graphic) return "";
      const topPad = Math.floor((bodyHeight - card.graphic.rows) / 2);
      const leftPad = Math.floor((cardWidth - 2 - card.graphic.columns) / 2);
      const up = bodyHeight - topPad;
      const right = index * (cardWidth + 2) + leftPad + 1;
      return positionedGraphic(card.graphic.sequence, up, right);
    }).join("");
    rows.push(drawings + bottom);
  }
  if (paths.length > count) {
    rows.push("");
    let line = "";
    for (let index = count; index < paths.length; index++) {
      const tag = color(index, `  #${index + 1}`);
      if (visibleWidth(line) + visibleWidth(tag) + 2 > width) { rows.push(line); line = ""; }
      line += (line ? "  " : "") + tag;
    }
    if (line) rows.push(line);
  }
  return rows;
}
