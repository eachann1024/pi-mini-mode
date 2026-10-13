import type { Component } from "@earendil-works/pi-tui";
import { attachStickyTool } from "./sticky-tool.ts";
import { attachImageRedraw } from "./image-placement.ts";
import { createTurnNoticeRenderer, type NoticeOptions, type NoticeRows, type TurnNotices } from "./transcript-notice-render.ts";

export { formatInterview, extractNoticeBody, supervisorNotice, supervisorNoticeBody, cacheMissLine } from "./transcript-notices.ts";
export { compactGoalCard, compactSupervisorNotice } from "./transcript-cards.ts";
export type { NoticeRows, TurnNotices } from "./transcript-notice-render.ts";

interface ContainerLike extends Component { children: Component[] }
function isContainer(value: unknown): value is ContainerLike {
  const node = value as Partial<ContainerLike> | null;
  return !!node && Array.isArray(node.children) && typeof node.render === "function" && typeof node.invalidate === "function";
}

interface TranscriptView extends Component {
  render(width: number, notices?: TurnNotices): string[];
  clearHover?(): boolean;
  pinnedTool?(): { id: string; y: number; line: string } | undefined;
  unpinTool?(): void;
  toggleTool?(id: string): void;
  pinnedAgent?(): { index: number; y: number; line: string } | undefined;
  unpinAgent?(): void;
  pinnedSubagent?(): { id: string; y: number; line: string; autoScroll?: boolean } | undefined;
  unpinSubagent?(): void;
  toggleSubagent?(id: string): void;
}

