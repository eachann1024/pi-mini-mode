import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactGoalCard, compactSupervisorNotice } from "./transcript-cards.ts";
import { cacheMissLine, formatCacheTokens, isSupervisorReply, record, supervisorNotice } from "./transcript-notices.ts";

function supervisorEnvelope(child: Component): unknown {
  if (child.constructor.name === "CustomMessageComponent") return (child as unknown as { message?: unknown }).message;
  if (child.constructor.name === "CustomEntryComponent") {
    const entry = record((child as unknown as { entry?: unknown }).entry);
    if (entry?.type === "custom" && entry.customType === "subagent_supervisor_reply") return entry;
  }
}

/** Pi 0.85.x private layout adapter. Never mutates the stored messages or child tree. */
export type NoticeRows = string[] & {
  handleMouse?: Component["handleMouse"];

};
export type TurnNotices = ReadonlyMap<number, NoticeRows>;

export interface NoticeOptions {
  turnCount?: () => number;
  supervisor?: {
    theme: ExtensionContext["ui"]["theme"];
    expanded: () => boolean;
    handledRunIds?: () => Set<string>;
    onNotices?: (groups: Map<string | Component, { first: Component; messages: unknown[]; selected: unknown; notice: NonNullable<ReturnType<typeof supervisorNotice>> }>) => void;
  };
  /** Blocking extension prompts are native UI, never auto-expiring notices. */
  isPrompt?: (text: string) => boolean;
  isTransient?: (text: string) => boolean;
  /** Drop individual startup diagnostic lines, such as an unmatched model pattern. */
  hideStartupLine?: (line: string) => boolean;
  /** When false, Pi's per-turn cache-miss lines stay in the transcript. Default: fold them. */
  foldCacheMiss?: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
}

// Keep expiry across minimal-mode remounts without retaining discarded sessions.
const noticeTimes = new WeakMap<Component, { text: string; until: number }>();

