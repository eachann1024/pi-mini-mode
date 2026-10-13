import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent, type TuiMouseEvent, type TUI } from "@earendil-works/pi-tui";
import type { CursorEditor, EditorFactoryFunction, Enhancements } from "./input-enhancements-types.ts";
import { editorImagePaths, editorPaths, hideImageLabels, linkImagePaths } from "./input-editor-paths.ts";
import { imagePathsInLine } from "./input-image-paths.ts";
import { handleTerminalInput, positionPreview, requestPreview, setPointer } from "./input-hover-preview.ts";
import { inlinePreviewLines, syncInlineImages } from "./input-inline-images.ts";
import { SKILL_PREFIX } from "./input-skill-completion.ts";

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


export function liveUI(ctx?: ExtensionContext): ExtensionContext["ui"] | undefined {
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

/** Wrap the current editor factory (or the default editor) so enhancements ride on top of it. */
export function installEditor(ctx: ExtensionContext, state: Enhancements, base?: EditorFactoryFunction): void {
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
