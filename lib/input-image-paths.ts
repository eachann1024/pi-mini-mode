import { resizeImage } from "@earendil-works/pi-coding-agent";
import { getImageDimensions, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { filePaths } from "./file-links.ts";
import { open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_ENCODED_BYTES = 1024 * 1024;
const MAX_PREVIEW_WIDTH_PX = 1200;
const MAX_PREVIEW_HEIGHT_PX = 800;

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface ImagePathMatch {
  path: string;
  /** Source indices in the line (after terminal sequences are stripped). */
  start: number;
  end: number;
  /** Visible columns, for rendered lines. */
  startCol: number;
  endCol: number;
}

function absolutePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Image paths in one line, with source indices and visible columns. */
export function imagePathsInLine(line: string): ImagePathMatch[] {
  const plain = stripTerminalSequences(line);
  const matches: ImagePathMatch[] = [];
  // ponytail: accept existing absolute clipboard paths with spaces; extend to cwd-aware relative paths if needed.
  const spaced = [...plain.matchAll(/(?:^|[\s"'`])((?:\/|~\/|\.\.?\/)[^\n"'`<>()[\]{}，。；！？]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`<>()[\]{}，。；！？])/gi)]
    .map(match => ({ path: match[1], start: match.index + match[0].length - match[1].length, end: match.index + match[0].length }))
    .filter(match => isAbsolute(match.path) && match.path.includes(" ") && existsSync(match.path));
  for (const { path, start, end } of [...spaced, ...filePaths(plain).filter(match => !spaced.some(full => match.start >= full.start && match.start < full.end))]) {
    if (!IMAGE_MIME[extname(path).toLowerCase()]) continue;
    matches.push({ path, start, end, startCol: visibleWidth(plain.slice(0, start)), endCol: visibleWidth(plain.slice(0, end)) });
  }
  return matches;
}

/** Image path token the cursor sits in, if any. */
export function imagePathAtCursor(text: string, line: number, col: number): string | undefined {
  const current = text.split("\n")[line];
  if (current === undefined) return undefined;
  return imagePathsInLine(current).find((match) => col >= match.start && col <= match.end)?.path;
}

/** OSC 8 target for an image path: the `file://` URL of its directory. */
export function imageDirectoryUrl(path: string, cwd: string): string {
  return pathToFileURL(dirname(absolutePath(path, cwd))).href;
}

export interface PreviewImage {
  kind: "image";
  path: string;
  mimeType: string;
  base64: string;
  widthPx: number;
  heightPx: number;
}
export interface PreviewNote {
  kind: "note";
  path: string;
  note: string;
}
export type Preview = PreviewImage | PreviewNote;

/**
 * Read a preview for an image path. Returns undefined when there is nothing to show
 * (unknown extension, missing file, directory) so typing never raises a hint.
 */
export async function readPreview(path: string, cwd: string, bounds = { widthPx: MAX_PREVIEW_WIDTH_PX, heightPx: MAX_PREVIEW_HEIGHT_PX }): Promise<Preview | undefined> {
  const absolute = absolutePath(path, cwd);
  const mimeType = IMAGE_MIME[extname(absolute).toLowerCase()];
  if (!mimeType) return undefined;
  const file = await open(absolute, "r").catch(() => undefined);
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile()) return undefined;
    if (info.size > MAX_PREVIEW_BYTES) return { kind: "note", path, note: `超过 ${MAX_PREVIEW_BYTES / 1024 / 1024}MB` };
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const data = bytes.subarray(0, offset);
    const base64 = data.toString("base64");
    const dimensions = getImageDimensions(base64, mimeType);
    if (!dimensions) return { kind: "note", path, note: "无法解析图片尺寸" };
    const maxWidth = Math.max(1, Math.min(MAX_PREVIEW_WIDTH_PX, Math.floor(bounds.widthPx)));
    const maxHeight = Math.max(1, Math.min(MAX_PREVIEW_HEIGHT_PX, Math.floor(bounds.heightPx)));
    // renderImage controls cell placement, not pixels; its Kitty f=100 payload must be PNG.
    const resized = dimensions.widthPx <= maxWidth && dimensions.heightPx <= maxHeight && base64.length < MAX_PREVIEW_ENCODED_BYTES
      ? { data: base64, mimeType } : await resizeImage(data, mimeType, { maxWidth, maxHeight, maxBytes: MAX_PREVIEW_ENCODED_BYTES });
    if (!resized) return { kind: "note", path, note: "无法缩小图片预览" };
    const png = resized.mimeType === "image/png" ? resized
      : await (await import("@earendil-works/pi-coding-agent")).convertToPng(resized.data, resized.mimeType);
    if (!png) return { kind: "note", path, note: "无法转换图片预览" };
    if (png.data.length > MAX_PREVIEW_ENCODED_BYTES) return { kind: "note", path, note: "图片预览过大" };
    return { kind: "image", path, mimeType: png.mimeType, base64: png.data, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx };
  } catch {
    return { kind: "note", path, note: "读取失败" };
  } finally { await file.close(); }
}
