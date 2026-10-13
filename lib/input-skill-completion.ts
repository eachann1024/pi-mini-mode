import { stripFrontmatter, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Enhancements } from "./input-enhancements-types.ts";

const SKILL_TOKEN = /(?:^|\s)(\/skill:[^\s/]+)/g;
export const SKILL_PREFIX = /(?:^|[ \t])(\/(?:skill:)?[^/\s]*)$/;

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

export async function handleInput(state: Enhancements, event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | undefined> {
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
