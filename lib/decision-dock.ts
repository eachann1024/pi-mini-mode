import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { isDecisionBadgeText, parseSemanticBadge } from "./semantic-badges.ts";
import type { UiLanguage } from "./settings.ts";

export interface DecisionChoice {
  number: number;
  label: string;
  recommended: boolean;
}

export interface DecisionPrompt {
  key: string;
  choices: DecisionChoice[];
  defaultIndex: number;
}

const DOCK_COPY: Record<UiLanguage, { title: string; nav: string; confirm: string; cancel: string; typeHint: string }> = {
  zh: {
    title: "选择处置方案（上下键或点击切换，回车发送）",
    nav: "切换",
    confirm: "确认",
    cancel: "关闭",
    typeHint: "直接打字可自由补充",
  },
  en: {
    title: "Choose an option (Up/Down or click, Enter to send)",
    nav: "navigate",
    confirm: "select",
    cancel: "dismiss",
    typeHint: "or type freely below",
  },
};

function stripFences(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && /^ {0,3}[`~]+[ \t]*$/.test(line)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (!fenceChar) kept.push(line);
  }
  return kept.join("\n");
}

function cleanOptionLine(raw: string): { label: string; recommended: boolean } {
  let recommended = false;
  let cleaned = stripVTControlCharacters(raw)
    .replace(/`?(\[[^\]\r\n`]{1,32}\])`?/g, (full, bracketed: string) => {
      const badge = parseSemanticBadge(bracketed);
      if (!badge) return full;
      if (badge.tone === "success" && /推荐|recommended|★/i.test(badge.label)) recommended = true;
      return `[${badge.label}]`;
    })
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|~~|\*|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/★|推荐|recommended/i.test(cleaned)) recommended = true;
  cleaned = cleaned.replace(/^[-:：—–\s]+/, "");
  return { label: cleaned, recommended };
}

/** Extract a 2..5 numbered option group when the assistant reply explicitly asks for a decision. */
export function extractDecisionPrompt(markdown: string | undefined, turnId: string | number = 0): DecisionPrompt | undefined {
  if (!markdown) return undefined;
  const prose = stripFences(markdown);
  if (!isDecisionBadgeText(prose)) return undefined;

  const groups: DecisionChoice[][] = [];
  let current: DecisionChoice[] = [];
  for (const rawLine of prose.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = /^(\d{1,2})[.)、]\s+(.+)$/.exec(trimmed);
    if (match) {
      const num = Number(match[1]);
      const { label, recommended } = cleanOptionLine(match[2]);
      if (!label) continue;
      if (current.length === 0 && num === 1) {
        current = [{ number: 1, label, recommended }];
      } else if (current.length > 0 && num === current.length + 1 && current.length < 5) {
        current.push({ number: num, label, recommended });
      } else if (num === 1) {
        if (current.length >= 2) groups.push(current);
        current = [{ number: 1, label, recommended }];
      }
    } else if (current.length > 0 && !rawLine.startsWith("  ") && !rawLine.startsWith("\t")) {
      if (current.length >= 2) groups.push(current);
      current = [];
    }
  }
  if (current.length >= 2) groups.push(current);
  const choices = groups.at(-1);
  if (!choices || choices.length < 2) return undefined;
  const recIdx = choices.findIndex((item) => item.recommended);
  return {
    key: `${turnId}:${choices.map((item) => item.label).join("|")}`,
    choices,
    defaultIndex: recIdx >= 0 ? recIdx : 0,
  };
}

export interface DecisionDockOptions {
  language: () => UiLanguage;
  isEditorEmpty: () => boolean;
  onSubmit: (replyText: string) => void;
  requestRender: () => void;
}

export function createDecisionDock(options: DecisionDockOptions) {
  let activePrompt: DecisionPrompt | undefined;
  let selectedIndex = 0;
  const dismissedKeys = new Set<string>();
  let optionStartRow = 2;

  const sync = (prompt: DecisionPrompt | undefined): boolean => {
    if (!prompt || dismissedKeys.has(prompt.key)) {
      if (!activePrompt) return false;
      activePrompt = undefined;
      return true;
    }
    if (activePrompt?.key === prompt.key) return false;
    activePrompt = prompt;
    selectedIndex = prompt.defaultIndex;
    return true;
  };

  const dismiss = (): boolean => {
    if (!activePrompt) return false;
    dismissedKeys.add(activePrompt.key);
    activePrompt = undefined;
    options.requestRender();
    return true;
  };

  const clearAll = (): void => {
    activePrompt = undefined;
    dismissedKeys.clear();
  };

  const choose = (index: number): void => {
    if (!activePrompt) return;
    const choice = activePrompt.choices[index];
    if (!choice) return;
    dismissedKeys.add(activePrompt.key);
    activePrompt = undefined;
    options.onSubmit(`${choice.number}. ${choice.label}`);
    options.requestRender();
  };

  const handleTerminalInput = (data: string): { consume?: boolean } | undefined => {
    if (!activePrompt) return undefined;
    if (matchesKey(data, "escape")) {
      dismiss();
      return { consume: true };
    }
    if (!options.isEditorEmpty()) return undefined;
    if (matchesKey(data, "up")) {
      selectedIndex = selectedIndex <= 0 ? activePrompt.choices.length - 1 : selectedIndex - 1;
      options.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "down")) {
      selectedIndex = selectedIndex >= activePrompt.choices.length - 1 ? 0 : selectedIndex + 1;
      options.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      choose(selectedIndex);
      return { consume: true };
    }
    return undefined;
  };

  const component = (theme: ExtensionContext["ui"]["theme"]): Component => ({
    invalidate() {},
    handleMouse(event: TuiMouseEvent) {
      if (!activePrompt) return undefined;
      const idx = event.y - optionStartRow;
      if (idx < 0 || idx >= activePrompt.choices.length) return undefined;
      if (event.type === "move" || event.type === "press") {
        if (selectedIndex !== idx) {
          selectedIndex = idx;
          return { handled: true, render: true };
        }
        return { handled: true };
      }
      if (event.type === "click" && event.button === "left") {
        choose(idx);
        return { handled: true, render: true };
      }
      return undefined;
    },
    render(width: number): string[] {
      if (!activePrompt || width < 16 || !options.isEditorEmpty()) return [];
      const copy = DOCK_COPY[options.language()] ?? DOCK_COPY.zh;
      const rule = theme.fg("borderMuted" as "muted", "─".repeat(width));
      const pad = width >= 40 ? " " : "";
      const rows: string[] = [
        rule,
        truncateToWidth(pad + theme.fg("accent", theme.bold(copy.title)), width, "…"),
      ];
      optionStartRow = rows.length;
      for (const [index, item] of activePrompt.choices.entries()) {
        const selected = index === selectedIndex;
        const prefix = selected ? "→ " : "  ";
        const body = `${item.number}. ${item.label}`;
        const fitted = truncateToWidth(pad + prefix + body, width, "…");
        rows.push(selected ? theme.fg("accent", fitted) : theme.fg("text", fitted));
      }
      const hints = `${theme.bold("↑↓")} ${copy.nav}  ${theme.bold("enter")} ${copy.confirm}  ${theme.bold("esc")} ${copy.cancel}  · ${copy.typeHint}`;
      rows.push(truncateToWidth(pad + theme.fg("muted", hints), width, "…"));
      return rows;
    },
  });

  return {
    get isActive() {
      return Boolean(activePrompt);
    },
    sync,
    dismiss,
    clearAll,
    handleTerminalInput,
    component,
  };
}
