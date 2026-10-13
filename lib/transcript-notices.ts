import { stripVTControlCharacters } from "node:util";

export const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
export const isSupervisorReply = (message: unknown) => record(message)?.customType === "subagent_supervisor_reply";

/** Structured interview questions are the prompt; IDs and reply hints stay out. */
export function formatInterview(interview: unknown): string {
  const data = record(interview);
  if (!data) return typeof interview === "string" ? clean(interview) : "";
  const lines: string[] = [];
  if (typeof data.title === "string" && data.title.trim()) lines.push(clean(data.title));
  const questions = Array.isArray(data.questions) ? data.questions : [];
  questions.forEach((question, index) => {
    if (typeof question === "string") {
      if (question.trim()) lines.push(`${index + 1}. ${clean(question)}`);
      return;
    }
    const item = record(question);
    if (!item) return;
    const prompt = [item.prompt, item.question, item.text, item.label].find(value => typeof value === "string" && String(value).trim());
    if (typeof prompt === "string") lines.push(`${index + 1}. ${clean(prompt)}`);
    const options = Array.isArray(item.options) ? item.options : Array.isArray(item.choices) ? item.choices : [];
    for (const option of options) {
      const label = typeof option === "string" ? option : typeof record(option)?.label === "string" ? String(record(option)!.label) : "";
      if (label.trim()) lines.push(`   - ${clean(label)}`);
    }
  });
  return lines.join("\n");
}

function withInterview(body: string, interview: unknown): string {
  const questions = formatInterview(interview);
  if (!questions) return body;
  return body ? `${body}\n${questions}` : questions;
}

export function extractNoticeBody(message: unknown): string {
  const item = record(message);
  if (!item) return typeof message === "string" ? clean(message) : "";
  const details = record(item.details);
  const interview = details?.interview;
  if (details) {
    const event = record(details.event);
    const body = typeof details.requestBody === "string"
      ? details.requestBody
      : typeof event?.message === "string"
        ? event.message
        : typeof details.message === "string"
          ? details.message
          : undefined;
    if (body) {
      let cleanBody = stripVTControlCharacters(body).replace(/^UPDATE:\s*/i, "").trim();
      const failureReason = typeof event?.reason === "string" && ["tool_failures", "completion_guard"].includes(event.reason)
        ? event.reason === "tool_failures" ? "工具执行失败" : "任务完成受阻"
        : undefined;
      if (failureReason && !cleanBody.includes(failureReason)) cleanBody = `[${failureReason}] ${cleanBody}`;
      return withInterview(cleanBody, interview);
    }
    const questions = formatInterview(interview);
    if (questions) return questions;
  }
  const raw = typeof item.content === "string" ? item.content : "";
  if (raw) {
    const filtered = stripVTControlCharacters(raw)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line
        && !/^(?:Subagent (?:progress update|needs a supervisor decision|control notice)|Supervisor (?:progress update|decision request|interview request))\b/i.test(line)
        && !/^(?:Run|Agent|Child index|Child target|Request ID|Live guidance|Reply with|Request|Interview shape):\s*/i.test(line)
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)
      )
      .join("\n")
      .replace(/^UPDATE:\s*/i, "")
      .trim();
    if (filtered) return withInterview(filtered, interview);
  }
  const questions = formatInterview(interview);
  if (questions) return questions;
  return typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? item, null, 2);
}

