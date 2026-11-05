import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { childSessionData, plain } from "./agent-state.ts";
import type { AgentCall } from "./agent-render.ts";

export interface PrintInvocation {
  prompt: string;
  model?: string;
  provider?: string;
  thinking?: string;
  sessionId?: string;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

const VALUE_FLAGS = new Set([
  "--mode", "--provider", "--model", "-m", "--api-key", "--system-prompt", "--append-system-prompt",
  "--name", "-n", "--session", "--session-id", "--fork", "--session-dir", "--models",
  "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e",
  "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode", "--cwd", "-C",
]);

const BOOLEAN_FLAGS = new Set([
  "--continue", "-c", "--resume", "-r", "--no-session", "--no-tools", "-nt", "--no-builtin-tools", "-nbt",
  "--no-extensions", "-ne", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes",
  "--no-context-files", "-nc", "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline",
]);

const REJECT_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const SUBCOMMANDS = new Set(["install", "remove", "update", "list", "auth", "config", "client", "server", "help"]);
const PIPE_FILTERS = new Set(["cat", "head", "tail", "tee", "grep", "rg", "sed", "awk", "jq", "wc", "cut", "tr", "sort"]);

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function unescapeAnsiC(raw: string): string {
  return raw.replace(/\\([abefnrtv\\'"]|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3})/g, (_, seq: string) => {
    switch (seq) {
      case "a": return "\x07";
      case "b": return "\b";
      case "e": return "\x1b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "v": return "\v";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      default:
        if (seq.startsWith("x") || seq.startsWith("u")) return String.fromCodePoint(parseInt(seq.slice(1), 16));
        return String.fromCodePoint(parseInt(seq, 8));
    }
  });
}

interface RawSegment {
  text: string;
  opBefore: string;
  heredocs: string[];
}

function splitShellSegments(command: string): RawSegment[] {
  const lines = command.split(/\r?\n/);
  const logicalLines: Array<{ text: string; heredocs: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.endsWith("\\") && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i];
    }
    const heredocs: string[] = [];
    // Detect unquoted <<EOF, <<'EOF', <<"EOF", <<-EOF on this line (excluding <<<).
    const matcher = /(?:^|[^<])<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(line)) !== null) {
      const stripTabs = match[1] === "-";
      const delim = match[2] ?? match[3] ?? match[4];
      const bodyLines: string[] = [];
      while (i + 1 < lines.length) {
        const nextLine = lines[++i];
        const check = stripTabs ? nextLine.replace(/^\t+/, "") : nextLine;
        if (check.trim() === delim) break;
        bodyLines.push(stripTabs ? check : nextLine);
      }
      heredocs.push(bodyLines.join("\n"));
    }
    logicalLines.push({ text: line, heredocs });
  }

  const segments: RawSegment[] = [];
  for (const { text: line, heredocs } of logicalLines) {
    let quote: "'" | '"' | "$'" | null = null;
    let start = 0;
    let opBefore = ";";
    let usedHeredocs = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === "$'") {
        if (ch === "\\" && i + 1 < line.length) { i++; continue; }
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === "\\" && i + 1 < line.length) { i++; continue; }
        if (ch === '"') quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < line.length) { i++; continue; }
      if (ch === "$" && line[i + 1] === "'") { quote = "$'"; i++; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#") {
        // Comment to end of line if preceded by whitespace or start
        if (i === start || /\s/.test(line[i - 1])) {
          const piece = line.slice(start, i).trim();
          if (piece) segments.push({ text: piece, opBefore, heredocs: usedHeredocs ? [] : heredocs });
          start = line.length;
          break;
        }
      }
      if (ch === ";") {
        const piece = line.slice(start, i).trim();
        if (piece) {
          segments.push({ text: piece, opBefore, heredocs: usedHeredocs ? [] : heredocs });
          usedHeredocs = true;
        }
        opBefore = ";";
        start = i + 1;
        continue;
      }
      if (ch === "&") {
        if (line[i - 1] === ">" || line[i + 1] === ">") continue;
        const isAnd = line[i + 1] === "&";
        const piece = line.slice(start, i).trim();
        if (piece) {
          segments.push({ text: piece, opBefore, heredocs: usedHeredocs ? [] : heredocs });
          usedHeredocs = true;
        }
        opBefore = isAnd ? "&&" : "&";
        if (isAnd) i++;
        start = i + 1;
        continue;
      }
      if (ch === "|") {
        const isOr = line[i + 1] === "|";
        const piece = line.slice(start, i).trim();
        if (piece) {
          segments.push({ text: piece, opBefore, heredocs: usedHeredocs ? [] : heredocs });
          usedHeredocs = true;
        }
        opBefore = isOr ? "||" : "|";
        if (isOr) i++;
        start = i + 1;
        continue;
      }
    }
    const tail = line.slice(start).trim();
    if (tail) segments.push({ text: tail, opBefore, heredocs: usedHeredocs ? [] : heredocs });
  }
  return segments;
}

