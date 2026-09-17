import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import attachFooterTidy, { hideStatus } from "../lib/footer-tidy.ts";

assert.equal(hideStatus("pi-lens-lsp", "ready"), true);
assert.equal(hideStatus("sandbox", "unrestricted"), true);
assert.equal(hideStatus("plannotator", "⏸ plan"), false);

const starts = [];
const footerCalls = [];
const statuses = [];
attachFooterTidy({
  on(event, handler) {
    if (event === "session_start") starts.push(handler);
  },
});
assert.equal(starts.length, 1, "footer-tidy registers one session_start handler");

const ctx = {
  ui: {
    setStatus(key, text) { statuses.push([key, text]); },
    setFooter(factory) { footerCalls.push(factory); },
  },
};
starts[0]({}, ctx);
ctx.ui.setStatus("plannotator", "⏸ plan");
ctx.ui.setStatus("pi-lens-lsp", "connected");
ctx.ui.setStatus("notes", " · write path · ");

await setTimeout(0);
assert.deepEqual(footerCalls, [], "footer-tidy must not steal or restore setFooter");
assert.ok(statuses.some(([key, text]) => key === "plannotator" && text === "⏸ plan"));
assert.ok(statuses.some(([key, text]) => key === "pi-lens-lsp" && text === undefined));
assert.ok(statuses.some(([key, text]) => key === "notes" && text === undefined));

const compact = () => ({ render: () => ["compact"] });
ctx.ui.setFooter(compact);
await setTimeout(0);
assert.equal(footerCalls.at(-1), compact, "a later compact footer stays installed");
assert.equal(footerCalls.includes(undefined), false, "built-in footer is never restored");

console.log("footer-tidy check ok");
