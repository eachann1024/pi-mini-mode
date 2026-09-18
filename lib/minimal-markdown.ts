import { Marked, Markdown, visibleWidth, type DefaultTextStyle, type MarkdownTheme } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";

const parser = new Marked();

/** A fence's info string is "language [options]"; only the first token names a language. */
const languageToken = (lang?: string) => lang?.trim().split(/\s+/)[0].toLowerCase() ?? "";

/** Theme emphasis remains visible when the terminal's CJK font lacks bold/italic faces. */
const REGISTERED_LANGUAGES = new Set([
  "bash", "sh", "shell", "zsh", "fish", "powershell", "javascript", "js", "typescript", "ts", "jsx", "tsx",
  "python", "ruby", "rust", "go", "java", "kotlin", "swift", "c", "cpp", "csharp", "php", "sql", "html", "css",
  "scss", "sass", "less", "yaml", "yml", "json", "json5", "jsonc", "toml", "xml", "markdown", "md", "lua", "perl",
  "r", "scala", "clojure", "elixir", "erlang", "haskell", "ocaml", "vim", "graphql", "protobuf", "hcl", "dockerfile",
]);
const ANSI_FOREGROUND = /\x1b\[(?:38;(?:2;\d+;\d+;\d+|5;\d+)|3[0-9]|9[0-7])m/g;

export function minimalMarkdownTheme(base: MarkdownTheme, codeBackground = ""): MarkdownTheme {
  // Inline prose arrives with its default foreground already applied. Remove
  // those foreground codes before wrapping, otherwise they override emphasis.
  const emphasis = (text: string) => base.heading(text.replace(/\x1b\[(?:38;(?:2;\d+;\d+;\d+|5;\d+)|3[0-9]|9[0-7])m/g, ""));
  const highlightCode = base.highlightCode;
  const neutralCode = (text: string) => base.codeBlock(text).replace(ANSI_FOREGROUND, "");
  return {
    ...base,
    bold: text => emphasis(base.bold(text)),
    italic: text => emphasis(base.italic(text)),
    codeBlock: neutralCode,
    // A blank, background-painted row replaces the old language/border text.
    codeBlockBorder: () => codeBackground ? `${codeBackground} ` : "",
    codeBlockIndent: codeBackground ? `${codeBackground} ` : "  ",
    // ponytail: reuse installed grammars; only registered languages are sent to it.
    ...(highlightCode && { highlightCode: (code: string, lang?: string) => {
      const language = languageToken(lang);
      if (!REGISTERED_LANGUAGES.has(language) || /^(?:text|txt|plaintext)$/.test(language)) return code.split("\n").map(neutralCode);
      return highlightCode(code, /^json[5c]$/.test(language) ? "javascript" : language);
    } }),
  };
}

/** Render Markdown with A's code-only background, after native wrapping has settled. */
export function renderMinimalMarkdown(source: string, width: number, base: MarkdownTheme, codeBackground: string,
  defaultTextStyle?: DefaultTextStyle, transform?: (source: string, available: number) => string): string[] {
  const rows = new Markdown(source, 0, 0, minimalMarkdownTheme(base, codeBackground), defaultTextStyle,
    transform ? { transform } : undefined).render(width);
  if (!codeBackground) return rows;
  return rows.map(row => row.startsWith(codeBackground)
    ? `${row}${" ".repeat(Math.max(0, width - visibleWidth(row)))}\x1b[49m`
    : row);
}

type MarkdownNode = {
  type?: string;
  raw?: string;
  text?: string;
  tokens?: MarkdownNode[];
  items?: MarkdownNode[];
  header?: MarkdownNode[] | boolean;
  rows?: MarkdownNode[][];
};

/** Tolerate model-generated emphasis in prose, preserving code, escapes and URLs. */
export function normalizeProseMarkdown(source: string): string {
  if (!/[*_~]/.test(source)) return source;
  const repairInline = (raw: string, mask: string): string => {
    // Mask parsed constructs so delimiters in code, links or existing emphasis
    // cannot be mistaken for an opening/closing pair. Their contents can still
    // sit between a pair of otherwise unparsed prose delimiters.
    const pattern = /(?<![\\*_~])(\*\*|__|~~|\*|_)(?![*_~])([^\n]*?)\1(?![*_~])/g;
    const edits: { start: number; end: number; text: string }[] = [];
    for (const match of mask.matchAll(pattern)) {
      const start = match.index!;
      const marker = match[1];
      if (marker.includes("_") && /[\p{L}\p{N}_]/u.test(raw[start - 1] ?? "")) continue;
      const body = raw.slice(start + marker.length, start + match[0].length - marker.length);
      if (marker.length === 1 && /^\s/.test(body)) continue; // e.g. prose multiplication: a * b * c
      const trimmed = body.trim();
      if (!trimmed || trimmed.endsWith("\\")) continue;
      const punctuation = /[，。！？；：、]+$/.exec(trimmed)?.[0] ?? "";
      const content = trimmed.slice(0, trimmed.length - punctuation.length);
      if (!content) continue;
      const delimiter = marker.replace(/_/g, "*");
      edits.push({ start, end: start + match[0].length,
        text: `${body.match(/^\s*/)?.[0] ?? ""}${delimiter}${content}${delimiter}${punctuation}${body.match(/\s*$/)?.[0] ?? ""}` });
    }
    for (const edit of edits.reverse()) raw = raw.slice(0, edit.start) + edit.text + raw.slice(edit.end);
    return raw;
  };
  const rewrite = (node: MarkdownNode): string => {
    const raw = node.raw ?? node.text ?? "";
    const children = node.tokens ?? node.items ?? (Array.isArray(node.header) ? [...node.header, ...(node.rows ?? []).flat()] : undefined);
    if (!children) return raw;
    const inline = ["paragraph", "heading", "text", "strong", "em", "del", "link"].includes(node.type ?? "") || !node.type;
    let cursor = 0;
    let result = "";
    let mask = "";
    for (const child of children) {
      const original = child.raw ?? child.text;
      if (!original) continue;
      const replacement = rewrite(child);
      const start = raw.indexOf(original, cursor);
      if (start < 0) {
        // Blockquote/list prefixes interrupt multiline raw tokens. Map each
        // line separately, retaining those prefixes and the original layout.
        const before = original.split("\n");
        const after = replacement.split("\n");
        if (inline || before.length !== after.length) return raw;
        for (let i = 0; i < before.length; i++) {
          if (!before[i]) continue;
          const position = raw.indexOf(before[i], cursor);
          if (position < 0) return raw;
          result += raw.slice(cursor, position) + after[i];
          cursor = position + before[i].length;
        }
        continue;
      }
      result += raw.slice(cursor, start) + replacement;
      mask += raw.slice(cursor, start).replace(/[^\n]/g, "\0")
        + (child.type === "text" && !child.tokens ? replacement : replacement.replace(/[^\n]/g, "\0"));
      cursor = start + original.length;
    }
    result += raw.slice(cursor);
    mask += raw.slice(cursor).replace(/[^\n]/g, "\0");
    return inline ? repairInline(result, mask) : result;
  };
  return parser.lexer(source).map(rewrite).join("");
}

/** Lexer tokens that are Markdown block structure regardless of how the body looks. */
const BLOCK_TOKENS = new Set(["code", "heading", "blockquote", "list", "table", "hr"]);
/** A hard break alone may be a shell continuation, not Markdown prose. */
const INLINE_TOKENS = new Set(["strong", "em", "del", "codespan", "link", "image"]);
/** Source that opens like code stays literal even when it also parses as inline Markdown. */
const LOOKS_LIKE_SOURCE = /^(?:const|let|var|function|class|import|export|SELECT|INSERT|UPDATE|DELETE)\b/m;
/** Preserve the existing tolerance for unfinished or malformed inline markup. */
const SLOPPY_EMPHASIS = /(?:\*\*|__|~~|`[^`\n]+`|\[[^\]\n]+\]\([^\n)]+\))/;

/** A body that is only a closed or streaming fence must not be sliced mid-block. */
export function isFencedMarkdown(source: string): boolean {
  const tokens = parser.lexer(source.trim()).filter(token => token.type !== "space");
  return tokens.length === 1 && tokens[0].type === "code";
}

/** Markdown is rendered only for semantic prose bodies; structured tool output stays literal. */
export function isMarkdownProse(source: string): boolean {
  const text = source.trim();
  if (!text) return false;
  if (/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(text)) {
    try { JSON.parse(text); return false; } catch { /* a Markdown list may start with [ */ }
  }
  // The lexer decides what the body actually is: block structure first, then
  // inline structure. Raw HTML alone is not prose, so `html` tokens are ignored.
  let block = false;
  let inline = false;
  parser.walkTokens(parser.lexer(text), (token) => {
    if (BLOCK_TOKENS.has(token.type)) block = true;
    else if (INLINE_TOKENS.has(token.type)) inline = true;
  });
  if (block) return true;
  if (LOOKS_LIKE_SOURCE.test(text)) return false;
  return inline || SLOPPY_EMPHASIS.test(text);
}

/** A malformed diagram must not break the render, so its own source is the fallback. */
function diagramArt(source: string) {
  try { return render(source); } catch { return undefined; }
}

/** Keep incomplete, unsupported and over-wide diagrams readable as source. */
export function diagramMarkdown(source: string, width: number): string {
  return parser.lexer(normalizeProseMarkdown(source)).map((token) => {
    if (token.type !== "code" || languageToken(token.lang) !== "mermaid") return token.raw;
    const art = diagramArt(token.text);
    if (!art || art.width > width || art.warnings.length) return token.raw;
    return art.plain.map((line) => {
      const content = line || "\u00a0";
      const fence = "`".repeat(Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length)) + 1);
      return `${fence} ${content} ${fence}`;
    }).join("  \n") + "\n\n";
  }).join("");
}
