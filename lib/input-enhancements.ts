/**
 * Pi Mini Mode input enhancements.
 *
 * Adds, on top of Pi's native input handling (never replacing it):
 * - skill completion for `/` at the line start or after whitespace, including `/skill:name`
 * - inline `/skill:name` expansion (single leading skill commands stay native)
 * - image-path preview in a non-capturing overlay (editing cursor and editor hover)
 * - compact image labels with OSC 8 links to the original file
 *
 * Wiring: call `installInputEnhancements(pi, ctx, () => enabled)` from `session_start`
 * and call cleanup.refresh() when the setting changes; call cleanup from
 * `session_shutdown`.
 */
import { CustomEditor, resizeImage, stripFrontmatter, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, allocateImageId, deleteKittyImage, encodeKitty, getCellDimensions, getImageDimensions, renderImage, getCapabilities, getOsc8LinkAtColumn, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth,
  type AutocompleteItem, type AutocompleteProvider, type EditorComponent, type TuiMouseEvent, type TUI, type OverlayHandle, type OverlayOptions,
} from "@earendil-works/pi-tui";
import { filePaths, inputCapabilities, linkRenderedPath, localPath, webPaths } from "./file-links.ts";
import { open, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INPUT_ENHANCEMENTS_SETTING = "pi-mini-mode-input-enhancements";
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_ENCODED_BYTES = 1024 * 1024;
const MAX_PREVIEW_WIDTH_PX = 1200;
const MAX_PREVIEW_HEIGHT_PX = 800;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const SKILL_TOKEN = /(?:^|\s)(\/skill:[^\s/]+)/g;
const SKILL_PREFIX = /(?:^|[ \t])(\/(?:skill:)?[^/\s]*)$/;

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

export interface SkillEntry {
  /** Registry command name, e.g. `skill:release`. */
  command: string;
  name: string;
  path: string;
  baseDir: string;
}

/** Skills registered for this session, keyed by command name (`skill:<name>`). */
export function readSkillCommands(pi: Pick<ExtensionAPI, "getCommands">): Map<string, SkillEntry> {
  const skills = new Map<string, SkillEntry>();
  for (const command of pi.getCommands()) {
    const path = command.sourceInfo?.path;
    if (command.source !== "skill" || !path) continue;
    skills.set(command.name, { command: command.name, name: command.name.replace(/^skill:/, ""), path, baseDir: command.sourceInfo.baseDir ?? dirname(path) });
  }
  return skills;
}

/** Same wrapper the core `_expandSkillCommand` uses. */
export function skillBlock(skill: SkillEntry, body: string): string {
  return `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export interface SkillToken {
  token: string;
  start: number;
  end: number;
}

/** `/skill:name` tokens at whitespace boundaries. */
export function skillTokensIn(text: string): SkillToken[] {
  const tokens: SkillToken[] = [];
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const token = match[1];
    const start = match.index + match[0].length - token.length;
    tokens.push({ token, start, end: start + token.length });
  }
  return tokens;
}

/**
 * Expand registered `/skill:name` tokens that the core would not expand itself.
 * Leave single leading skills to the core; expand multiple skills in place.
 */
export async function expandSkillTokens(
  text: string,
  skills: Map<string, SkillEntry>,
  readSkill: (path: string) => Promise<string>,
  onError: (skill: SkillEntry, error: unknown) => void,
): Promise<string | undefined> {
  const tokens = skillTokensIn(text).filter((token) => skills.has(token.token.slice(1)));
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].start === 0)) return undefined;
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const skill = skills.get(token.token.slice(1));
    if (!skill) continue;
    let body: string;
    try {
      body = stripFrontmatter(await readSkill(skill.path)).trim();
    } catch (error) {
      onError(skill, error);
      continue; // Keep the token verbatim and let the rest of the text survive.
    }
    parts.push(text.slice(cursor, token.start), skillBlock(skill, body));
    cursor = token.end;
  }
  if (parts.length === 0) return undefined;
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Skill completion layered on the built-in provider. */
export function createSkillAutocompleteProvider(current: AutocompleteProvider, listSkills: () => Map<string, SkillEntry>, enabled: () => boolean = () => true): AutocompleteProvider {
  return {
    triggerCharacters: ["/"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (!enabled()) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = SKILL_PREFIX.exec(before);
      if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const prefix = match[1];
      const typed = prefix.slice(1).replace(/^skill:/, "");
      const ours: AutocompleteItem[] = [];
      for (const skill of listSkills().values()) {
        if (skill.command.startsWith(`skill:${typed}`) || skill.name.startsWith(typed)) ours.push({ value: `/${skill.command}`, label: skill.command });
      }
      // Mid-line only skills: the built-in provider would offer file paths there.
      if (cursorLine !== 0 || prefix.length !== before.length) return ours.length > 0 ? { items: ours, prefix } : current.getSuggestions(lines, cursorLine, cursorCol, options);
      const builtin = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const items = (builtin?.items ?? []).filter((item) => !ours.some((skill) => skill.value.slice(1) === item.value.replace(/^\//, "")));
      if (items.length === 0 && ours.length === 0) return null;
      return { items: [...items, ...ours], prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!item.value.startsWith("/skill:")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      // The built-in provider special-cases line-start slash commands; replace our own fragment.
      const line = lines[cursorLine] ?? "";
      const start = Math.max(0, cursorCol - prefix.length);
      const rest = line.slice(cursorCol);
      const text = `${item.value}${/^[ \t]/.test(rest) ? "" : " "}`;
      const next = [...lines];
      next[cursorLine] = `${line.slice(0, start)}${text}${rest}`;
      return { lines: next, cursorLine, cursorCol: start + text.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export interface PreviewState {
  path?: string;
  note?: string;
  graphic?: NonNullable<ReturnType<typeof renderImage>>;
}

function positionedGraphic(sequence: string, up: number, right: number): string {
  // Pi <=0.87's ANSI slicer needs an SGR terminator after relative motion.
  // Otty places Kitty graphics against the last committed cursor while DEC 2026
  // buffers text/cursor updates. Commit the target before the APC, then resume
  // Pi's synchronized frame. Other terminals retain their atomic rendering.
  const flush = process.env.TERM_PROGRAM?.toLowerCase() === "otty"
    && !process.env.TMUX && !process.env.STY && !/^(tmux|screen)/i.test(process.env.TERM ?? "")
    && sequence.startsWith("\x1b_G");
  return `\x1b[s\x1b[${up}A\x1b[${right}C\x1b[0m${flush ? "\x1b[?2026l\x1b[0m" : ""}${sequence}\x1b[u${flush ? "\x1b[?2026h" : ""}\x1b[0m`;
}

function imageLayoutKey(): string {
  const cells = getCellDimensions();
  return `${getCapabilities().images}:${cells.widthPx}:${cells.heightPx}`;
}

/** A tightly sized image frame. Draw after clearing its interior, never a path-only tooltip. */
export function previewLines(preview: PreviewState, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
  if (!preview.path) return [];
  const graphic = preview.graphic;
  const innerWidth = Math.max(1, Math.min(width - 2, graphic?.columns ?? 26));
  const border = (text: string) => theme.fg("border", text);
  const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
  if (graphic) {
    for (let row = 0; row < graphic.rows; row++) lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
  } else lines.push(border("│") + truncateToWidth(preview.note ?? "无法预览图片", innerWidth, "", true) + border("│"));
  const draw = graphic ? positionedGraphic(graphic.sequence, graphic.rows, 1) : "";
  lines.push(draw + border(`╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

type EditorFactoryFunction = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type CursorEditor = EditorComponent & { getCursor?(): { line: number; col: number } };

export interface InputEnhancementsCleanup {
  (): void;
  refresh(): void;
}

interface Enhancements {
  pi: ExtensionAPI;
  enabled: () => boolean;
  ctx?: ExtensionContext;
  cwd?: string;
  theme?: ExtensionContext["ui"]["theme"];
  generation?: unknown;
  preview: PreviewState;
  previewSource?: Preview;
  previewLayout?: string;
  previewToken: number;
  overlayReady: boolean;
  previewTui?: { requestRender(): void };
  previewHandle?: OverlayHandle;
  tui?: TUI;
  requestedPath?: string;
  pointer?: boolean;
  previewAnchor?: { x: number; y: number };
  hoverLink?: { row: number; start: number; end: number; path: string };
  previewOptions?: OverlayOptions;
  previewMode: () => "hover" | "inline";
  inlineImages: Map<string, Preview | undefined>;
  inlinePending: Map<string, Promise<Preview | undefined>>;
  inlineGraphics: Map<string, { layout: string } & NonNullable<ReturnType<typeof renderImage>>>;
  baseFactory?: EditorFactoryFunction;
  editor?: EditorComponent;
  editorFactory?: EditorFactoryFunction;
  unsubscribeInput?: () => void;
  restoreViewportInput?: () => void;
  cleanup: InputEnhancementsCleanup;
}

let installed: Enhancements | undefined;
let viewportHook: { restore(): void } | undefined;

/** TUI survives /new; detach any previous instance's mouse hook before wrapping again. */
function unhookViewportInput(): void {
  viewportHook?.restore();
  viewportHook = undefined;
}

function hookViewportInput(tui: TUI, onInput: (data: string) => void): () => void {
  unhookViewportInput();
  const viewport = tui as TUI & { handleViewportInput?(data: string): { consume?: boolean } | undefined };
  const original = viewport.handleViewportInput;
  if (!original) return () => {};
  const observe = (data: string) => {
    onInput(data);
    return original.call(tui, data);
  };
  viewport.handleViewportInput = observe;
  const hook = {
    restore() {
      if (viewport.handleViewportInput === observe) viewport.handleViewportInput = original;
    },
  };
  viewportHook = hook;
  return () => {
    if (viewportHook !== hook) return;
    unhookViewportInput();
  };
}

function liveUI(ctx?: ExtensionContext): ExtensionContext["ui"] | undefined {
  if (!ctx) return undefined;
  try {
    return ctx.ui;
  } catch {
    return undefined;
  }
}

/** Compact image attachments without losing their paths on submit, reload, or external editing. */
function wrapEditor(inner: EditorComponent, cwd: string, isEnabled: () => boolean, isInline: () => boolean, theme: ExtensionContext["ui"]["theme"], inlineState: Enhancements, onCursor: () => void, onHoverEditor: (editor: EditorComponent, event: TuiMouseEvent) => void, onEditorRender: () => void = () => {}): EditorComponent {
  const attachments = new Map<string, string>();
  const sources = new Map<string, string>();
  const expand = (text: string) => text.replace(/\[img\d+\]/g, (label, index) => {
    const path = sources.get(label) ?? attachments.get(label);
    const next = /^\[img\d+\]/.exec(text.slice(index + label.length));
    return path === undefined ? label : path + (next && attachments.has(next[0]) ? " " : "");
  });
  const compact = (text: string) => {
    if (!isEnabled()) return text;
    const replacements = imagePathsInLine(text).map(match => {
      const source = text.slice(match.start, match.end);
      let label = [...attachments].find(([label, path]) => path === match.path && (sources.get(label) ?? path) === source)?.[0];
      if (!label) {
        label = `[img${attachments.size + 1}]`;
        attachments.set(label, match.path);
        sources.set(label, source);
      }
      return { ...match, label };
    });
    for (const match of replacements.reverse()) text = text.slice(0, match.start) + match.label + text.slice(match.end);
    return text;
  };
  // ponytail: Pi 0.87 image paste calls the private inserter, bypassing the public proxy; replace with a public attachment API when available.
  const core = inner as EditorComponent & { expandPasteMarkers?(text: string): string; insertTextAtCursorInternal?(text: string): void; setTextInternal?(text: string, placement?: "start" | "end"): void; segment?(text: string, mode?: string): Array<{ segment: string; index: number; input: string }>; imageAttachments?: Map<string, string>; state?: { lines: string[] } };
  core.imageAttachments = attachments;
  // Rendering reads the stored lines directly, so the submit expansion must not put the temp path back on screen.
  if (core.state) core.state.lines = compact(core.state.lines.join("\n")).split("\n");
  if (core.expandPasteMarkers) { const original = core.expandPasteMarkers.bind(core); core.expandPasteMarkers = text => expand(original(text)); }
  if (core.insertTextAtCursorInternal) { const insert = core.insertTextAtCursorInternal.bind(core); core.insertTextAtCursorInternal = text => insert(compact(text)); }
  // Native history navigation bypasses setText; compact the restored draft before its onChange/render.
  if (core.setTextInternal) { const restore = core.setTextInternal.bind(core); core.setTextInternal = (text, placement) => restore(compact(text), placement); }
  const pasteEditor = inner as EditorComponent & { handlePaste?(text: string): void };
  if (pasteEditor.handlePaste) { const paste = pasteEditor.handlePaste.bind(inner); pasteEditor.handlePaste = text => paste(compact(text)); }
  if (core.segment) {
    const original = core.segment.bind(core);
    core.segment = (text, mode) => {
      const spans = [...text.matchAll(/\[img\d+\]/g)].filter(match => attachments.has(match[0]));
      return [...original(text, mode)].flatMap(segment => {
        const span = spans.find(match => segment.index >= match.index && segment.index < match.index + match[0].length);
        return !span ? [segment] : segment.index === span.index ? [{ segment: span[0], index: span.index, input: text }] : [];
      });
    };
  }
  let onChange: ((text: string) => void) | undefined;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "getText") return () => expand(target.getText());
      if (property === "setText" || property === "insertTextAtCursor" || property === "insertTextAtCursorInternal") return (text: string) => { const insert = (target as EditorComponent & { insertTextAtCursorInternal?(value: string): void })[property] as ((value: string) => void) | undefined; insert?.call(target, compact(text)); onEditorRender(); };
      if (property === "render") {
        return (width: number) => {
          const lines = target.render(width);
          onEditorRender();
          const linked = isEnabled() ? linkImagePaths(lines, target, cwd, width) : lines;
          if (!isInline()) return linked;
          const cards = inlinePreviewLines(inlineState, theme, width);
          if (!cards.length) return linked;
          // ponytail: Pi's editor has no rich image nodes; keep its cursor/text layout and mask owned tokens only in render. Replace with native attachment nodes when available.
          const labels = new Set(attachments.keys());
          const body = linked.map((line, row) => row > 0 && row <= ((target as EditorComponent & { renderedVisibleLineCount?: number }).renderedVisibleLineCount ?? 0) ? hideImageLabels(line, labels, theme, lines[row]) : line);
          return [...cards, ...body];
        };
      }
      if (property === "handleMouse") {
        return (event: TuiMouseEvent) => {
          const offset = isInline() ? inlinePreviewLines(inlineState, theme, event.width).length : 0;
          const adjusted = offset ? { ...event, y: event.y - offset } : event;
          const result = !offset || event.y >= offset ? target.handleMouse?.(adjusted) : undefined;
          if (event.type === "move") onHoverEditor(target, adjusted);
          else if (event.type === "click") void requestPreview(inlineState, undefined);
          return result;
        };
      }
      if (property === "handleInput") {
        return (data: string) => {
          if (isEnabled() && matchesKey(data, "super+v")) { (target as CustomEditor).onPasteImage?.(); return; }
          target.handleInput(data);
          // Pi explicitly excludes '/' from provider triggerCharacters; request inline completions ourselves.
          const native = target as CursorEditor & { tryTriggerAutocomplete?(): void };
          const cursor = native.getCursor?.();
          if (isEnabled() && cursor && data.length === 1 && /[\w/:-]/.test(data)
            && SKILL_PREFIX.test((target.getText().split("\n")[cursor.line] ?? "").slice(0, cursor.col))) native.tryTriggerAutocomplete?.();
          onCursor();
        };
      }
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value) {
      if (property === "onChange") {
        onChange = value as ((text: string) => void) | undefined;
        return Reflect.set(target, property, (text: string) => {
          onChange?.(expand(text));
          onEditorRender();
          onCursor();
        });
      }
      return Reflect.set(target, property, value);
    },
  }) as EditorComponent;
}

// ponytail: Pi 0.85 editor layout mapping; unknown editors use visible-line matching.
function editorImagePaths(editor: EditorComponent, text: string): ImagePathMatch[] {
  const attachments = (editor as EditorComponent & { imageAttachments?: Map<string, string> }).imageAttachments;
  const paths = imagePathsInLine(text);
  for (const match of text.matchAll(/\[img\d+\]/g)) {
    const path = attachments?.get(match[0]);
    if (path) paths.push({ path, start: match.index, end: match.index + match[0].length, startCol: visibleWidth(text.slice(0, match.index)), endCol: visibleWidth(text.slice(0, match.index + match[0].length)) });
  }
  return paths.sort((a, b) => a.start - b.start);
}

function editorPaths(editor: EditorComponent, row: number, width: number, includeWeb = false, compactImages = false) {
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

function hideImageLabels(line: string, labels: Set<string>, theme: ExtensionContext["ui"]["theme"], original: string): string {
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

function linkImagePaths(lines: string[], editor: EditorComponent, cwd: string, width: number): string[] {
  if (!inputCapabilities().hyperlinks) return lines;
  return lines.map((line, row) => {
    for (const match of editorPaths(editor, row, width, true).reverse()) line = linkRenderedPath(line, match.startCol, match.endCol, /^https?:\/\//i.test(match.path) ? match.path : localPath(match.path, cwd));
    // Isolate editor rows from inherited terminal link/color state.
    const reset = "\x1b]8;;\x07\x1b[0m";
    return reset + line + reset;
  });
}

export function installInputEnhancements(pi: ExtensionAPI, ctx: ExtensionContext, isEnabled: boolean | (() => boolean), previewMode: () => "hover" | "inline" = () => "hover"): InputEnhancementsCleanup {
  const enabled = typeof isEnabled === "function" ? isEnabled : () => isEnabled;
  if (installed && installed.pi !== pi) installed.cleanup();
  const state = installed?.pi === pi ? installed : (installed = createEnhancements(pi));
  state.enabled = enabled;
  state.previewMode = previewMode;
  state.ctx = ctx;
  state.cwd = ctx.cwd;
  state.theme = ctx.hasUI ? ctx.ui.theme : undefined;
  if (ctx.mode === "tui" && ctx.hasUI) {
    const generation = ctx.sessionManager;
    if (state.generation !== generation) {
      state.generation = generation;
      void requestPreview(state, undefined);
      state.inlinePending.clear();
      state.inlineImages.clear();
      clearInlineGraphics(state);
      state.unsubscribeInput?.();
      state.unsubscribeInput = ctx.ui.onTerminalInput?.((data) => handleTerminalInput(state, data)) ?? undefined;
      ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, () => readSkillCommands(pi), () => state.enabled()));
    }
    // /reload clears the editor before session_start, so the saved factory can still be current while the live editor is unwrapped.
    const active = ctx.ui.getEditorComponent();
    if (active !== state.editorFactory || !state.editor) installEditor(ctx, state, active === state.editorFactory ? state.baseFactory : active);
  }
  return state.cleanup;
}

function createEnhancements(pi: ExtensionAPI): Enhancements {
  const state: Enhancements = {
    pi,
    enabled: () => true,
    preview: {},
    previewToken: 0,
    previewMode: () => "hover",
    inlineImages: new Map(),
    inlinePending: new Map(),
    inlineGraphics: new Map(),
    overlayReady: false,
    cleanup: (() => {}) as InputEnhancementsCleanup,
  };
  state.cleanup = Object.assign(
    () => {
      state.unsubscribeInput?.();
      state.unsubscribeInput = undefined;
      state.restoreViewportInput?.();
      state.restoreViewportInput = undefined;
      state.requestedPath = undefined;
      state.previewToken++;
      if (state.preview.graphic?.imageId) state.tui?.terminal.write(deleteKittyImage(state.preview.graphic.imageId));
      state.preview = {};
      state.previewSource = undefined;
      state.previewLayout = undefined;
      state.hoverLink = undefined;
      state.inlineImages.clear();
      state.inlinePending.clear();
      clearInlineGraphics(state);
      setPointer(state, false);
      state.previewHandle?.hide();
      state.previewHandle = undefined;
      state.overlayReady = false;
      state.generation = undefined;
      const ui = liveUI(state.ctx);
      if (ui && state.editorFactory && ui.getEditorComponent() === state.editorFactory) ui.setEditorComponent(state.baseFactory);
      state.ctx = undefined;
      state.cwd = undefined;
      state.theme = undefined;
      state.editor = undefined;
      state.editorFactory = undefined;
    },
    {
      refresh: () => {
        syncInlineImages(state);
        if (state.previewMode() === "inline") { void requestPreview(state, undefined); setPointer(state, false); }
        if (!state.enabled()) {
          void requestPreview(state, undefined);
          setPointer(state, false);
          if (state.editor) state.editor.setText(state.editor.getText());
        }
        state.tui?.invalidate(); state.tui?.requestRender();
      },
    },
  );
  pi.on("input", (event: InputEvent, eventCtx: ExtensionContext): Promise<InputEventResult | undefined> => handleInput(state, event, eventCtx));

  return state;
}

async function handleInput(state: Enhancements, event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | undefined> {
  if (!state.enabled() || event.source !== "interactive" || !event.text.includes("/skill:")) return undefined;
  const skills = readSkillCommands(state.pi);
  const text = await expandSkillTokens(
    event.text,
    skills,
    (path) => readFile(path, "utf8"),
    (skill) => ctx.ui.notify(`无法读取技能文件：${skill.path}`, "warning"),
  );
  return text === undefined ? undefined : { action: "transform", text };
}

/** Wrap the current editor factory (or the default editor) so enhancements ride on top of it. */
function installEditor(ctx: ExtensionContext, state: Enhancements, base?: EditorFactoryFunction): void {
  const create: EditorFactoryFunction = base ?? ((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));
  const factory: EditorFactoryFunction = (tui, theme, keybindings) => {
    state.tui = tui;
    state.previewTui = tui;
    // ponytail: fullscreen's first input listener consumes mouse events before extension listeners.
    // Observe its entry point until Pi exposes a pre-dispatch mouse subscription.
    state.restoreViewportInput = hookViewportInput(tui, (data) => handleTerminalInput(state, data));
    const inner: CursorEditor = create(tui, theme, keybindings);
    const editor = wrapEditor(inner, state.cwd ?? process.cwd(), () => state.enabled(), () => state.enabled() && state.previewMode() === "inline", state.theme!, state, () => {
      const cursor = inner.getCursor?.();
      const path = cursor ? editorImagePaths(inner, inner.getText().split("\n")[cursor.line] ?? "").find(match => cursor.col >= match.start && cursor.col <= match.end)?.path : undefined;
      if (state.previewMode() === "hover") void requestPreview(state, state.enabled() ? path : undefined);
    }, (target, event) => {
      const match = state.enabled() && event.y >= 1 ? editorPaths(target, event.y, event.width, false, state.previewMode() === "inline").find(path => event.x >= path.startCol && event.x < path.endCol) : undefined;
      const screenStart = match ? event.screenX - event.x + match.startCol : 0;
      const screenEnd = match ? event.screenX - event.x + match.endCol : 0;
      if (match && (match.path !== state.requestedPath || state.previewAnchor?.y !== event.screenY
        || state.previewAnchor.x < screenStart || state.previewAnchor.x >= screenEnd)) {
        state.previewAnchor = { x: event.screenX, y: event.screenY };
        if (match.path === state.requestedPath && state.preview.path) { positionPreview(state); state.previewTui?.requestRender(); }
      }
      setPointer(state, !!match);
      void requestPreview(state, match?.path);
    }, () => syncInlineImages(state));
    state.editor = editor;
    return editor;
  };
  state.baseFactory = base;
  state.editorFactory = factory;
  ctx.ui.setEditorComponent(factory);
}

function draftImagePaths(editor: EditorComponent): string[] {
  const source = (editor as EditorComponent & { state?: { lines: string[] } }).state?.lines ?? editor.getText().split("\n");
  return source.flatMap(line => editorImagePaths(editor, line).map(match => match.path));
}

function clearInlineGraphics(state: Pick<Enhancements, "inlineGraphics" | "tui">): void {
  for (const graphic of state.inlineGraphics.values()) {
    if (graphic.imageId) state.tui?.terminal.write(deleteKittyImage(graphic.imageId));
  }
  state.inlineGraphics.clear();
}

/** Only the editing draft is shown here; history hover remains the separate mode. */
function syncInlineImages(state: Enhancements): void {
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

function setPointer(state: Enhancements, pointer: boolean): void {
  if (state.pointer === pointer) return;
  if (pointer || state.pointer) state.tui?.terminal.write(`\x1b]22;${pointer ? "pointer" : "default"}\x07`);
  state.pointer = pointer;
}

function handleTerminalInput(state: Enhancements, data: string): { consume?: boolean } | undefined {
  if (data === "\x1b[O") { setPointer(state, false); void requestPreview(state, undefined); }
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (mouse) {
    const x = Number(mouse[2]) - 1, y = Number(mouse[3]) - 1;
    // ponytail: Pi 0.85 has no public screen hit-test API; inspect its last rendered OSC 8 cells.
    const screen = (state.tui as TUI & { previousScreen?: string[] } | undefined)?.previousScreen;
    const moving = !!(Number(mouse[1]) & 32) && mouse[4] === "M";
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

async function requestPreview(state: Enhancements, path: string | undefined): Promise<void> {
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

function positionPreview(state: Enhancements): void {
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