function tokenizeSegment(segment: string): { words: string[]; hereStrings: string[]; invalid: boolean } {
  const words: string[] = [];
  const hereStrings: string[] = [];
  let i = 0;
  const n = segment.length;
  const readWord = (): { value: string; ok: boolean } => {
    let value = "";
    while (i < n && !/\s/.test(segment[i])) {
      const ch = segment[i];
      if (ch === "'") {
        const end = segment.indexOf("'", i + 1);
        if (end === -1) return { value, ok: false };
        value += segment.slice(i + 1, end);
        i = end + 1;
      } else if (ch === "$" && segment[i + 1] === "'") {
        i += 2;
        let raw = "";
        let closed = false;
        while (i < n) {
          if (segment[i] === "\\" && i + 1 < n) { raw += segment.slice(i, i + 2); i += 2; continue; }
          if (segment[i] === "'") { closed = true; i++; break; }
          raw += segment[i++];
        }
        if (!closed) return { value, ok: false };
        value += unescapeAnsiC(raw);
      } else if (ch === '"') {
        i++;
        let closed = false;
        while (i < n) {
          if (segment[i] === "\\" && i + 1 < n) {
            const next = segment[i + 1];
            if (next === '"' || next === "\\" || next === "$" || next === "`") { value += next; i += 2; continue; }
            if (next === "\n") { i += 2; continue; }
          }
          if (segment[i] === '"') { closed = true; i++; break; }
          value += segment[i++];
        }
        if (!closed) return { value, ok: false };
      } else if (ch === "\\") {
        if (i + 1 < n) { value += segment[i + 1]; i += 2; }
        else i++;
      } else {
        value += segment[i++];
      }
    }
    return { value, ok: true };
  };

  while (i < n) {
    while (i < n && /\s/.test(segment[i])) i++;
    if (i >= n) break;
    // Strip leading/trailing subshell parens
    if (segment[i] === "(" || segment[i] === ")") { i++; continue; }
    // Handle <<< here-string
    if (segment.startsWith("<<<", i)) {
      i += 3;
      while (i < n && /\s/.test(segment[i])) i++;
      const parsed = readWord();
      if (!parsed.ok) return { words, hereStrings, invalid: true };
      if (parsed.value) hereStrings.push(parsed.value);
      continue;
    }
    // Handle << heredoc marker (body already extracted)
    if (segment.startsWith("<<", i)) {
      i += 2;
      if (segment[i] === "-") i++;
      while (i < n && /\s/.test(segment[i])) i++;
      const parsed = readWord();
      if (!parsed.ok) return { words, hereStrings, invalid: true };
      continue;
    }
    // Handle redirections like 2>&1, >/tmp/out, 2>/dev/null, </dev/null
    const redirMatch = segment.slice(i).match(/^(?:\d*>>?|\d*<&?\d*|&>>?)/);
    if (redirMatch) {
      i += redirMatch[0].length;
      if (!redirMatch[0].includes("&") || redirMatch[0].startsWith("&>")) {
        while (i < n && /\s/.test(segment[i])) i++;
        if (i < n) readWord();
      }
      continue;
    }
    const parsed = readWord();
    if (!parsed.ok) return { words, hereStrings, invalid: true };
    words.push(parsed.value);
  }
  return { words, hereStrings, invalid: false };
}

