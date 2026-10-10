import { Image, Marked, deleteKittyImage, type Component } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { fileLink, localPath } from "./file-links.ts";
import { imagePathsInLine, readPreview } from "./input-enhancements.ts";
import { commitImageCursor } from "./image-placement.ts";

const parser = new Marked();
export interface AssistantImageSpan { start: number; end: number; path: string }

/** Parse image syntax before bare paths, retaining source offsets for placement. */
export function assistantImageSpans(source: string, cwd: string, allowMissing = false): AssistantImageSpan[] {
  const spans: AssistantImageSpan[] = [];
  let cursor = 0;
  let offset = 0;
  const code: Array<[number, number]> = [];
  const tokens = parser.lexer(source);
  for (const token of tokens) {
    if (token.type === "code") code.push([offset, offset + token.raw.length]);
    offset += token.raw.length;
  }
  const inCode = (start: number, end: number) => code.some(([from, to]) => start < to && end > from);
  parser.walkTokens(tokens, token => {
    if (token.type !== "image") return;
    let start = source.indexOf(token.raw, cursor);
    while (start >= 0 && inCode(start, start + token.raw.length)) start = source.indexOf(token.raw, start + token.raw.length);
    if (start < 0) return;
    cursor = start + token.raw.length;
    let path = token.href;
    try {
      if (path.startsWith("file:")) path = fileURLToPath(path);
      else if (/^[a-z][\w+.-]*:|^\/\//i.test(path)) return;
      path = localPath(path, cwd);
    } catch { return; }
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(path)) spans.push({ start, end: cursor, path });
  });
  // The path parser excludes fenced code and handles shell-escaped spaces.
  for (const match of imagePathsInLine(source)) {
    if (!inCode(match.start, match.end) && !spans.some(span => match.start < span.end && match.end > span.start)) {
      spans.push({ start: match.start, end: match.end, path: localPath(match.path, cwd) });
    }
  }
  return spans.filter(span => existsSync(span.path) || (allowMissing
    && !/[*?]/.test(span.path)
    && /^(?:!\[|\/|~\/|\.{1,2}\/|[a-z]:[\\/])/i.test(source.slice(span.start, span.end))))
    .sort((a, b) => a.start - b.start);
}

/** Keep explicit image references compact even after clipboard files have expired. */
export function imagePlaceholders(source: string, cwd: string): string {
  const spans = assistantImageSpans(source, cwd, true);
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    source = source.slice(0, span.start) + fileLink(`  图片 ${index + 1}`, span.path, false) + source.slice(span.end);
  }
  return source;
}

/** Load once outside render, then reuse Pi's Image IDs and complete height rows. */
export function createAssistantImages(cwd: () => string, requestRender: () => void, write: (data: string) => void = () => {}) {
  const cache = new Map<string, { image?: Component & { getImageId?(): number | undefined }; pending?: Promise<void> }>();
  let disposed = false;
  return {
    render(source: string, width: number, markdown: (text: string, width: number) => string[], owner = source): string[] {
      const spans = assistantImageSpans(source, cwd());
      if (!spans.length) return markdown(source, width);
      const rows: string[] = [];
      let cursor = 0;
      for (const span of spans) {
        const before = source.slice(cursor, span.start).trim();
        if (before) rows.push(...markdown(before, width));
        const key = JSON.stringify([owner, span.start, span.path]);
        let entry = cache.get(key);
        if (!entry) {
          entry = {};
          cache.set(key, entry);
          const target = entry;
          target.pending = readPreview(span.path, cwd()).then(preview => {
            if (disposed) return;
            if (preview?.kind === "image") target.image = new Image(preview.base64, preview.mimeType, { fallbackColor: text => text }, { filename: span.path });
            target.pending = undefined;
            requestRender();
          }).catch(() => { target.pending = undefined; });
        }
        if (entry.image) rows.push(...entry.image.render(width).map(commitImageCursor));
        else rows.push(...markdown(source.slice(span.start, span.end).startsWith("![") ? span.path : source.slice(span.start, span.end), width));
        cursor = span.end;
      }
      const after = source.slice(cursor).trim();
      if (after) rows.push(...markdown(after, width));
      return rows;
    },
    dispose() {
      disposed = true;
      for (const entry of cache.values()) {
        const id = entry.image?.getImageId?.();
        if (id !== undefined) write(deleteKittyImage(id));
      }
      cache.clear();
    },
  };
}
