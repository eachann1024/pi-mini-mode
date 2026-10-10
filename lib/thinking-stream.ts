import { ensureThinkingClock, freezeOpenThinkingClocks, freezeThinkingClock, thinkingText, type MinimalTurn, type ThinkingOutcome } from "./minimal-turns.ts";

type ThinkingEvent = { type: string; contentIndex?: number; content?: string; partial?: { timestamp?: number } };

/** One assistant message owns its block indices; ended blocks can never become active again. */
export function createThinkingStream() {
  const indices = new Map<number, number>();
  const ended = new Set<number>();
  let owner: MinimalTurn | undefined;
  let closed = true;
  let messageTimestamp: number | undefined;
  let finalized = false;
  const matchesMessage = (timestamp?: number) => messageTimestamp === undefined || timestamp === undefined || timestamp === messageTimestamp;
  const write = (turn: MinimalTurn, content: Array<Record<string, unknown>>, event?: ThinkingEvent) => {
    for (const [block, item] of content.entries()) {
      if (item?.type !== "thinking") continue;
      const terminal = event?.type === "thinking_end" && event.contentIndex === block ? thinkingText({ thinking: event.content }) : "";
      const body = terminal || thinkingText(item);
      let index = indices.get(block);
      if (index === undefined) {
        index = turn.process.length;
        indices.set(block, index);
        turn.process.push(`thinking ${body}`);
        if (event) ensureThinkingClock(turn, index);
      } else if (body) turn.process[index] = `thinking ${body}`;
      // A terminal empty snapshot must not erase already streamed, readable text.
    }
  };
  return {
    reset() { indices.clear(); ended.clear(); owner = undefined; closed = true; messageTimestamp = undefined; finalized = false; },
    start(turn: MinimalTurn, timestamp?: number) {
      freezeOpenThinkingClocks(owner);
      indices.clear(); ended.clear(); owner = turn; closed = false;
      messageTimestamp = timestamp; finalized = false;
      turn.thinking = undefined;
    },
    update(turn: MinimalTurn, content: Array<Record<string, unknown>>, event: ThinkingEvent) {
      if (closed || turn !== owner || !matchesMessage(event.partial?.timestamp)) return false;
      if ((event.type === "thinking_start" || event.type === "thinking_delta") && event.contentIndex !== undefined && ended.has(event.contentIndex)) return false;
      write(turn, content, event);
      if (event.type === "thinking_end" && event.contentIndex !== undefined) ended.add(event.contentIndex);
      const last = content.length - 1;
      for (const block of indices.keys()) if (block < last) ended.add(block);
      if (/^(text|toolcall)_/.test(event.type) && event.contentIndex !== undefined && event.contentIndex >= last) ended.add(last);
      turn.thinking = content[last]?.type === "thinking" && !ended.has(last) ? indices.get(last) : undefined;
      for (const [block, index] of indices) if (ended.has(block)) freezeThinkingClock(turn, index);
      return true;
    },
    finish(turn: MinimalTurn, content: Array<Record<string, unknown>>, outcome: ThinkingOutcome = "done", timestamp?: number) {
      if (turn !== owner || finalized || !matchesMessage(timestamp)) return false;
      const active = turn.thinking;
      write(turn, content);
      freezeOpenThinkingClocks(turn, Date.now(), outcome);
      // A failed terminal frame can omit the partial content altogether.
      const failed = active ?? (content.length === 0 || content.at(-1)?.type === "thinking" ? [...indices.values()].at(-1) : undefined);
      if (outcome !== "done" && failed !== undefined) (turn.thinkingOutcomes ??= [])[failed] = outcome;
      turn.thinking = undefined;
      turn.awaitingResponse = false;
      closed = true; finalized = true;
      return true;
    },
    stop(turn: MinimalTurn | undefined, outcome: ThinkingOutcome = "done") {
      if (turn) {
        freezeOpenThinkingClocks(turn, Date.now(), outcome);
        turn.thinking = undefined;
        turn.awaitingResponse = false;
      }
      if (turn === owner) closed = true;
    },
  };
}
