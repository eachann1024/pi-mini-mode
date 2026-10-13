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
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { deleteKittyImage } from "@earendil-works/pi-tui";
import type { Enhancements, InputEnhancementsCleanup } from "./input-enhancements-types.ts";
import { installEditor, liveUI } from "./input-editor.ts";
import { handleTerminalInput, requestPreview, setPointer } from "./input-hover-preview.ts";
import { clearInlineGraphics, syncInlineImages } from "./input-inline-images.ts";
import { createSkillAutocompleteProvider, handleInput, readSkillCommands } from "./input-skill-completion.ts";

export { MAX_PREVIEW_BYTES, imagePathsInLine, imagePathAtCursor, imageDirectoryUrl, readPreview } from "./input-image-paths.ts";
export type { ImagePathMatch, PreviewImage, PreviewNote, Preview } from "./input-image-paths.ts";
export { readSkillCommands, skillBlock, skillTokensIn, expandSkillTokens, createSkillAutocompleteProvider } from "./input-skill-completion.ts";
export type { SkillEntry, SkillToken } from "./input-skill-completion.ts";
export { previewLines } from "./input-image-graphics.ts";
export { inlinePreviewLines } from "./input-inline-images.ts";
export type { PreviewState, InputEnhancementsCleanup } from "./input-enhancements-types.ts";

export const INPUT_ENHANCEMENTS_SETTING = "pi-mini-mode-input-enhancements";

let installed: Enhancements | undefined;

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