/** Collect native notices for each user turn without patching any components. */
export function createTurnNoticeRenderer(chat: { children: Component[] }, options: NoticeOptions, now: () => number,
  scheduleExpiry: (nextExpiry: number, time: number) => void): (width: number) => Map<number, NoticeRows> | undefined {
  const expandedNotices = new Map<string | Component, boolean>();
  let globalExpanded = options.supervisor?.expanded() ?? false;
  return width => {
    const notices = new Map<number, NoticeRows>();
    const expanded = options.supervisor?.expanded() ?? false;
    if (expanded !== globalExpanded) { expandedNotices.clear(); globalExpanded = expanded; }
    const groups = new Map<string | Component, { first: Component; messages: unknown[]; selected: unknown; notice: NonNullable<ReturnType<typeof supervisorNotice>> }>();
    if (options.supervisor) for (const child of chat.children) {
      const message = supervisorEnvelope(child);
      const notice = supervisorNotice(message);
      if (!notice) continue;
      const key = notice.key ?? child;
      const group = groups.get(key);
      if (!group) groups.set(key, { first: child, messages: [message], selected: message, notice });
      else {
        group.messages.push(message);
        // Failures stay sticky. A matching supervisor reply is the only
        // resolution for a blocking ask; progress and duplicate wait notices
        // must not bury the prompt or clear a failure.
        const resolved = isSupervisorReply(message) && group.notice.alert && group.notice.color !== "error";
        if (notice.color === "error" || (notice.alert && group.notice.color !== "error") || resolved
          || (!group.notice.alert && (!notice.internal || group.notice.internal))) {
          group.selected = message;
          group.notice = notice;
        }
      }
    }
    // String keys belong to aggregated supervisor notices; component keys belong
    // to independently rendered custom entries such as pi-codex-goal.
    for (const key of expandedNotices.keys()) if (typeof key === "string" && !groups.has(key)) expandedNotices.delete(key);
    options.supervisor?.onNotices?.(groups);
    const groupKeys = [...groups.keys()];
    const controls = new Map<number, Array<{ y: number; width: number; key: string | Component; expanded: boolean }>>();
    const nativeTurns = chat.children.filter(child => child.constructor.name === "UserMessageComponent").length;
    const totalTurns = options.turnCount?.() ?? nativeTurns;
    // ponytail: Pi rebuilds a retained suffix after compaction; explicit entry IDs
    // are needed if native history ever becomes a non-contiguous projection.
    if (!Number.isInteger(totalTurns) || totalTurns < nativeTurns) {
      return undefined;
    }
    let turn = totalTurns - nativeTurns - 1;
    let nextExpiry = Infinity;
    const time = now();
    const cacheMisses = new Map<number, { label: string; tokens: number; count: number; rows: string[] }>();
    const flushCache = (index: number) => {
      const miss = cacheMisses.get(index);
      if (!miss) return;
      cacheMisses.delete(index);
      const rows = notices.get(index) ?? [];
      // ponytail: first styled line carries the color; token text is plain digits so one replace is enough.
      const summary = miss.count === 1
        ? miss.rows[0]
        : miss.rows[0].replace(/[\d,.]+\s*[kKmM]?\s*tokens re-billed/, `${miss.count} misses, ${formatCacheTokens(miss.tokens)} tokens re-billed`);
      rows.push(summary);
      notices.set(index, rows);
    };
    for (const child of chat.children) {
      if (child.constructor.name === "UserMessageComponent") flushCache(turn);
      if (child.constructor.name === "UserMessageComponent") turn++;
      // Goal state is stored as a custom entry, not a user message. Adapt only
      // the known pi-codex-goal envelope so ordinary extension cards stay native.
      // Pi rebuilds this collapsed native component after every successful compaction.
      // Keep its one-line success marker at the current user turn without persisting another entry.
      if (child.constructor.name === "CompactionSummaryMessageComponent") {
        const rows = notices.get(turn) ?? [];
        rows.push(...child.render(width));
        notices.set(turn, rows);
        continue;
      }
      if (child.constructor.name === "CustomEntryComponent"
        && !(options.supervisor && supervisorNotice(supervisorEnvelope(child)))) {
        const goalRows = options.supervisor && compactGoalCard((child as unknown as { entry?: unknown }).entry, options.supervisor.theme, width, expandedNotices.get(child) ?? false);
        const rows = notices.get(turn) ?? [];
        if (!goalRows) {
          rows.push(...child.render(width));
          notices.set(turn, rows);
          continue;
        }
        const open = expandedNotices.get(child) ?? false;
        const targets = controls.get(turn) ?? [];
        targets.push({ y: rows.length, width, key: child, expanded: open });
        controls.set(turn, targets);
        rows.push(...goalRows);
        notices.set(turn, rows);
        continue;
      }
      // Known reply entries share notice grouping; unknown cards retain Pi's renderer.
      if (child.constructor.name === "CustomMessageComponent" || child.constructor.name === "CustomEntryComponent") {
        const rows = notices.get(turn) ?? [];
        const message = supervisorEnvelope(child);
        const notice = options.supervisor && supervisorNotice(message);
        const key = notice ? notice.key ?? child : child;
        const group = groups.get(key);
        if (group && group.first !== child) continue;
        if (group && options.supervisor) {
          const handled = options.supervisor.handledRunIds?.();
          const noticeIds = [notice?.runId, ...((notice as { runIds?: string[] } | undefined)?.runIds ?? [])].filter((id): id is string => !!id);
          if (handled && noticeIds.some(id => handled.has(id))) continue;
          const open = expandedNotices.get(key) ?? expanded;
          const label = group.notice.showLabel
            ? group.notice.label ?? ""
            : groups.size > 1 ? group.notice.label || `任务 ${groupKeys.indexOf(key) + 1}` : "";
          const targets = controls.get(turn) ?? [];
          targets.push({ y: rows.length, width, key, expanded: open });
          controls.set(turn, targets);
          rows.push(...compactSupervisorNotice(group.selected, options.supervisor.theme, width, open, label, group.messages)!);
        } else rows.push(...child.render(width));
        notices.set(turn, rows);
        continue;
      }
      // Pi 1.x renders command information (/session, /hotkeys) lazily for theme changes.
      if (child.constructor.name === "ThemedText") {
        const rows = notices.get(turn) ?? [];
        rows.push(...child.render(width));
        notices.set(turn, rows);
        continue;
      }
      // Tool images are step attachments, represented by hover links in the
      // compact view. Only assistant replies own inline image rows.
      if (child.constructor.name === "ToolExecutionComponent") continue;
      if (child.constructor.name !== "Text") continue;
      // Pi 0.85 Text stores the unwrapped styled source in text. Width changes
      // must not restart the timeout; setText updates must restart it.
      const source = (child as unknown as { text?: unknown }).text;
      const miss = options.foldCacheMiss?.() !== false && typeof source === "string" ? cacheMissLine(source) : undefined;
      if (miss) {
        const current = cacheMisses.get(turn) ?? { label: miss.label, tokens: 0, count: 0, rows: [] as string[] };
        current.tokens += miss.tokens;
        current.count++;
        current.rows.push(...child.render(width));
        cacheMisses.set(turn, current);
        continue;
      }
      if (typeof source === "string" && !options.isPrompt?.(source)) {
        if (options.hideStartupLine?.(source)) continue;
        if (options.isTransient?.(source)) {
          let state = noticeTimes.get(child);
          if (!state || state.text !== source) {
            state = { text: source, until: time + 5000 };
            noticeTimes.set(child, state);
          }
          if (time >= state.until) continue;
          nextExpiry = Math.min(nextExpiry, state.until);
        }
      }
      const rows = notices.get(turn) ?? [];
      rows.push(...child.render(width));
      notices.set(turn, rows);
    }
    flushCache(turn);
    scheduleExpiry(nextExpiry, time);
    for (const [turnIndex, targets] of controls) {
      notices.get(turnIndex)!.handleMouse = event => {
        if (event.button !== "left" || event.shift || event.ctrl || event.alt || (event.clickCount ?? 1) !== 1) return;
        const target = targets.find(target => event.y === target.y && event.x >= 0 && event.x < target.width);
        if (!target) return;
        if (event.type === "press") return { handled: true };
        if (event.type === "click") {
          expandedNotices.set(target.key, !target.expanded);
          return { handled: true, render: true };
        }
      };
    }
    return notices;
  };
}
