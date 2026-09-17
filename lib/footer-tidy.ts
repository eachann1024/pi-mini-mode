/** Hide noisy footer statuses (LSP / @build / sandbox / write path, etc.). */

type StatusUi = {
  setStatus(key: string, text: string | undefined): void;
};

type ExtensionCtx = {
  ui: StatusUi;
};

type ExtensionAPILike = {
  on(event: string, handler: (...args: any[]) => void): void;
};

const HIDDEN_KEYS = ["pi-lens-lsp", "@build", "build", "sandbox"] as const;

function stripAnsi(text: string): string {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function tidyText(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/^[ \t·•|●○]+/g, "")
    .replace(/[ \t·•|●○]+$/g, "")
    .replace(/ +/g, " ")
    .trim();
}

export function hideStatus(key: string, text: string): boolean {
  const k = String(key || "").toLowerCase();
  const v = String(text || "").toLowerCase();
  if (k === "pi-lens-lsp" || k.includes("lsp")) return true;
  if (k === "@build" || k === "build" || k.includes("@build")) return true;
  if (k.includes("sandbox")) return true;
  if (v.includes("lsp")) return true;
  if (v.includes("@build")) return true;
  if (v.includes("sandbox")) return true;
  if (v.includes("unrestricted")) return true;
  if (v.includes("write path")) return true;
  if (!tidyText(text)) return true;
  return false;
}

function wrapSetStatus(ctx: ExtensionCtx): StatusUi["setStatus"] {
  const orig = ctx.ui.setStatus.bind(ctx.ui);
  ctx.ui.setStatus = (key: string, text: string | undefined) => {
    if (text === undefined || hideStatus(key, text)) {
      orig(key, undefined);
      return;
    }
    const visible = stripAnsi(text).replace(/[\r\n\t]/g, " ");
    if (/^[ \t·•|●○]+/.test(visible) || /[ \t·•|●○]+$/.test(visible)) {
      orig(key, tidyText(text) || undefined);
      return;
    }
    orig(key, text);
  };
  return orig;
}

function clearKnownNoise(setStatus: StatusUi["setStatus"]): void {
  for (const key of HIDDEN_KEYS) setStatus(key, undefined);
}

/**
 * Filter noisy setStatus writes.
 * Never call setFooter — swapping the 1-line custom footer with Pi's 2–3 line
 * built-in footer changes height and desyncs differential redraw.
 */
export default function attachFooterTidy(pi: ExtensionAPILike): void {
  pi.on("session_start", (_event: unknown, ctx: ExtensionCtx) => {
    clearKnownNoise(wrapSetStatus(ctx));
  });
}