function isPiBinary(token: string): boolean {
  return token === "pi" || /(?:^|[/\\])pi$/.test(token);
}

const parsePrintCache = new Map<string, PrintInvocation[]>();
const isPrintCallCache = new Map<string, boolean>();
const PRINT_CACHE_MAX = 800;

export function clearPrintAgentCaches(): void {
  parsePrintCache.clear();
  isPrintCallCache.clear();
}

function parsePrintInvocationsUncached(command: string, baseCwd?: string): PrintInvocation[] {
  if (typeof command !== "string" || !command.trim() || !/\bpi\b/.test(command)) return [];
  const rawSegments = splitShellSegments(command);
  if (!rawSegments.length) return [];

  const invocations: PrintInvocation[] = [];
  let currentCwd = baseCwd;
  const globalEnv: Record<string, string> = {};

  for (const [segIndex, seg] of rawSegments.entries()) {
    const { words, hereStrings, invalid } = tokenizeSegment(seg.text);
    if (invalid) return [];
    if (!words.length) continue;

    // Collect leading ENV=VALUE tokens
    const localEnv: Record<string, string> = { ...globalEnv };
    let idx = 0;
    while (idx < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx])) {
      const eq = words[idx].indexOf("=");
      localEnv[words[idx].slice(0, eq)] = words[idx].slice(eq + 1);
      idx++;
    }
    if (idx >= words.length) {
      Object.assign(globalEnv, localEnv);
      continue;
    }

    const head = words[idx];
    if (head === "cd") {
      const target = words[idx + 1];
      if (target) {
        const expanded = expandTilde(target);
        currentCwd = currentCwd ? resolve(currentCwd, expanded) : expanded;
      }
      continue;
    }
    if (head === "export") {
      for (let j = idx + 1; j < words.length; j++) {
        const eq = words[j].indexOf("=");
        if (eq > 0) globalEnv[words[j].slice(0, eq)] = words[j].slice(eq + 1);
      }
      continue;
    }
    if (head === "wait" || head === "true" || head === ":" || head === "echo" && seg.opBefore !== "|") {
      if (head === "wait" || head === "true" || head === ":") continue;
    }
    if (seg.opBefore === "|" && invocations.length > 0 && PIPE_FILTERS.has(head)) {
      continue;
    }

    if (head === "env") {
      idx++;
      while (idx < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx])) {
        const eq = words[idx].indexOf("=");
        localEnv[words[idx].slice(0, eq)] = words[idx].slice(eq + 1);
        idx++;
      }
    }
    if (idx < words.length && (words[idx] === "npx" || words[idx] === "bunx" || words[idx] === "pnpx")) {
      idx++;
      while (idx < words.length && (words[idx] === "-y" || words[idx] === "--yes")) idx++;
      if (idx < words.length && (words[idx] === "pi" || words[idx] === "@earendil-works/pi-coding-agent")) {
        idx++;
      } else {
        return [];
      }
    } else if (idx < words.length && isPiBinary(words[idx])) {
      idx++;
    } else if (rawSegments[segIndex + 1]?.opBefore === "|") {
      // A producer piped into pi (`git diff | pi -p ...`) is the child's input.
      continue;
    } else {
      return [];
    }

    const args = words.slice(idx);
    if (args.length > 0 && SUBCOMMANDS.has(args[0])) return [];

    let isPrint = false;
    let model: string | undefined;
    let provider: string | undefined;
    let thinking: string | undefined;
    let sessionId: string | undefined;
    let session: string | undefined;
    let sessionDir: string | undefined;
    let noSession = false;
    let invCwd = currentCwd;
    const messages: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        for (const pos of args.slice(i + 1)) {
          if (!pos.startsWith("@")) messages.push(pos);
        }
        break;
      }
      if (REJECT_FLAGS.has(arg)) return [];
      if (arg === "-p" || arg === "--print") {
        isPrint = true;
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
          messages.push(next);
          i++;
        }
        continue;
      }
      const eqIdx = arg.startsWith("--") ? arg.indexOf("=") : -1;
      const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
      const inlineVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined;
      const takeVal = (): string | undefined => inlineVal !== undefined ? inlineVal : args[++i];

      if (flag === "--mode") {
        const mode = takeVal();
        if (mode === "json") isPrint = true;
        else if (mode === "rpc") return [];
      } else if (flag === "--model" || flag === "-m") {
        model = takeVal();
      } else if (flag === "--provider") {
        provider = takeVal();
      } else if (flag === "--thinking") {
        thinking = takeVal();
      } else if (flag === "--session-id") {
        sessionId = takeVal();
      } else if (flag === "--session") {
        session = takeVal();
      } else if (flag === "--session-dir") {
        sessionDir = takeVal();
      } else if (flag === "--no-session") {
        noSession = true;
      } else if (flag === "--cwd" || flag === "-C") {
        const dir = takeVal();
        if (dir) invCwd = currentCwd ? resolve(currentCwd, expandTilde(dir)) : expandTilde(dir);
      } else if (VALUE_FLAGS.has(flag)) {
        if (inlineVal === undefined && i + 1 < args.length) i++;
      } else if (BOOLEAN_FLAGS.has(flag)) {
        // boolean flag, no value
      } else if (arg.startsWith("@")) {
        // @file attachment
      } else if (arg.startsWith("--")) {
        if (inlineVal === undefined && i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
          i++;
        }
      } else if (!arg.startsWith("-")) {
        messages.push(arg);
      }
    }

    for (const hs of hereStrings) if (hs.trim()) messages.push(hs);
    for (const hd of seg.heredocs) if (hd.trim()) messages.push(hd);

    const prompt = messages.join("\n").trim();
    if (!isPrint || !prompt) return [];

    invocations.push({
      prompt,
      model,
      provider,
      thinking,
      sessionId,
      session,
      sessionDir,
      noSession: noSession || undefined,
      cwd: invCwd,
      env: Object.keys(localEnv).length ? localEnv : undefined,
    });
  }

  return invocations;
}

