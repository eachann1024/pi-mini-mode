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
import { CustomEditor, stripFrontmatter, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId, getImageDimensions, renderImage, getCapabilities, setCapabilities, getOsc8LinkAtColumn, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth,
  type AutocompleteItem, type AutocompleteProvider, type Component, type EditorComponent, type TuiMouseEvent, type TUI, type OverlayHandle, type OverlayOptions,
} from "@earendil-works/pi-tui";
import { filePaths, inputCapabilities, linkRenderedPath, localPath } from "./file-links.ts";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INPUT_ENHANCEMENTS_SETTING = "pi-mini-mode-input-enhancements";
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

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
  for (const { path, start } of filePaths(plain)) {
    if (!IMAGE_MIME[extname(path).toLowerCase()]) continue;
    matches.push({ path, start, end: start + path.length, startCol: visibleWidth(plain.slice(0, start)), endCol: visibleWidth(plain.slice(0, start + path.length)) });
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
export async function readPreview(path: string, cwd: string): Promise<Preview | undefined> {
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
    return { kind: "image", path, mimeType, base64: bytes.subarray(0, offset).toString("base64") };
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

/** A tightly sized image frame. Draw after clearing its interior, never a path-only tooltip. */
export function previewLines(preview: PreviewState, theme: ExtensionContext["ui"]["theme"], width: number, origin = { row: 0, col: 0 }): string[] {
  if (!preview.path) return [];
  const graphic = preview.graphic;
  const innerWidth = Math.max(1, Math.min(width - 2, graphic?.columns ?? 26));
  const border = (text: string) => theme.fg("border", text);
  const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
  if (graphic) {
    for (let row = 0; row < graphic.rows; row++) lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
  } else lines.push(border("│") + truncateToWidth(preview.note ?? "无法预览图片", innerWidth, "", true) + border("│"));
  // Absolute H survives Pi 0.85's ANSI slicer; restore to the border before any padding is painted.
  const draw = graphic ? `\x1b[${origin.row + 2};${origin.col + 2}H${graphic.sequence}\x1b[${origin.row + graphic.rows + 2};${origin.col + 1}H` : "";
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
  previewToken: number;
  overlayReady: boolean;
  previewTui?: { requestRender(): void };
  previewHandle?: OverlayHandle;
  tui?: TUI;
  requestedPath?: string;
  pointer?: boolean;
  previewAnchor?: { x: number; y: number };
  previewOptions?: OverlayOptions;
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
function wrapEditor(inner: EditorComponent, cwd: string, isEnabled: () => boolean, onCursor: () => void, onHoverEditor: (editor: EditorComponent, event: TuiMouseEvent) => void): EditorComponent {
  const attachments = new Map<string, string>();
  const expand = (text: string) => text.replace(/\[image\d+\]/g, label => attachments.get(label) ?? label);
  const compact = (text: string) => {
    if (!isEnabled()) return text;
    const replacements = imagePathsInLine(text).map(match => {
      let label = [...attachments].find(([, path]) => path === match.path)?.[0];
      if (!label) { label = `[image${attachments.size + 1}]`; attachments.set(label, match.path); }
      return { ...match, label };
    });
    for (const match of replacements.reverse()) text = text.slice(0, match.start) + match.label + text.slice(match.end);
    return text;
  };
  // ponytail: reuse Pi 0.85's editor segmentation/submit hooks; replace with a public attachment API when available.
  const core = inner as EditorComponent & { expandPasteMarkers?(text: string): string; segment?(text: string, mode?: string): Array<{ segment: string; index: number; input: string }>; imageAttachments?: Map<string, string> };
  core.imageAttachments = attachments;
  if (core.expandPasteMarkers) { const original = core.expandPasteMarkers.bind(core); core.expandPasteMarkers = text => expand(original(text)); }
  const pasteEditor = inner as EditorComponent & { handlePaste?(text: string): void };
  if (pasteEditor.handlePaste) { const paste = pasteEditor.handlePaste.bind(inner); pasteEditor.handlePaste = text => paste(compact(text)); }
  if (core.segment) {
    const original = core.segment.bind(core);
    core.segment = (text, mode) => {
      const spans = [...text.matchAll(/\[image\d+\]/g)].filter(match => attachments.has(match[0]));
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
      if (property === "setText" || property === "insertTextAtCursor") return (text: string) => target[property]?.(compact(text));
      if (property === "render") {
        return (width: number) => {
          const lines = target.render(width);
          return isEnabled() ? linkImagePaths(lines, target, cwd, width) : lines;
        };
      }
      if (property === "handleMouse") {
        return (event: TuiMouseEvent) => {
          const result = target.handleMouse?.(event);
          if (event.type === "move") onHoverEditor(target, event);
          else if (event.type === "click") onCursor();
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
  for (const match of text.matchAll(/\[image\d+\]/g)) {
    const path = attachments?.get(match[0]);
    if (path) paths.push({ path, start: match.index, end: match.index + match[0].length, startCol: visibleWidth(text.slice(0, match.index)), endCol: visibleWidth(text.slice(0, match.index + match[0].length)) });
  }
  return paths.sort((a, b) => a.start - b.start);
}

function editorPaths(editor: EditorComponent, row: number, width: number) {
  const core = editor as EditorComponent & { lastWidth?: number; scrollOffset?: number; renderedVisibleLineCount?: number; getPaddingX?(): number; buildVisualLineMap?(width: number): Array<{ logicalLine: number; startCol: number; length: number }> };
  if (!core.buildVisualLineMap || !core.lastWidth) return imagePathsInLine(editor.render(width)[row] ?? "");
  if (row < 1 || row > (core.renderedVisibleLineCount ?? 0)) return [];
  const chunk = core.buildVisualLineMap(core.lastWidth)[(core.scrollOffset ?? 0) + row - 1];
  if (!chunk) return [];
  const source = editor.getText().split("\n")[chunk.logicalLine] ?? "";
  const padding = Math.min(core.getPaddingX?.() ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
  return editorImagePaths(editor, source).filter(match => match.end > chunk.startCol && match.start < chunk.startCol + chunk.length).map(match => ({
    ...match,
    startCol: padding + visibleWidth(source.slice(chunk.startCol, Math.max(chunk.startCol, match.start))),
    endCol: padding + visibleWidth(source.slice(chunk.startCol, Math.min(chunk.startCol + chunk.length, match.end))),
  }));
}

function linkImagePaths(lines: string[], editor: EditorComponent, cwd: string, width: number): string[] {
  if (!inputCapabilities().hyperlinks) return lines;
  return lines.map((line, row) => {
    for (const match of editorPaths(editor, row, width).reverse()) line = linkRenderedPath(line, match.startCol, match.endCol, localPath(match.path, cwd));
    // Isolate editor rows from inherited terminal link/color state.
    const reset = "\x1b]8;;\x07\x1b[0m";
    return reset + line + reset;
  });
}

export function installInputEnhancements(pi: ExtensionAPI, ctx: ExtensionContext, isEnabled: boolean | (() => boolean)): InputEnhancementsCleanup {
  if (process.env.TERM_PROGRAM?.toLowerCase() === "otty") setCapabilities(inputCapabilities());
  const enabled = typeof isEnabled === "function" ? isEnabled : () => isEnabled;
  if (installed && installed.pi !== pi) installed.cleanup();
  const state = installed?.pi === pi ? installed : (installed = createEnhancements(pi));
  state.enabled = enabled;
  state.ctx = ctx;
  state.cwd = ctx.cwd;
  state.theme = ctx.hasUI ? ctx.ui.theme : undefined;
  if (ctx.mode === "tui" && ctx.hasUI) {
    const generation = ctx.sessionManager;
    if (state.generation !== generation) {
      state.generation = generation;
      state.unsubscribeInput?.();
      state.unsubscribeInput = ctx.ui.onTerminalInput?.((data) => handleTerminalInput(state, data)) ?? undefined;
      ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, () => readSkillCommands(pi), () => state.enabled()));
    }
    const active = ctx.ui.getEditorComponent();
    if (active !== state.editorFactory || !state.editor) installEditor(ctx, state, active);
  }
  return state.cleanup;
}

function createEnhancements(pi: ExtensionAPI): Enhancements {
  const state: Enhancements = {
    pi,
    enabled: () => true,
    preview: {},
    previewToken: 0,
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
      state.preview = {};
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
    // Otty is detected after fullscreen startup; synchronize its cached protocol for placement cleanup.
    const renderer = tui as TUI & { imageProtocol?: string | null };
    if (renderer.imageProtocol === null && getCapabilities().images === "kitty") renderer.imageProtocol = "kitty";
    // ponytail: fullscreen's first input listener consumes mouse events before extension listeners.
    // Observe its entry point until Pi exposes a pre-dispatch mouse subscription.
    state.restoreViewportInput = hookViewportInput(tui, (data) => handleTerminalInput(state, data));
    const inner: CursorEditor = create(tui, theme, keybindings);
    const editor = wrapEditor(inner, state.cwd ?? process.cwd(), () => state.enabled(), () => {
      const cursor = inner.getCursor?.();
      const path = cursor ? editorImagePaths(inner, inner.getText().split("\n")[cursor.line] ?? "").find(match => cursor.col >= match.start && cursor.col <= match.end)?.path : undefined;
      void requestPreview(state, state.enabled() ? path : undefined);
    }, (target, event) => {
      const match = state.enabled() ? editorPaths(target, event.y, event.width).find(path => event.x >= path.startCol && event.x < path.endCol) : undefined;
      if (match) state.previewAnchor = { x: event.screenX, y: event.screenY };
      setPointer(state, !!match);
      void requestPreview(state, match?.path);
    });
    state.editor = editor;
    return editor;
  };
  state.baseFactory = base;
  state.editorFactory = factory;
  ctx.ui.setEditorComponent(factory);
}

function setPointer(state: Enhancements, pointer: boolean): void {
  if (state.pointer === pointer) return;
  if (pointer || state.pointer) state.tui?.terminal.write(`\x1b]22;${pointer ? "pointer" : "default"}\x07`);
  state.pointer = pointer;
}

function handleTerminalInput(state: Enhancements, data: string): { consume?: boolean } | undefined {
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (mouse) {
    const x = Number(mouse[2]) - 1, y = Number(mouse[3]) - 1;
    // ponytail: Pi 0.85 has no public screen hit-test API; inspect its last rendered OSC 8 cells.
    const screen = (state.tui as TUI & { previousScreen?: string[] } | undefined)?.previousScreen;
    const url = state.enabled() && (Number(mouse[1]) & 32) ? getOsc8LinkAtColumn(screen?.[y] ?? "", x) : undefined;
    let path: string | undefined;
    if (url?.startsWith("file:")) {
      try { const file = fileURLToPath(url); if (IMAGE_MIME[extname(file).toLowerCase()]) path = file; } catch { /* Reject malformed or remote file URLs. */ }
    }
    if (path) state.previewAnchor = { x, y };
    setPointer(state, !!path);
    void requestPreview(state, path);
  }
  if (!state.preview.path || !matchesKey(data, "escape")) return undefined;
  void requestPreview(state, undefined);
  return { consume: true };
}

async function requestPreview(state: Enhancements, path: string | undefined): Promise<void> {
  if (path && state.enabled() && path === state.requestedPath) { positionPreview(state); state.previewTui?.requestRender(); return; }
  state.requestedPath = state.enabled() ? path : undefined;
  const token = ++state.previewToken;
  if (!path || !state.enabled()) {
    setPreview(state, undefined);
    return;
  }
  const preview = await readPreview(path, state.cwd ?? process.cwd());
  if (token !== state.previewToken || !state.enabled()) return;
  setPreview(state, preview);
}

function setPreview(state: Enhancements, preview: Preview | undefined): void {
  const dimensions = preview?.kind === "image" ? getImageDimensions(preview.base64, preview.mimeType) : undefined;
  const graphic = preview?.kind === "image" && dimensions ? renderImage(preview.base64, dimensions, {
    maxWidthCells: Math.max(1, Math.min(58, (state.tui?.terminal.columns ?? 80) - 2)),
    maxHeightCells: Math.max(1, Math.floor((state.tui?.terminal.rows ?? 24) / 2) - 2),
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
  state.previewOptions = { width: 60, maxHeight: "50%", nonCapturing: true, visible: () => state.enabled() && state.preview.path !== undefined };
  state.previewHandle = state.tui.showOverlay({
    render: width => previewLines(state.preview, state.theme!, width, { row: Number(state.previewOptions?.row ?? 0), col: Number(state.previewOptions?.col ?? 0) }),
    invalidate: () => {},
  }, state.previewOptions);
}

function positionPreview(state: Enhancements): void {
  if (!state.previewOptions || !state.tui || !state.theme) return;
  const { rows, columns } = state.tui.terminal;
  const width = Math.max(3, Math.min((state.preview.graphic?.columns ?? 26) + 2, columns || 80));
  const height = Math.min(Math.floor(rows / 2), previewLines(state.preview, state.theme, width, { row: 0, col: 0 }).length);
  const { x, y } = state.previewAnchor ?? { x: 0, y: rows - 2 };
  Object.assign(state.previewOptions, { width, col: Math.max(0, Math.min(x, (columns || 80) - width)),
    row: y + 1 + height <= rows ? y + 1 : Math.max(0, y - height) });
}