export function attachTranscript(tui: unknown, view: TranscriptView, options: NoticeOptions = {}): (() => void) | undefined {
  const host = tui as { children?: unknown[]; mode?: string; viewportTop?: number };
  // Regular mode owns terminal scrollback. Replacing its whole document means a
  // streamed update to an older row forces TuiMainScreen's scrollback-clearing redraw.
  // Keep native transcript diffing there; fullscreen's ScrollView is safe to adapt.
  if (host.mode === "regular") return;
  // Both layouts retain this seven-container tree. Fail closed on unknown layouts.
  if (!Array.isArray(host.children) || host.children.length !== 7 || !host.children.every(isContainer)) return;
  const document = host.children[0] as ContainerLike;
  if (document.children.length !== 3 || !document.children.every(isContainer)) return;
  const [header, resources, chat] = document.children as ContainerLike[];
  const restoreImageRedraw = attachImageRedraw(tui);
  // During /reload Pi replaces the editor with a reload notice until AFTER
  // session_start. The validated document/container layout remains unchanged.
  // Custom editors also need not expose getText; do not use editor contents
  // as a transcript identity check.
  const renderDescriptor = Object.getOwnPropertyDescriptor(document, "render");
  const mouseDescriptor = Object.getOwnPropertyDescriptor(document, "handleMouse");
  const originalRender = document.render;
  const originalMouse = document.handleMouse;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  });
  let cancelExpiry: (() => void) | undefined;
  const renderNotices = createTurnNoticeRenderer(chat, options, now, (nextExpiry, time) => {
    if (Number.isFinite(nextExpiry)) {
      cancelExpiry = schedule(() => {
        cancelExpiry = undefined;
        (tui as { requestRender?: () => void }).requestRender?.();
      }, Math.max(0, nextExpiry - time));
    }
  });
  let prefixNotices: NoticeRows = [];
  let prefixNoticeOffset = 0;
  let viewOffset = 0;
  let viewHeight = 0;
  let stickyMinHeight = 0;
  let viewportTop = host.viewportTop;
  const render: Component["render"] = (width) => {
    cancelExpiry?.();
    cancelExpiry = undefined;
    const notices = renderNotices(width);
    if (!notices) {
      prefixNotices = [];
      prefixNoticeOffset = viewOffset = viewHeight = 0;
      view.clearHover?.();
      return originalRender.call(document, width);
    }
    const startupLine = options.hideStartupLine;
    const resourceRows = startupLine
      ? resources.render(width).filter(line => !startupLine(line))
      : resources.render(width);
    const prefix = [...header.render(width), ...resourceRows];
    prefixNoticeOffset = prefix.length;
    prefixNotices = notices.get(-1) ?? [];
    prefix.push(...prefixNotices);
    if (viewportTop !== host.viewportTop || viewOffset !== prefix.length) view.clearHover?.();
    viewportTop = host.viewportTop;
    const rows = view.render(width, notices);
    viewOffset = prefix.length;
    viewHeight = rows.length;
    const result = [...prefix, ...rows];
    while (result.length < stickyMinHeight) result.push("");
    return result;
  };
  // Do not dispatch pointer events into invisible native message components.
  // Unhandled events still reach the parent ScrollView / selection machinery.
  const mouse: NonNullable<Component["handleMouse"]> = event => {
    const cleared = (event.type === "wheel" || event.y < viewOffset || event.y >= viewOffset + viewHeight) && view.clearHover?.();
    if (cleared && event.type === "move") return { handled: true, render: true };
    if (event.y >= prefixNoticeOffset && event.y < viewOffset) return prefixNotices.handleMouse?.({ ...event, y: event.y - prefixNoticeOffset });
    if (event.y < viewOffset || event.y >= viewOffset + viewHeight) return;
    return view.handleMouse?.({ ...event, y: event.y - viewOffset, height: viewHeight });
  };
  document.render = render;
  document.handleMouse = mouse;
  // Dock events never reach the document. Observe normalized events without
  // stealing wheel/selection or changing Pi's mouse protocol/listener order.
  const restoreDock = view.clearHover ? host.children.slice(1).map(child => {
    const dock = child as Component;
    const descriptor = Object.getOwnPropertyDescriptor(dock, "handleMouse");
    const original = dock.handleMouse;
    const handle: NonNullable<Component["handleMouse"]> = event => {
      const cleared = view.clearHover?.();
      const result = original?.call(dock, event);
      if (result) return cleared ? { ...result, render: true } : result;
      return cleared && event.type === "move" ? { handled: true, render: true } : undefined;
    };
    dock.handleMouse = handle;
    return () => {
      if (dock.handleMouse !== handle) return;
      if (descriptor) Object.defineProperty(dock, "handleMouse", descriptor);
      else delete dock.handleMouse;
    };
  }) : [];
  const hasStickyAgent = view.pinnedAgent && view.unpinAgent;
  const hasStickyTool = view.pinnedTool && view.unpinTool && view.toggleTool;
  const hasStickySubagent = view.pinnedSubagent && view.unpinSubagent && view.toggleSubagent;
  const restoreSticky = hasStickyAgent || hasStickyTool || hasStickySubagent ? attachStickyTool(tui, document, {
    pinnedTool: () => {
      const agent = view.pinnedAgent?.();
      if (agent) return { id: `agent:${agent.index}`, y: agent.y + viewOffset, line: agent.line };
      const target = view.pinnedSubagent?.() ?? view.pinnedTool?.();
      if (!target) return;
      const kind = view.pinnedSubagent?.() ? "subagent" : "tool";
      return { ...target, id: `${kind}:${target.id}`, y: target.y + viewOffset };
    },
    unpinTool: () => {
      view.unpinAgent?.();
      view.unpinSubagent?.();
      view.unpinTool?.();
    },
    toggleTool: id => {
      const [kind, targetId] = id.split(":", 2);
      if (kind === "agent") view.handleMouse?.({ type: "click", button: "left", x: 0, y: view.pinnedAgent?.()?.y ?? 0, screenX: 0, screenY: 0, width: 1, height: 1, clickCount: 1, shift: false, ctrl: false, alt: false });
      else if (kind === "subagent") view.toggleSubagent?.(targetId);
      else if (kind === "tool") view.toggleTool?.(targetId);
    },
  }, height => { stickyMinHeight = height; }) : undefined;
  return () => {
    restoreImageRedraw?.();
    restoreSticky?.();
    cancelExpiry?.();
    view.clearHover?.();
    for (const restore of restoreDock) restore();
    if (document.render === render) {
      if (renderDescriptor) Object.defineProperty(document, "render", renderDescriptor);
      else { delete (document as Partial<Component>).render; if (document.render !== originalRender) document.render = originalRender; }
    }
    if (document.handleMouse === mouse) {
      if (mouseDescriptor) Object.defineProperty(document, "handleMouse", mouseDescriptor);
      else { delete document.handleMouse; if (document.handleMouse !== originalMouse) document.handleMouse = originalMouse; }
    }
  };
}