export function parsePrintInvocations(command: string, baseCwd?: string): PrintInvocation[] {
  if (typeof command !== "string" || !command.trim() || !/\bpi\b/.test(command)) return [];
  const key = `${baseCwd ?? ""}|${command}`;
  const hit = parsePrintCache.get(key);
  if (hit !== undefined) return hit;
  const result = parsePrintInvocationsUncached(command, baseCwd);
  if (parsePrintCache.size >= PRINT_CACHE_MAX) {
    const first = parsePrintCache.keys().next().value;
    if (first !== undefined) parsePrintCache.delete(first);
  }
  parsePrintCache.set(key, result);
  return result;
}

const singleLine = (value: string) => plain(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();

function readFirstUserMessage(filePath: string): { sessionId?: string; userText?: string; startedAt?: number } {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(65536);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      if (bytes <= 0) return {};
      const chunk = buf.subarray(0, bytes).toString("utf8");
      let sessionId: string | undefined;
      let startedAt: number | undefined;
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            id?: string;
            timestamp?: unknown;
            message?: { role?: string; content?: unknown; timestamp?: unknown };
          };
          if (entry.type === "session") {
            if (typeof entry.id === "string") sessionId = entry.id;
            if (typeof entry.timestamp === "string") {
              const t = Date.parse(entry.timestamp);
              if (Number.isFinite(t)) startedAt = t;
            }
          }
          if (entry.type === "message" && entry.message?.role === "user") {
            const content = entry.message.content;
            const userText = typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((b): b is { type?: string; text?: string } => Boolean(b && typeof b === "object"))
                    .filter(b => b.type === "text" && typeof b.text === "string")
                    .map(b => b.text!)
                    .join("\n")
                : "";
            return { sessionId, userText, startedAt };
          }
        } catch { /* partial line */ }
      }
      return { sessionId, startedAt };
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
}