/** Only pi-subagents' known envelopes carry state; prose is never a status signal. */
export function supervisorNotice(message: unknown) {
  const item = record(message);
  if (item?.customType === "subagent_supervisor_reply") {
    const data = record(item.data);
    if (item.type !== "custom" || !data
      || typeof data.requestId !== "string" || typeof data.runId !== "string"
      || typeof data.agent !== "string" || typeof data.message !== "string"
      || typeof data.childIndex !== "number" || !Number.isFinite(data.childIndex)
      || typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)
      || (data.reason !== undefined && (typeof data.reason !== "string" || !["need_decision", "interview_request", "progress_update"].includes(data.reason)))
      || (data.childTarget !== undefined && typeof data.childTarget !== "string")) return;
    return {
      key: data.runId && Number.isInteger(data.childIndex) && data.childIndex >= 0
        && !data.nestedRunId && !data.nestingPath ? JSON.stringify([data.runId, data.childIndex]) : undefined,
      runId: data.runId || undefined,
      agent: data.agent,
      internal: true,
      alert: false,
      state: "内部协作",
      color: "muted" as const,
      summary: "代理间沟通已收纳",
      body: stripVTControlCharacters(data.message).trim(),
    };
  }
  if (item?.type === "custom") return;
  if (item?.customType === "subagent-incremental-child-notify") {
    const content = typeof item.content === "string" ? item.content : undefined;
    const header = content?.match(/^Workflow child (completed|failed):\s+\*\*([^*\n]+)\*\*\s*$/m);
    if (!content || !header) return;
    const failed = header[1] === "failed";
    const error = content.match(/^Error:\s*([\s\S]*?)(?=^Status:|(?![\s\S]))/m)?.[1]
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !/^Run fan-out:/i.test(line))
      .join(" ");
    const workflowRunId = content.match(/^Workflow run:\s*([0-9a-f-]{36})\s*$/mi)?.[1];
    const childRunId = content.match(/^Child run:\s*([0-9a-f-]{36})\s*$/mi)?.[1];
    const runIds = [...new Set([childRunId, workflowRunId].filter((id): id is string => !!id))];
    return {
      key: childRunId ? JSON.stringify(["incremental-child", childRunId])
        : workflowRunId ? JSON.stringify(["incremental-child", workflowRunId, header[2]]) : undefined,
      runId: childRunId || workflowRunId,
      runIds,
      internal: false,
      alert: failed,
      state: failed ? "执行失败" : "已完成",
      color: failed ? "error" as const : "muted" as const,
      summary: error || (failed ? "子任务失败" : "子任务已完成"),
      label: clean(header[2]),
      showLabel: true,
      body: content,
    };
  }
  if (item?.customType === "subagent-notify") {
    const content = typeof item.content === "string" ? item.content : undefined;
    const header = content?.match(/^(?:Background task|Detached foreground task) (completed|failed|paused|stopped):\s+\*\*([^\*\n]+)\*\*/m);
    if (!content || !header) return;
    const status = header[1];
    const failed = status === "failed" || status === "stopped"
      || /^- key=\S+ run=[0-9a-f-]{36} status=failed\s*$/mi.test(content)
      || /^Child runs:.*\(failed\)/mi.test(content);
    const attention = status === "paused";
    const workflowRunId = content.match(/^Workflow run:\s*([0-9a-f-]{36})\s*$/mi)?.[1]
      ?? content.match(/^Workflow receipt:\s*.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/mi)?.[1];
    const childRunIds = content.match(/^Child runs:\s*(.+)$/mi)?.[1]
      ?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    const directoryRunId = content.match(/^Retention-managed async directory:[ \t]*(?:\r?\n)?[^\r\n]*\/async-subagent-runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?[ \t]*\r?$/mi)?.[1];
    const runIds = [...new Set([workflowRunId, directoryRunId, ...childRunIds].filter((id): id is string => !!id))];
    const runId = workflowRunId || directoryRunId || childRunIds[0];
    const metadata = /^(?:Workflow (?:receipt|run):|Child runs:|Session(?: file| share error)?:|Retention-managed|Reconciled detached|Parallel handoff:|Watchdog blockers:)/i;
    let preview = "";
    for (const line of content.split("\n").slice(1)) {
      const text = line.trim();
      if (!text || text === `${header[2]}:` || text.startsWith("Workflow receipt:")) continue;
      if (metadata.test(text)) break;
      preview = text;
      break;
    }
    return {
      key: runId ? JSON.stringify(["subagent-notify", runId]) : undefined,
      runId,
      runIds,
      internal: false,
      alert: failed || attention,
      state: failed ? "执行失败" : attention ? "需要关注" : "已完成",
      color: failed ? "error" as const : attention ? "warning" as const : "muted" as const,
      summary: failed && status === "completed" ? "工作流包含失败子任务"
        : clean(preview) || (failed ? "子任务失败" : attention ? "等待回复" : "子任务已完成"),
      label: clean(header[2]),
      showLabel: true,
      body: content,
    };
  }
  const details = record(item?.details);
  if (!details) return;
  const event = record(details.event);
  const request = item?.customType === "subagent_supervisor_request";
  if (request ? !["progress_update", "need_decision", "interview_request"].includes(String(details.reason))
    : item?.customType !== "subagent_control_notice" || !event || !["needs_attention", "active_long_running"].includes(String(event.type))) return;
  const data = request ? details : event!;
  const body = request
    ? (typeof details.requestBody === "string" ? details.requestBody : "")
    : data.message;
  if (typeof body !== "string" || typeof data.agent !== "string") return;
  const ask = request && (details.reason === "need_decision" || details.reason === "interview_request");
  // Replies and duplicate "waiting for supervisor" control notices stay compact.
  // Blocking asks are the main-session prompt; progress remains a status line.
  const internal = request
    ? (!ask && (details.reason !== "progress_update" || details.expectsReply === true))
    : data.reason === "supervisor_request";
  const failed = !request && ["completion_guard", "tool_failures"].includes(String(data.reason));
  const attention = ask || (!request && data.type === "needs_attention" && !internal);
  const question = clean(body).replace(/^UPDATE:\s*/i, "");
  const interviewTitle = typeof record(details.interview)?.title === "string" ? clean(String(record(details.interview)!.title)) : "";
  const index = request ? data.childIndex : data.index;
  const runId = typeof data.runId === "string" && data.runId ? data.runId : undefined;
  // ponytail: aggregate only unambiguous run+child envelopes; nested/missing
  // addresses stay separate until the producer provides a shared child identity.
  const key = runId && Number.isInteger(index) && Number(index) >= 0
    && !data.nestedRunId && !data.nestingPath ? JSON.stringify([runId, index]) : undefined;
  return { key, runId, internal, alert: failed || attention,
    state: failed ? "执行失败" : ask ? (details.reason === "interview_request" ? "需要提问" : "需要裁决")
      : attention ? "需要关注" : internal ? "内部协作" : "进度",
    color: failed ? "error" as const : attention ? "warning" as const : "muted" as const,
    summary: internal ? "代理间沟通已收纳" : question || (ask ? interviewTitle || "等待回复" : "暂无摘要"),
    label: typeof data.label === "string" ? clean(data.label) : typeof data.taskPreview === "string" ? clean(data.taskPreview) : undefined,
    body: question,
    agent: typeof data.agent === "string" ? data.agent : undefined,
  };
}

/** Progress is a status preview, not detail prose; decisions and failures remain inspectable. */
export function supervisorNoticeBody(message: unknown): string {
  const item = record(message);
  if (item?.customType === "subagent_supervisor_request" && record(item.details)?.reason === "progress_update") return "";
  const notice = supervisorNotice(message);
  if (item?.type === "custom" && item.customType === "subagent_supervisor_reply") return notice?.body ?? "";
  return notice?.alert || notice?.internal ? extractNoticeBody(message) : "";
}

/** Pi writes one warning line per miss (`Cache miss…: N tokens re-billed`). */
export function cacheMissLine(text: string): { label: string; tokens: number } | undefined {
  const plain = stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
  const match = plain.match(/^(Cache miss\b.*?):\s*([\d,.]+)\s*([kKmM])?\s*tokens re-billed\b/);
  if (!match) return;
  const scale = match[3]?.toLowerCase() === "m" ? 1_000_000 : match[3]?.toLowerCase() === "k" ? 1_000 : 1;
  const tokens = Math.round(Number(match[2].replace(/,/g, "")) * scale);
  return Number.isFinite(tokens) ? { label: match[1], tokens } : undefined;
}

export function formatCacheTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
