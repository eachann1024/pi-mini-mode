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

/** Use Pi's effective capabilities, including user overrides and renderer restrictions. */
export const inputCapabilities = getCapabilities;

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

/** Quoted or shell-escaped paths may contain spaces; spans refer to the original text. */
export function filePaths(text: string) {
  const matches: Array<{ path: string; start: number; end: number }> = [];
  const fences = fenceRanges(text);
  const pattern = /(["'`])([^\r\n]*?)\1|(?:\\[^\r\n]|[^\s"'`<>()[\]{}，。；！？])+/g;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[2] ?? match[0]).replace(/[.,;:!?]+$/, "");
    const path = !match[1] && /^(?:\/|~\/|\.\.?\/)/.test(raw)
      ? raw.replace(/\\([ \t"'`()\[\]{}!#$&;<>?|*\\])/g, "$1") : raw;
    if (!path || /^[\\/]+$/.test(path) || /[\x00-\x1f\x7f]/.test(path) || /^[a-z][\w+.-]*:\/\//i.test(path)) continue;
    if (!/^(?:\/|~\/|\.{1,2}\/|[a-z]:[\\/])|[\\/]|\.[a-z\d]{1,12}$/i.test(path)) continue;
    const start = match.index + (match[1] ? 1 : 0);
    const end = start + raw.length;
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
    const matches = filePaths(part).map(match => ({ ...match, image: /\.(png|jpe?g|gif|webp)$/i.test(match.path) && existsSync(localPath(match.path, cwd)), number: 0 }));
    for (const match of matches) if (match.image) match.number = ++imageNumber;
    for (const match of matches.reverse()) {
      const path = localPath(match.path, cwd);
      if (!existsSync(path)) continue;
      part = part.slice(0, match.start) + fileLink(match.image ? `  #${match.number}` : match.path, path, !match.image) + part.slice(match.end);
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
