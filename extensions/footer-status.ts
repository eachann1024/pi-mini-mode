import { AGENT_STATUS_ENTRY, savedAgentStatuses, retainAgentStatuses, agentChildren, agentCall, agentStatusesByTurn, attachAgentWidgets, readAgentStatuses } from "../lib/agent-view.ts";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { attachTranscript } from "../lib/transcript-adapter.ts";
import { installSeamlessScrollbar } from "../lib/seamless-scrollbar.ts";
import { installInputEnhancements, type InputEnhancementsCleanup } from "../lib/input-enhancements.ts";
import { installTerminalCapabilities } from "../lib/terminal-capabilities.ts";
import { linkMessageFiles } from "../lib/file-links.ts";
import attachFooterTidy from "../lib/footer-tidy.ts";
import attachTitlePlain from "../lib/title-plain.ts";
import { COPY, DEFAULT_SETTINGS, FOOTER_FIELDS, FOOTER_STYLE_OPTIONS, RECOMMENDED_THEMES, SETTING_IDS, isLegacyMinimalSetting, isRecordLimit, loadSettings, parseSettings, saveSettings, settingsItems, settingsPath, type MiniLensSettings, type RecommendedTheme } from "../lib/settings.ts";
import { addUsage, cacheWaste, EMPTY_USAGE, finiteNumber, outputSpeed, sessionUsage, type ActiveGeneration, type UsageLike } from "../lib/usage.ts";
import { statusLine } from "../lib/footer-line.ts";
import { contentText, minimalTurnsFromBranch, processText, pushProcess, skillNames, type MinimalTurn } from "../lib/minimal-turns.ts";
import { minimalOutputComponent } from "../lib/minimal-output.ts";
import { createThinkingStream } from "../lib/thinking-stream.ts";

// Preserve the existing module entry points for consumers and focused checks.
export { SETTINGS_FILE_NAME, DEFAULT_SETTINGS, FOOTER_FIELDS, FOOTER_STYLE_OPTIONS, settingsPath, parseSettings, settingsNeedBackfill, loadSettings, saveSettings, settingsItems, type MiniLensSettings } from "../lib/settings.ts";
export { cacheWaste, sessionUsage, speedColor, formatSpeed, outputSpeed, DECODE_SPEED_MIN_ELAPSED_MS, DECODE_SPEED_MIN_OUTPUT, type CacheWaste, type SessionUsage, type SpeedColor } from "../lib/usage.ts";
export { isPlannotatorPlanningStatus, planCapsule, settingsPreviewLine, statusLine } from "../lib/footer-line.ts";
export { formatElapsed, formatToolElapsed, formatThinkingElapsed, minimalTurnsFromBranch, type MinimalTurn, type ThinkingClock } from "../lib/minimal-turns.ts";
export { minimalOutputComponent } from "../lib/minimal-output.ts";

/** Pi /model and other selectors own Ctrl+S; the editor exposes getText. */
export function focusedSelectorOwnsKeys(tui?: { getFocusedComponent?(): unknown } | null): boolean {
  const focused = tui?.getFocusedComponent?.();
  return !!focused && typeof focused === "object" && typeof (focused as { getText?: unknown }).getText !== "function";
}

function enabledMcpServerCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as { version?: unknown; servers?: unknown };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.servers)) return undefined;
  let count = 0;
  for (const server of snapshot.servers) {
    if (!server || typeof server !== "object" || Array.isArray(server)
      || typeof server.name !== "string"
      || (server.disabled !== undefined && typeof server.disabled !== "boolean")) return undefined;
    if (server.disabled !== true) count++;
  }
  return count;
}

