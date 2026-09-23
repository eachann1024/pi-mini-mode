import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Marked, getCapabilities, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const linkParser = new Marked();
export function webPaths(text: string) {
  let offset = 0;
  return linkParser.Lexer.lexInline(text, { gfm: true }).flatMap(token => {
    const start = offset;
    offset += token.raw.length;
    if (token.type !== "link" || !/^https?:\/\//i.test(token.href) || /[\x00-\x20\x7f]/.test(token.href)) return [];
    try { new URL(token.href); } catch { return []; }
    return [{ path: token.href, start, end: offset }];
  });
}

/** Pi 0.85's allowlist predates Otty; preserve explicit opt-outs and multiplexer detection. */
export function inputCapabilities(env = process.env) {
  const caps = getCapabilities();
  if (env.TMUX || /^(screen|tmux)/.test(env.TERM ?? "")) return caps;
  // Herdr panes advertise xterm-256color; the user's Kitty-capable fork renders images.
  if (env.HERDR_PANE_ID) return { ...caps, hyperlinks: env.PI_HYPERLINKS !== "0",
    images: env.PI_IMAGE_PROTOCOL === "0" || env.PI_IMAGE_PROTOCOL === "none" ? null : caps.images ?? "kitty" as const };
  if (env.TERM_PROGRAM?.toLowerCase() !== "otty") return caps;
  return { ...caps, hyperlinks: env.PI_HYPERLINKS === "0" ? false : true,
    images: env.PI_IMAGE_PROTOCOL === "0" || env.PI_IMAGE_PROTOCOL === "none" ? null : caps.images ?? "kitty" as const };
}

export function localPath(path: string, cwd: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(cwd, path);
}

/** Opening/closing fences must stay intact; quoted paths inside them are not links. */
function fenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const open = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n/g;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const start = match.index + match[1].length;
    const escaped = match[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Search only after the opener, then resume after the closer, so a closing
    // fence can never be read as the next opener and swallow the text behind it.
    const close = new RegExp(`(?:^|\\n) {0,3}${escaped}[ \\t]*(?:\\n|$)`).exec(text.slice(open.lastIndex));
    if (!close) {
      ranges.push([start, text.length]);
      break;
    }
    open.lastIndex += close.index + close[0].length;
    ranges.push([start, open.lastIndex]);
  }
  return ranges;
}

/** Quoted paths may contain spaces; unquoted paths end at prose delimiters. */
export function filePaths(text: string) {
  const matches: Array<{ path: string; start: number; end: number }> = [];
  const fences = fenceRanges(text);
  const pattern = /(["'`])([^\r\n]*?)\1|[^\s"'`<>()[\]{}，。；！？]+/g;
  for (const match of text.matchAll(pattern)) {
    const path = (match[2] ?? match[0]).replace(/[.,;:!?]+$/, "");
    if (!path || /^[\\/]+$/.test(path) || /[\x00-\x1f\x7f]/.test(path) || /^[a-z][\w+.-]*:\/\//i.test(path)) continue;
    if (!/^(?:\/|~\/|\.{1,2}\/|[a-z]:[\\/])|[\\/]|\.[a-z\d]{1,12}$/i.test(path)) continue;
    const start = match.index + (match[1] ? 1 : 0);
    const end = start + path.length;
    if (fences.some(([from, to]) => start < to && end > from)) continue;
    matches.push({ path, start, end });
  }
  return matches;
}

// BEL survives Markdown's backslash-escape parsing, unlike the ST terminator.
export const fileLink = (text: string, path: string, underline = true) => `\x1b]8;;${pathToFileURL(path).href}\x07${underline ? `\x1b[4m${text}\x1b[24m` : text}\x1b]8;;\x07`;

/** Display-only: normalize local targets without changing persisted messages or remote URLs. */
export function linkMessageFiles(text: string, cwd: string): string {
  if (!inputCapabilities().hyperlinks) return text;
  let imageNumber = 0;
  return text.split(/(\x1b\]8;[^\x07]*(?:\x07)[\s\S]*?\x1b\]8;;\x07|\[[^\]\n]*\]\([^\n]*?\))/g).map((part, index) => {
    if (index % 2) {
      return part.replace(/^(\[[^\]\n]*\]\()(<[^>\n]*>|[^\s)]+)([\s\S]*)$/, (original, prefix, target, suffix) => {
        const value = target.startsWith("<") ? target.slice(1, -1) : target;
        if (/^[a-z][\w+.-]*:|^\/\//i.test(value) || /[\x00-\x1f\x7f]/.test(value)) return original;
        const path = localPath(value, cwd);
        return existsSync(path) ? `${prefix}<${pathToFileURL(path).href}>${suffix}` : original;
      });
    }
    const matches = filePaths(part).map(match => ({ ...match, label: /\.(png|jpe?g|gif|webp)$/i.test(match.path) && existsSync(localPath(match.path, cwd)) ? `[image${++imageNumber}]` : match.path }));
    for (const match of matches.reverse()) {
      const path = localPath(match.path, cwd);
      if (!existsSync(path)) continue;
      part = part.slice(0, match.start) + fileLink(match.label, path, !/^\[image\d+\]$/.test(match.label)) + part.slice(match.end);
    }
    return part;
  }).join("");
}

/** Decorate rendered columns without removing the editor's ANSI cursor marker. */
export function linkRenderedPath(line: string, start: number, end: number, path: string, directory = false): string {
  if (!inputCapabilities().hyperlinks || end <= start) return line;
  const label = sliceByColumn(line, start, end - start);
  const link = /^https?:\/\//i.test(path) ? `\x1b]8;;${path}\x07${label}\x1b]8;;\x07` : fileLink(label, directory ? dirname(path) : path, false);
  return sliceByColumn(line, 0, start) + link
    + sliceByColumn(line, end, Math.max(0, visibleWidth(stripTerminalSequences(line)) - end));
}
