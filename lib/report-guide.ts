/**
 * Reply-format guidance for investigations and decisions.
 *
 * The guide is chosen per run from the surface that will actually display the reply:
 * - "capsule": Pi's TUI with the minimal transcript renders `[…]` tokens as colored pills
 *   and turns numbered options into the decision dock.
 * - "markdown": every other surface (RPC/GUI hosts such as T3 Code, JSON, print, Pi's native
 *   transcript) only sees plain Markdown, so the guide asks for emoji + bold instead of tokens.
 */

export type ReportProfile = "capsule" | "markdown";

/** Structured system-prompt section name; Pi wraps it as `<pi-mini-mode-reporting>…</…>`. */
export const REPORT_SECTION = "pi-mini-mode-reporting";
/** Legacy marker from the forced-prompt implementation; kept so stale prompts are not doubled. */
export const LEGACY_REPORT_MARKER = "<!-- pi-mini-mode:semantic-triage -->";

export interface ReportSurface {
  guideEnabled: boolean;
  /** True only when the reply will be painted by the minimal TUI transcript with pills enabled. */
  capsulesRendered: boolean;
}

export function resolveReportProfile(surface: ReportSurface): ReportProfile | undefined {
  if (!surface.guideEnabled) return undefined;
  return surface.capsulesRendered ? "capsule" : "markdown";
}

const SCOPE = `Applies only to replies that report a bug investigation, a failed check/build/deploy, a change-risk review, or that need the user to choose between real alternatives. All other replies stay ordinary prose with none of the markers below.
- Open with one plain sentence: what happened and whether things are safe right now.
- Mark certainty only on claims where it is mixed; skip markers when everything was directly observed.
- List options only when the user must decide and you cannot reasonably decide alone: 2–4 numbered one-line options, each with its trade-off, exactly one recommended. Never invent a decision to fill the format.
- Write markers in the reply language and keep the user's tone; no box-drawing characters.`;

const CAPSULE = `Markers (this terminal renders each bracket as a colored pill; write them bare, not in backticks):
- Optional status line when several checks apply: [✓ 正常 N] [× 失败 N] [? 还没查 N] — English: [✓ Done N] [× Failed N] [? Unverified N].
- Certainty prefix on a bullet: [!亲眼确认] / [!合理推测] / [? 还没查] — English: [!Observed] / [!Inferred] / [? Unverified]. Cross-module impact: [!影响范围] / [!Shared].
- Decision: put [● 等你定] / [● Needs you] before the numbered list; tag options with [★ 推荐] / [★ Recommended] and risky ones with [! 高风险] / [! Destructive].`;

const MARKDOWN = `Markers (the viewer shows plain Markdown, so never use square-bracket tags or backtick-wrapped labels):
- Optional status line when several checks apply: ✅ 正常 N · ❌ 失败 N · ❓ 还没查 N — English: ✅ Done N · ❌ Failed N · ❓ Unverified N.
- Certainty prefix on a bullet: ✅ 亲眼确认 / 🔎 合理推测 / ❓ 还没查 — English: ✅ Observed / 🔎 Inferred / ❓ Unverified. Cross-module impact: ⚠️ 影响范围 / ⚠️ Shared.
- Decision: a bold line **👉 需要你决定** / **👉 Your call** before the numbered list; append ⭐ 推荐 / ⭐ Recommended to one option and ⚠️ 高风险 / ⚠️ Risky to dangerous ones.`;

export function reportGuide(profile: ReportProfile): string {
  return `${SCOPE}\n${profile === "capsule" ? CAPSULE : MARKDOWN}`;
}

type PromptOptionsLike = { sections?: Record<string, string> } | undefined;

/**
 * Install (or remove) the guide for one run.
 * Prefers Pi's structured `sections` so the prompt is patched in place and the provider cache
 * survives; falls back to appending to the full prompt on Pi builds without sections.
 */
export function applyReportGuide(
  event: { systemPrompt?: unknown; systemPromptOptions?: unknown },
  profile: ReportProfile | undefined,
): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions as PromptOptionsLike;
  if (options && options.sections && typeof options.sections === "object") {
    if (profile) options.sections[REPORT_SECTION] = reportGuide(profile);
    else delete options.sections[REPORT_SECTION];
    return undefined;
  }
  if (!profile || typeof event.systemPrompt !== "string" || !event.systemPrompt) return undefined;
  if (event.systemPrompt.includes(`<${REPORT_SECTION}>`) || event.systemPrompt.includes(LEGACY_REPORT_MARKER)) return undefined;
  return { systemPrompt: `${event.systemPrompt}\n\n<${REPORT_SECTION}>\n${reportGuide(profile)}\n</${REPORT_SECTION}>` };
}