export default function (pi: ExtensionAPI) {
  const restoreTerminalCapabilities = installTerminalCapabilities();
  pi.on("session_shutdown", restoreTerminalCapabilities);
  attachFooterTidy(pi);
  attachTitlePlain(pi);
  let refreshFooter: (() => void) | undefined;
  let restoreScrollbar: (() => void) | undefined;
  let scrollbarRoot: unknown;
  let refreshMinimal: (() => void) | undefined;
  let processExpanded = false;
  let nativeOutput = false;
  let subAgentsExpanded = false;
  let waitingTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeMinimalInput: (() => void) | undefined;
  let minimalTui: { getFocusedComponent?(): unknown } | undefined;
  let restoreAgentWidgets: (() => void) | undefined;
  let restoreTranscript: (() => void) | undefined;
  let persistAgentStatuses: (() => void) | undefined;
  let promptView: ReturnType<typeof minimalOutputComponent> | undefined;
  let lastAttachMode: string | undefined;
  let remountQueued = false;
  let settingsWeb: Awaited<ReturnType<typeof import("../lib/settings-web.ts").startSettingsWeb>> | undefined;
  let settingsWebOpening: Promise<void> | undefined;
  let settingsWebGeneration = 0;
  const agentDeadlines = new Map<string, number>();
  let minimalTurns: MinimalTurn[] = [];
  let activeMinimalTurn: MinimalTurn | undefined;
  let pendingMinimalFinal = "";
  const thinkingStream = createThinkingStream();
  let speed: number | undefined;
  let mcpCount: number | undefined;
  let activeGeneration: ActiveGeneration | undefined;
  let activeUIPrompt: { kind: string; title?: string } | undefined;
  const toolStarts = new Map<string, number>();
  const minimalToolOutputIndices = new Map<string, number>();
  let speedTimer: ReturnType<typeof setInterval> | undefined;
  let settings: MiniLensSettings = { ...DEFAULT_SETTINGS };
  let cleanupInputEnhancements: InputEnhancementsCleanup | undefined;
  let messageCwd = process.cwd();
  const messageLinks = (text: string) => settings["pi-mini-mode-input-enhancements"] ? linkMessageFiles(text, messageCwd) : text;
  pi.registerMarkdownTransformer?.(messageLinks);
  let saveChain: Promise<void> = Promise.resolve();
  const configPath = settingsPath();

  const refresh = () => refreshFooter?.();
  const refreshMinimalOutput = () => refreshMinimal?.();
  const mountMinimalOutput = (ctx: ExtensionContext) => {
    persistAgentStatuses = undefined;
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = undefined;
    unsubscribeMinimalInput?.();
    unsubscribeMinimalInput = undefined;
    restoreTranscript?.();
    restoreTranscript = undefined;
    restoreAgentWidgets?.();
    restoreAgentWidgets = undefined;
    promptView?.dispose();
    promptView = undefined;
    if (settings["pi-mini-mode-minimal-show"] && ctx.mode === "tui") unsubscribeMinimalInput = ctx.ui.onTerminalInput?.((data) => {
      const nativeKey = matchesKey(data, "ctrl+alt+o");
      const subAgentKey = matchesKey(data, "ctrl+s");
      if (!nativeKey && focusedSelectorOwnsKeys(minimalTui)) return;
      if (!nativeKey && (!restoreTranscript || (!subAgentKey && !matchesKey(data, "ctrl+o")))) return;
      // Input listeners run before Pi filters Kitty release/repeat events.
      if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
      if (nativeKey) {
        nativeOutput = !nativeOutput;
        mountMinimalOutput(ctx);
      } else if (subAgentKey) subAgentsExpanded = !subAgentsExpanded;
      else {
        processExpanded = !processExpanded;
        promptView?.resetProcessView();
      }
      refreshMinimalOutput();
      return { consume: true };
    });
    if (nativeOutput || !settings["pi-mini-mode-minimal-show"] || ctx.mode !== "tui") {
      minimalTui = undefined;
      lastAttachMode = undefined;
      ctx.ui.setWidget?.("pi-mini-mode-minimal-output", undefined);
      refreshMinimalOutput();
      refreshMinimal = undefined;
      return;
    }
    ctx.ui.setWidget("pi-mini-mode-minimal-output", (tui, theme) => {
      minimalTui = tui as unknown as { getFocusedComponent?(): unknown };
      refreshMinimal = () => tui.requestRender();
      // Retain children under their originating user turn, including while idle,
      // after a follow-up user message, and when rebuilding a saved session.
      const sessionKey = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "";
      let statuses = savedAgentStatuses(ctx.sessionManager.getBranch());
      const persisted = new Map(statuses.map(status => [String(status.runId), JSON.stringify(status)]));
      const saveStatuses = () => {
        for (const status of statuses) {
          const value = JSON.stringify(status);
          const key = String(status.runId);
          if (persisted.get(key) === value) continue;
          pi.appendEntry(AGENT_STATUS_ENTRY, status);
          persisted.set(key, value);
        }
      };
      statuses = retainAgentStatuses(statuses, readAgentStatuses(sessionKey));
      persistAgentStatuses = saveStatuses;
      saveStatuses();
      let lastStatusRead = Date.now();
      const supervisorNotices = new Map<string, { notice: any; messages: any[] }>();
      const handledRunIds = new Set<string>();
      const turnsWithAgents = () => {
        // A status directory is session-wide. Never attach an unclaimed snapshot
        // to the newest turn: an older async child may report after a follow-up.
        const assigned = agentStatusesByTurn(statuses, minimalTurns);
        handledRunIds.clear();
        return minimalTurns.map((turn, index) => {
          const turnAgents = assigned.get(index) ?? [];
          for (const status of turnAgents) {
            if (status.runId) handledRunIds.add(String(status.runId));
            if (status.parentWorkflowRunId) handledRunIds.add(String(status.parentWorkflowRunId));
          }
          const withNotices = agentChildren(turnAgents).map(sub => {
            if (sub.runId) handledRunIds.add(String(sub.runId));
            if (sub.parentWorkflowRunId) handledRunIds.add(String(sub.parentWorkflowRunId));
            const n = supervisorNotices.get(String(sub.runId));
            return n ? { ...sub, notice: n.notice, noticeMessages: n.messages } : sub;
          });
          return { ...turn, subAgents: withNotices };
        });
      };
      const view = minimalOutputComponent(theme, turnsWithAgents, () => processExpanded, () => true, () => subAgentsExpanded, agentDeadlines, messageLinks, {
        cwd: () => ctx.cwd,
        requestRender: () => tui.requestRender(),
        write: data => tui.terminal.write(data),
      }, () => settings["pi-mini-mode-minimal-record-limit"]);
      // Native info notifications use dim; warning/error notifications retain
      // their position in the transcript. No plugin names or message matching.
      const dimPrefix = theme.fg("dim", "\u0000").split("\u0000")[0];
      // Startup model diagnostics are reprinted into the resource header by /new and /reload.
      // Read the live predicate on every frame: the header is replaced after this factory returns.
      const hideStartupLine = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").includes("No models match pattern");
      // Transcript hover wrappers must surround the compact widget handlers;
      // unmount in reverse order so neither adapter resurrects stale handlers.
      restoreAgentWidgets = attachAgentWidgets(tui, theme, () => subAgentsExpanded, undefined, true);
      restoreTranscript = attachTranscript(tui, view, {
        turnCount: () => minimalTurns.length,
        supervisor: {
          theme,
          expanded: () => processExpanded,
          handledRunIds: () => handledRunIds,
          onNotices: groups => {
            let changed = false;
            for (const group of groups.values()) {
              const runId = String(group.notice.runId ?? "");
              if (runId) {
                const prev = supervisorNotices.get(runId);
                if (!prev || JSON.stringify(prev) !== JSON.stringify({ notice: group.notice, messages: group.messages })) {
                  supervisorNotices.set(runId, { notice: group.notice, messages: group.messages });
                  changed = true;
                }
              }
            }
            if (changed) {
              // Preserve notices inside their owning snapshot as well as Pi's original message.
              statuses = statuses.map(status => {
                const children = agentChildren([status]).map(child => {
                  const notice = supervisorNotices.get(String(child.runId));
                  return notice ? { ...child, notice: notice.notice, noticeMessages: notice.messages } : child;
                });
                return children.length ? { ...status, steps: children, workflowChildren: undefined, children: undefined } : status;
              });
              tui.requestRender();
            }
          },
        },
        isPrompt: text => !!activeUIPrompt && (!activeUIPrompt.title || text.includes(activeUIPrompt.title)),
        isTransient: text => !!dimPrefix && text.startsWith(dimPrefix),
        hideStartupLine,
      });
      lastAttachMode = typeof tui.mode === "string" ? tui.mode : undefined;
      if (!restoreTranscript) {
        restoreAgentWidgets?.();
        restoreAgentWidgets = undefined;
        // Settings overlay replaces the transcript; remount after it closes instead of warning.
        ctx.ui.notify(tui.mode === "regular"
          ? "Minimal output needs the fullscreen renderer. Quit and restart Pi — /reload does not switch TUI mode. Or set TUI mode to fullscreen in /settings."
          : "Pi transcript layout not recognized; minimal mode disabled, native output preserved.", "warning");
      }
      if (restoreTranscript) {
        promptView = view;
        waitingTimer = setInterval(() => {
          let changed = false;
          if (Date.now() - lastStatusRead >= 1000) {
            const next = retainAgentStatuses(statuses, readAgentStatuses(sessionKey, undefined, statuses));
            changed = JSON.stringify(next) !== JSON.stringify(statuses);
            statuses = next;
            saveStatuses();
            lastStatusRead = Date.now();
          }
          if (changed || Date.now() >= view.agentExpiry() || activeMinimalTurn?.running || agentChildren(statuses).some(child => /^(running|active|starting|queued|pending)$/.test(String(child.status ?? child.state)))) tui.requestRender();
        }, 100);
        waitingTimer.unref();
      }
      tui.requestRender();
      // Factory acquires the renderer only; never duplicate content in the dock.
      return { render: () => [], invalidate() {} };
    });
  };
  // All factories run before session_start; retain startup broadcasts until the footer mounts.
  const unsubscribeMcpStatus = pi.events.on("pi-mcp-adapter/status/v1", (value: unknown) => {
    const count = enabledMcpServerCount(value);
    if (count === undefined) return;
    mcpCount = count;
    refresh();
  });
  const stopSpeedTimer = () => {
    if (speedTimer) clearInterval(speedTimer);
    speedTimer = undefined;
  };
  const refreshStreamingSpeed = () => {
    if (!activeGeneration) return;
    const nextSpeed = outputSpeed(activeGeneration.output, activeGeneration.firstTokenAt);
    if (nextSpeed !== undefined) speed = nextSpeed;
    refresh();
  };
  const startSpeedTimer = () => {
    stopSpeedTimer();
    speedTimer = setInterval(refreshStreamingSpeed, 250);
  };
  const persistSettings = (ctx: ExtensionContext) => {
    const snapshot = { ...settings };
    saveChain = saveChain
      .catch(() => undefined)
      .then(() => saveSettings(snapshot, configPath))
      .catch(() => ctx.ui.notify(COPY.saveFailed, "error"));
    return saveChain;
  };
  const applyRecommendedHostSettings = async (ctx: ExtensionContext, themeName: RecommendedTheme): Promise<boolean> => {
    const theme = ctx.ui.getTheme(themeName);
    if (!theme) {
      ctx.ui.notify(`找不到主题 ${themeName}；请先确认 Pi 已发现本包主题。`, "error");
      return false;
    }
    try {
      const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? false });
      const initialErrors = manager.drainErrors();
      if (initialErrors.length) {
        ctx.ui.notify(`${COPY.themeSaveFailed} Pi 设置读取失败：${initialErrors.map(error => error.error.message).join("；")}`, "error");
        return false;
      }
      const projectSettings = manager.getProjectSettings();
      const projectOverrides = [
        typeof projectSettings.theme === "string" ? "主题" : undefined,
        projectSettings.tuiMode !== undefined ? "TUI 模式" : undefined,
      ].filter((value): value is string => value !== undefined);
      manager.setTheme(themeName);
      manager.setTuiMode("fullscreen");
      await manager.flush();
      const errors = manager.drainErrors();
      if (errors.length) {
        ctx.ui.notify(`${COPY.themeSaveFailed} Pi 设置可能已部分保存：${errors.map(error => error.error.message).join("；")}`, "error");
        return false;
      }
      const applied = ctx.ui.setTheme(theme);
      if (!applied.success) {
        ctx.ui.notify(`${COPY.themeApplyFailed}${applied.error ? ` ${applied.error}` : ""}`, "warning");
        return false;
      }
      mountMinimalOutput(ctx);
      refresh();
      ctx.ui.notify(projectOverrides.length
        ? `${COPY.themeSaved} 项目设置中的${projectOverrides.join("、")}优先级更高。`
        : COPY.themeSaved, "info");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${COPY.themeSaveFailed} ${detail}`, "error");
      return false;
    }
  };
  const openSettings = async (ctx: ExtensionContext) => {
    const generation = settingsWebGeneration;
    if (ctx.mode !== "tui") { ctx.ui.notify(COPY.tuiRequired, "error"); return; }
    try {
      if (settingsWeb && !settingsWeb.closed) settingsWeb.touch();
      else settingsWebOpening ??= (async () => {
        const { startSettingsWeb } = await import("../lib/settings-web.ts");
        const server = await startSettingsWeb(() => ({
          settings, defaults: DEFAULT_SETTINGS, order: FOOTER_FIELDS, options: FOOTER_STYLE_OPTIONS,
          items: settingsItems(settings),
          // "regular" means minimal output is saved but cannot mount; the page offers a Pi prompt.
          tuiMode: lastAttachMode ?? null,
        }), async value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid settings");
          const input = value as Record<string, unknown>;
          for (const [key, entry] of Object.entries(input)) {
            if (key === "footerOrder") {
              if (!Array.isArray(entry) || new Set(entry).size !== entry.length
                || entry.some(id => typeof id !== "string" || !(FOOTER_FIELDS as readonly string[]).includes(id))) throw new TypeError("Invalid order");
            } else if (key === "pi-mini-mode-image-preview") {
              if (entry !== "hover" && entry !== "inline") throw new TypeError("Invalid preview mode");
            } else if (key === "pi-mini-mode-minimal-record-limit") {
              if (!isRecordLimit(entry)) throw new TypeError("Invalid record limit");
            } else if (isLegacyMinimalSetting(key) && typeof entry === "boolean") {
              // Accept stale settings pages; these former child switches no longer gate output.
              continue;
            } else if (!SETTING_IDS.includes(key as typeof SETTING_IDS[number]) || typeof entry !== "boolean") throw new TypeError("Invalid setting");
          }
          const next = parseSettings({ ...settings, ...input, onboardingCompleted: true });
          await saveSettings(next, configPath);
          settings = next;
          cleanupInputEnhancements?.refresh();
          refresh();
          mountMinimalOutput(ctx);
          refreshMinimalOutput();
        }, { onClose: () => { if (settingsWeb === server) settingsWeb = undefined; } });
        if (generation !== settingsWebGeneration) { server.close(); return; }
        settingsWeb = server;
      })().finally(() => { if (generation === settingsWebGeneration) settingsWebOpening = undefined; });
      await settingsWebOpening;
      if (generation !== settingsWebGeneration || !settingsWeb || settingsWeb.closed) return;
      const url = settingsWeb.url;
      const result = process.platform === "darwin" ? await pi.exec("open", [url])
        : process.platform === "win32" ? await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", url])
        : await pi.exec("xdg-open", [url]);
      if (result.code !== 0) ctx.ui.notify(`请在本机浏览器打开：${url}`, "warning");
    } catch (error) {
      if (!settingsWeb) settingsWebOpening = undefined;
      ctx.ui.notify(`无法打开设置：${error instanceof Error ? error.message : String(error)}${settingsWeb ? `\n${settingsWeb.url}` : ""}`, "error");
    }
  };

  const runOnboarding = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `Pi Mini Mode ${COPY.preview}\n\n  deepseek-v4-flash  high  ${COPY.totalLabel} 45K  ${COPY.cacheHitLabel} 40.0%  $0.012  500/1.0M  ⣿⣀⣀⣀⣀⣀⣀⣀⣀⣀  1%  120 tok/s\n\n${COPY.onboarding}`,
        [COPY.keepDefaults, COPY.configureNow, COPY.applyRecommended],
      );
    } catch (error) {
      ctx.ui.notify(`首次配置未完成：${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (!choice) return;
    if (choice === COPY.applyRecommended) {
      let themeName: string | undefined;
      try {
        const available = RECOMMENDED_THEMES.filter(name => ctx.ui.getTheme(name));
        if (!available.length) {
          ctx.ui.notify("未发现 cc-dark 或 cc-light 主题；请确认本包主题已加载。", "error");
          return;
        }
        themeName = await ctx.ui.select(COPY.chooseTheme, available);
      } catch (error) {
        ctx.ui.notify(`推荐配置未完成：${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!themeName || !RECOMMENDED_THEMES.includes(themeName as RecommendedTheme)) return;
      if (!await applyRecommendedHostSettings(ctx, themeName as RecommendedTheme)) return;
    }
    settings = { ...settings, onboardingCompleted: true };
    await persistSettings(ctx);
    if (choice === COPY.configureNow) await openSettings(ctx);
  };
  pi.registerCommand("pi-mini-mode-settings", {
    description: "Open browser settings for footer fields, image previews, and minimal output",
    handler: async (_args, ctx) => openSettings(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    (ctx as ExtensionContext & { __applyMinimal?: (on: boolean) => void }).__applyMinimal = (on) => {
      settings = { ...settings, "pi-mini-mode-minimal-show": on };
      if (on) nativeOutput = false;
      mountMinimalOutput(ctx);
    };
    const loaded = await loadSettings(configPath);
    settings = loaded.settings;
    if (loaded.exists && loaded.backfilled) await persistSettings(ctx);
    messageCwd = ctx.cwd;
    // 输入增强只在会话中生效，会话开始时再加载；传 getter 让开关变更即时生效，重复调用是幂等的。
    cleanupInputEnhancements = installInputEnhancements(pi, ctx, () => settings["pi-mini-mode-input-enhancements"], () => settings["pi-mini-mode-image-preview"]);
    thinkingStream.stop(activeMinimalTurn, "aborted");
    thinkingStream.reset();
    minimalTurns = minimalTurnsFromBranch(ctx.sessionManager.getBranch());
    activeMinimalTurn = undefined;
    pendingMinimalFinal = "";
    minimalToolOutputIndices.clear();
    mountMinimalOutput(ctx);
    ctx.ui.setFooter((tui, theme, footerData) => {
      restoreScrollbar?.();
      scrollbarRoot = undefined;
      const syncScrollbar = () => {
        const root = (tui as typeof tui & { layoutRoot?: unknown }).layoutRoot;
        if (root === scrollbarRoot) return;
        restoreScrollbar?.();
        scrollbarRoot = root;
        restoreScrollbar = installSeamlessScrollbar(tui, theme);
      };
      syncScrollbar();
      refreshFooter = () => tui.requestRender();
      return {
        dispose: footerData?.onBranchChange?.(() => tui.requestRender()),
        invalidate() {},
        render(width: number): string[] {
          syncScrollbar();
          // switchTuiMode does not re-run setWidget; remount once the live renderer is fullscreen.
          if (settings["pi-mini-mode-minimal-show"] && !nativeOutput && ctx.mode === "tui" && !restoreTranscript
            && tui.mode !== "regular" && lastAttachMode === "regular" && !remountQueued) {
            remountQueued = true;
            queueMicrotask(() => {
              remountQueued = false;
              mountMinimalOutput(ctx);
            });
          }
          return [statusLine(ctx, theme, width, sessionUsage(ctx), settings, speed, undefined, mcpCount, footerData?.getExtensionStatuses?.(), footerData?.getGitBranch?.(), cacheWaste(ctx.sessionManager.getBranch()))];
        },
      };
    });
    refresh();
    if (!settings.onboardingCompleted && ctx.mode === "tui" && ctx.hasUI) await runOnboarding(ctx);
  });
  const syncMinimalBranch = (_event: unknown, ctx: ExtensionContext) => {
    thinkingStream.stop(activeMinimalTurn, "aborted");
    minimalTurns = minimalTurnsFromBranch(ctx.sessionManager.getBranch());
    activeMinimalTurn = undefined;
    pendingMinimalFinal = "";
    thinkingStream.reset();
    minimalToolOutputIndices.clear();
    mountMinimalOutput(ctx);
    refreshMinimalOutput();
  };
  // New/switch/fork emit session_start; tree navigation has its own event.
  pi.on("session_tree", syncMinimalBranch);
  pi.on("session_compact", (event, ctx) => {
    // Compaction during execution must not discard the in-flight turn or indexes.
    if (activeMinimalTurn) { refreshMinimalOutput(); return; }
    syncMinimalBranch(event, ctx);
  });
  pi.on("before_agent_start", (event) => {
    if (!activeMinimalTurn) return;
    for (const name of skillNames(event.prompt)) pushProcess(activeMinimalTurn, "skill", name);
    refreshMinimalOutput();
  });
  pi.on("ui_prompt_start", (event) => {
    activeUIPrompt = event;
    refreshMinimalOutput();
  });
  pi.on("ui_prompt_end", () => {
    activeUIPrompt = undefined;
    refreshMinimalOutput();
  });
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      if (activeMinimalTurn) {
        thinkingStream.stop(activeMinimalTurn, "aborted");
        activeMinimalTurn.final = pendingMinimalFinal;
        activeMinimalTurn.running = false;
        activeMinimalTurn.endedAt ??= Date.now();
        activeMinimalTurn.thinking = undefined;
        promptView?.resetProcessView();
      }
      const question = contentText(event.message.content) || "[Attachment]";
      processExpanded = false;
      subAgentsExpanded = false;
      activeMinimalTurn = { question, process: [], running: true, startedAt: Date.now(), awaitingResponse: true };
      for (const name of skillNames(question)) pushProcess(activeMinimalTurn, "skill", name);
      pendingMinimalFinal = "";
      minimalToolOutputIndices.clear();
      thinkingStream.reset();
      minimalTurns.push(activeMinimalTurn);
      refreshMinimalOutput();
    }
    if (event.message.role !== "assistant") return;
    // Background completions can start a new assistant turn without a user message.
    if (!activeMinimalTurn?.running) {
      processExpanded = false;
      promptView?.resetProcessView();
    }
    activeMinimalTurn ??= minimalTurns.at(-1);
    if (activeMinimalTurn) {
      thinkingStream.start(activeMinimalTurn, event.message.timestamp);
      if (activeMinimalTurn.final) (activeMinimalTurn.replies ??= []).push(activeMinimalTurn.final);
      activeMinimalTurn.final = undefined;
      activeMinimalTurn.running = true;
      activeMinimalTurn.endedAt = undefined;
      activeMinimalTurn.awaitingResponse = true;
      activeMinimalTurn.thinking = undefined;
    }
    pendingMinimalFinal = "";
    // Keep the last completed speed visible until this response produces tokens.
    // Tool-call-only assistant messages therefore cannot erase a useful rate.
    // Decode clock starts on the first output token, not message_start (TTFT).
    const sampledAt = Date.now();
    activeGeneration = { output: 0, lastSampleAt: sampledAt };
    startSpeedTimer();
  });
  pi.on("message_update", (event) => {
    const partial = (event.assistantMessageEvent as { partial?: { usage?: UsageLike; content?: Array<Record<string, unknown>> } }).partial;
    if (activeMinimalTurn && partial?.content) {
      if (!thinkingStream.update(activeMinimalTurn, partial.content, event.assistantMessageEvent)) return;
      if (partial.content.length) activeMinimalTurn.awaitingResponse = false;
      activeMinimalTurn.final = contentText(partial.content) || undefined;
      refreshMinimalOutput();
    }
    if (activeMinimalTurn && partial?.usage) {
      activeMinimalTurn.pendingUsage = partial.usage;
      refreshMinimalOutput();
    }
    const usage = partial?.usage;
    const output = finiteNumber(usage?.output);
    const timestamp = Date.now();
    const hasOutputContent = Array.isArray(partial?.content) && partial.content.length > 0;
    if (activeGeneration && timestamp >= activeGeneration.lastSampleAt) {
      if (activeGeneration.firstTokenAt === undefined && (hasOutputContent || (output !== undefined && output > 0))) {
        activeGeneration.firstTokenAt = timestamp;
      }
      if (output !== undefined && output >= activeGeneration.output) {
        activeGeneration.output = output;
        activeGeneration.lastSampleAt = timestamp;
        refreshStreamingSpeed();
      }
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      if (activeMinimalTurn) {
        const content = Array.isArray(event.message.content) ? event.message.content as unknown as Array<Record<string, unknown>> : [];
        const outcome = event.message.stopReason === "error" || event.message.stopReason === "aborted" ? event.message.stopReason : "done";
        if (!thinkingStream.finish(activeMinimalTurn, content, outcome, event.message.timestamp)) return;
        activeMinimalTurn.usage = addUsage(activeMinimalTurn.usage ?? EMPTY_USAGE, event.message.usage as UsageLike | undefined);
        activeMinimalTurn.pendingUsage = undefined;
      }
      if (activeGeneration) {
        const finalSpeed = outputSpeed((event.message.usage as UsageLike | undefined)?.output, activeGeneration.firstTokenAt);
        if (finalSpeed !== undefined) speed = finalSpeed;
        activeGeneration = undefined;
        stopSpeedTimer();
      }
      const content = (event.message as { content?: unknown }).content;
      if (activeMinimalTurn && Array.isArray(content)) {
        for (const item of content as Array<Record<string, unknown>>) {
          if (item?.type === "text" && content.some((block) => block?.type === "toolCall")) {
            activeMinimalTurn.process.push(`output ${processText(item.text)}`);
          }
        }
        const text = contentText(content);
        const message = event.message as { stopReason?: string; errorMessage?: string };
        activeMinimalTurn.final = undefined;
        pendingMinimalFinal = content.some((item) => item?.type === "toolCall") ? "" : text;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          pendingMinimalFinal = [message.stopReason === "aborted" ? "Execution aborted" : "Execution failed", message.errorMessage, pendingMinimalFinal].filter(Boolean).join("\n");
        }
        activeMinimalTurn.final = pendingMinimalFinal || undefined;
      }
    }
    refresh();
    refreshMinimalOutput();
  });
  pi.on("tool_execution_start", (event) => {
    toolStarts.set(event.toolCallId, Date.now());
    if (activeMinimalTurn) {
      thinkingStream.stop(activeMinimalTurn);
      activeMinimalTurn.awaitingResponse = false;
      (activeMinimalTurn.agentCalls ??= []).push({ ...agentCall(event.toolCallId, event.toolName, event.args), startedAt: toolStarts.get(event.toolCallId) });
      pushProcess(activeMinimalTurn, "call", event.toolCallId);
      (activeMinimalTurn.waitingTools ??= []).push({ id: event.toolCallId, name: event.toolName, startedAt: Date.now() });
    }
    const path = (event.args as { path?: unknown })?.path;
    if (typeof path === "string" && /(?:^|\/)SKILL\.md$/i.test(path)) {
      pushProcess(activeMinimalTurn, "skill", path.split("/").at(-2) ?? path);
    }
    refreshMinimalOutput();
  });
  pi.on("tool_execution_update", (event) => {
    if (!activeMinimalTurn) return;
    // Pi emits an empty content array before starting bash. It is a heartbeat,
    // not output: keep the tool status (and any existing output) intact.
    const text = contentText(event.partialResult);
    if (!text) return;
    const call = activeMinimalTurn.agentCalls?.find(call => call.id === event.toolCallId);
    if (call) { call.output = text; activeMinimalTurn.waitingTools = activeMinimalTurn.waitingTools?.filter(tool => tool.id !== event.toolCallId); refreshMinimalOutput(); return; }
    activeMinimalTurn.waitingTools = activeMinimalTurn.waitingTools?.filter((tool) => tool.id !== event.toolCallId);
    const line = `output ${text}`;
    const index = minimalToolOutputIndices.get(event.toolCallId);
    if (index === undefined) {
      minimalToolOutputIndices.set(event.toolCallId, activeMinimalTurn.process.length);
      activeMinimalTurn.process.push(line);
    } else {
      activeMinimalTurn.process[index] = line;
    }
    refreshMinimalOutput();
  });
  pi.on("tool_execution_end", (event) => {
    const startedAt = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    const nestedUsage = (event.result as { usage?: UsageLike } | undefined)?.usage;
    if (activeMinimalTurn) activeMinimalTurn.usage = addUsage(activeMinimalTurn.usage ?? EMPTY_USAGE, nestedUsage);
    // Nested tool LLM completions must not overwrite a measured main-turn decode rate.
    if (startedAt !== undefined && speed === undefined) {
      const nestedSpeed = outputSpeed(nestedUsage?.output, startedAt);
      if (nestedSpeed !== undefined) speed = nestedSpeed;
    }
    const call = activeMinimalTurn?.agentCalls?.find(call => call.id === event.toolCallId);
    if (call) {
      if (activeMinimalTurn) activeMinimalTurn.waitingTools = activeMinimalTurn.waitingTools?.filter(tool => tool.id !== event.toolCallId);
      call.endedAt = Date.now();
      call.state = event.isError ? "error" : "done";
      call.output = contentText(event.result) || (event.isError ? "Call failed (no text details)" : "Call returned (background task status below)");
      refresh();
      refreshMinimalOutput();
      return;
    }
    if (activeMinimalTurn) {
      activeMinimalTurn.waitingTools = activeMinimalTurn.waitingTools?.filter((tool) => tool.id !== event.toolCallId);
      const text = contentText(event.result) || (event.isError ? "Tool failed (no text details)" : "Tool completed (no text output)");
      const line = `${event.isError ? "output error" : "output"} ${text}`;
      const index = minimalToolOutputIndices.get(event.toolCallId);
      if (index === undefined) activeMinimalTurn.process.push(line);
      else activeMinimalTurn.process[index] = line;
    }
    minimalToolOutputIndices.delete(event.toolCallId);
    refresh();
    refreshMinimalOutput();
  });
  pi.on("agent_start", refresh);
  pi.on("agent_end", refresh);
  pi.on("agent_settled", () => {
    if (!activeMinimalTurn) return;
    for (const turn of minimalTurns) {
      thinkingStream.stop(turn);
      if (turn.running) turn.endedAt = Date.now();
      turn.running = false;
      turn.thinking = undefined;
    }
    activeMinimalTurn.final = pendingMinimalFinal;
    processExpanded = false;
    subAgentsExpanded = false;
    promptView?.resetProcessView();
    activeMinimalTurn = undefined;
    pendingMinimalFinal = "";
    thinkingStream.reset();
    minimalToolOutputIndices.clear();
    refreshMinimalOutput();
  });
  pi.on("session_shutdown", () => {
    thinkingStream.stop(activeMinimalTurn, "aborted");
    thinkingStream.reset();
    restoreScrollbar?.();
    restoreScrollbar = undefined;
    scrollbarRoot = undefined;
    // In-flight startup checks this generation before installing its server.
    settingsWebGeneration++;
    settingsWeb?.close();
    settingsWeb = undefined;
    settingsWebOpening = undefined;
    cleanupInputEnhancements?.();
    cleanupInputEnhancements = undefined;
    persistAgentStatuses?.();
    persistAgentStatuses = undefined;
    agentDeadlines.clear();
    promptView?.dispose();
    promptView = undefined;
    unsubscribeMcpStatus();
    refreshFooter = undefined;
    activeGeneration = undefined;
    activeUIPrompt = undefined;
    toolStarts.clear();
    minimalToolOutputIndices.clear();
    refreshMinimal = undefined;
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = undefined;
    unsubscribeMinimalInput?.();
    unsubscribeMinimalInput = undefined;
    restoreTranscript?.();
    restoreTranscript = undefined;
    restoreAgentWidgets?.();
    restoreAgentWidgets = undefined;
    stopSpeedTimer();
  });
}

/** @internal tests flip minimal output without a slash command. */
export function applyMinimal(ctx: ExtensionContext, on: boolean): void {
  const hook = (ctx as ExtensionContext & { __applyMinimal?: (on: boolean) => void }).__applyMinimal;
  hook?.(on);
}