function promptMatches(userText: string | undefined, prompt: string): boolean {
  if (!userText) return false;
  const trimmedUser = userText.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedUser || !trimmedPrompt) return false;
  const rawPrefixLen = Math.min(trimmedPrompt.length, 64);
  if (trimmedUser.startsWith(trimmedPrompt.slice(0, rawPrefixLen))) return true;
  const normUser = singleLine(trimmedUser);
  const normPrompt = singleLine(trimmedPrompt);
  if (!normUser || !normPrompt) return false;
  const prefixLen = Math.min(normPrompt.length, 64);
  return normUser.startsWith(normPrompt.slice(0, prefixLen)) || normPrompt.startsWith(normUser.slice(0, Math.min(normUser.length, 64)));
}

const locatedBySegment = new Map<string, string>();
const lastScanBySegment = new Map<string, { at: number; terminalScanned: boolean }>();

export function defaultSessionDirForCwd(cwd: string, env?: Record<string, string>): string {
  const resolvedCwd = resolve(expandTilde(cwd));
  const agentEnv = env?.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  const agentDir = agentEnv ? resolve(expandTilde(agentEnv)) : join(homedir(), ".pi", "agent");
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

export function locatePrintSession(
  inv: PrintInvocation,
  cwd = process.cwd(),
  startedAt?: number,
  claimed?: Set<string>,
  cacheKey?: string,
  terminal = false,
): string | undefined {
  if (inv.noSession) return undefined;
  if (cacheKey) {
    const cached = locatedBySegment.get(cacheKey);
    if (cached) {
      claimed?.add(cached);
      return cached;
    }
    const scanState = lastScanBySegment.get(cacheKey);
    const now = Date.now();
    if (scanState) {
      if (scanState.terminalScanned) return undefined;
      if (!terminal && now - scanState.at < 1000) return undefined;
    }
    lastScanBySegment.set(cacheKey, { at: now, terminalScanned: terminal });
  }

  const baseCwd = cwd || process.cwd();
  const effectiveCwd = inv.cwd ? resolve(baseCwd, expandTilde(inv.cwd)) : resolve(baseCwd);

  if (inv.session) {
    const explicitPath = resolve(effectiveCwd, expandTilde(inv.session));
    if (existsSync(explicitPath) && explicitPath.endsWith(".jsonl") && !claimed?.has(explicitPath)) {
      claimed?.add(explicitPath);
      if (cacheKey) locatedBySegment.set(cacheKey, explicitPath);
      return explicitPath;
    }
  }

  const envSessionDir = inv.env?.PI_CODING_AGENT_SESSION_DIR || process.env.PI_CODING_AGENT_SESSION_DIR;
  const sessionDir = inv.sessionDir
    ? resolve(effectiveCwd, expandTilde(inv.sessionDir))
    : envSessionDir
      ? resolve(effectiveCwd, expandTilde(envSessionDir))
      : defaultSessionDirForCwd(effectiveCwd, inv.env);

  try {
    const names = readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"));
    const targetId = inv.sessionId || (inv.session && !inv.session.endsWith(".jsonl") ? inv.session : undefined);
    if (targetId) {
      for (const name of names) {
        if (name === `${targetId}.jsonl` || name.endsWith(`_${targetId}.jsonl`)) {
          const full = join(sessionDir, name);
          if (claimed?.has(full)) continue;
          claimed?.add(full);
          if (cacheKey) locatedBySegment.set(cacheKey, full);
          return full;
        }
      }
      for (const name of names) {
        const full = join(sessionDir, name);
        if (claimed?.has(full)) continue;
        const info = readFirstUserMessage(full);
        if (info.sessionId === targetId) {
          claimed?.add(full);
          if (cacheKey) locatedBySegment.set(cacheKey, full);
          return full;
        }
      }
      return undefined;
    }

    const hasStart = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0;
    const candidates: Array<{ full: string; mtimeMs: number; birthtimeMs: number }> = [];
    for (const name of names) {
      const full = join(sessionDir, name);
      if (claimed?.has(full)) continue;
      try {
        const st = statSync(full);
        if (hasStart && st.mtimeMs < startedAt - 3000) continue;
        candidates.push({ full, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || st.mtimeMs });
      } catch { /* ignore */ }
    }
    candidates.sort((a, b) => hasStart
      ? Math.abs(a.birthtimeMs - startedAt) - Math.abs(b.birthtimeMs - startedAt)
      : b.mtimeMs - a.mtimeMs);

    for (const cand of candidates) {
      const info = readFirstUserMessage(cand.full);
      if (hasStart && info.startedAt !== undefined && info.startedAt < startedAt - 3000) continue;
      if (promptMatches(info.userText, inv.prompt)) {
        claimed?.add(cand.full);
        if (cacheKey) locatedBySegment.set(cacheKey, cand.full);
        return cand.full;
      }
    }
  } catch { /* directory missing or unreadable */ }
  return undefined;
}

export function isPrintAgentCall(call: Pick<AgentCall, "name" | "tool" | "task"> & { command?: string }): boolean {
  const toolName = call.tool ?? call.name;
  if (toolName !== "bash") return false;
  const cmd = typeof call.command === "string" ? call.command : call.task;
  if (typeof cmd !== "string" || !cmd) return false;
  const hit = isPrintCallCache.get(cmd);
  if (hit !== undefined) return hit;
  const result = parsePrintInvocations(cmd).length > 0;
  if (isPrintCallCache.size >= PRINT_CACHE_MAX) {
    const first = isPrintCallCache.keys().next().value;
    if (first !== undefined) isPrintCallCache.delete(first);
  }
  isPrintCallCache.set(cmd, result);
  return result;
}

const GENERIC_CALL_OUTPUT = /^(?:Call (?:returned|failed) \([^)]*\)|Tool (?:completed|failed) \([^)]*\))$/;

