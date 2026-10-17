import type { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, OverlayHandle, OverlayOptions, renderImage, TUI } from "@earendil-works/pi-tui";
import type { Preview } from "./input-image-paths.ts";

export interface PreviewState {
  path?: string;
  note?: string;
  graphic?: NonNullable<ReturnType<typeof renderImage>>;
}

export type EditorFactoryFunction = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
export type CursorEditor = EditorComponent & { getCursor?(): { line: number; col: number } };

export interface InputEnhancementsCleanup {
  (): void;
  refresh(): void;
}

export interface Enhancements {
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
  reveal?: typeof spawn;
  unsubscribeInput?: () => void;
  restoreViewportInput?: () => void;
  cleanup: InputEnhancementsCleanup;
}