export function printAgentStatuses(
  call: AgentCall & { command?: string },
  cwd = process.cwd(),
  claimed?: Set<string>,
): Record<string, unknown>[] {
  const toolName = call.tool ?? call.name;
  if (toolName !== "bash") return [];
  const cmd = typeof call.command === "string" ? call.command : call.task;
  const invocations = parsePrintInvocations(cmd, cwd);
  if (!invocations.length) return [];

  const terminal = call.state !== "running";
  return invocations.map((inv, index) => {
    const runId = `${call.id}#${index}`;
    const sessionFile = locatePrintSession(inv, cwd, call.startedAt, claimed, runId, terminal);
    const session = childSessionData(sessionFile);
    const cliModel = inv.model
      ? (inv.provider && !inv.model.startsWith(`${inv.provider}/`) ? `${inv.provider}/${inv.model}` : inv.model)
      : undefined;
    const model = session?.model || cliModel;
    const thinking = session?.thinking || inv.thinking;
    const state = call.state === "error"
      ? (invocations.length > 1 && session?.terminalState === "complete" ? "complete" : "failed")
      : call.state === "running"
        ? (session?.terminalState ?? "running")
        : (session?.terminalState === "failed" ? "failed" : "complete");
    const childTerminal = state !== "running";
    const startedAt = session?.startedAt ?? call.startedAt;
    const endedAt = childTerminal
      ? (invocations.length > 1 || call.state === "running"
          ? session?.endedAt ?? call.endedAt
          : call.endedAt ?? session?.endedAt)
      : undefined;
    const rawOutput = call.output && !GENERIC_CALL_OUTPUT.test(call.output.trim()) ? call.output : undefined;
    const finalOutput = session?.finalOutput || session?.latestText || (childTerminal && invocations.length === 1 ? rawOutput : undefined);
    const error = state === "failed" ? (rawOutput || call.output || "Command failed") : undefined;
    const recentTools = session?.steps.map(step => ({
      tool: step.name,
      args: step.value,
      endMs: step.at,
    })) ?? [];
    return {
      runId,
      mode: "single",
      agent: "pi -p",
      source: "pi -p",
      task: inv.prompt,
      description: inv.prompt,
      model,
      thinking,
      sessionFile,
      startedAt,
      endedAt,
      state,
      status: state,
      finalOutput,
      error,
      recentTools,
      toolCallId: call.id,
    };
  });
}
