import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../lib/settings.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, "settings page ships an inline script");

function extract(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " is defined in the settings page");
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name + " has unbalanced braces");
}

const constants = source.match(/const previewFade=\d+,previewFadeReduced=\d+;/)?.[0];
assert.ok(constants, "preview fade durations are named constants");
const [, fade, reduced] = constants.match(/const previewFade=(\d+),previewFadeReduced=(\d+);/);
assert.match(html, new RegExp("#preview button\\.preview-exit\\{opacity:0;pointer-events:none;transition:opacity " + fade + "ms ease-in;position:absolute\\}"), "the exit fade duration matches its timer");
assert.match(html, new RegExp("@media\\(prefers-reduced-motion:reduce\\)\\{#preview button\\.preview-exit\\{transition-duration:" + reduced + "ms\\}\\}"), "reduced motion shortens the same fade");

const timers = [];
const panels = {};
let reducedMotion = false;
const sandbox = {
  setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  matchMedia: () => ({ matches: reducedMotion }),
  $: (id) => panels[id],
  t: () => "empty preview",
};
vm.createContext(sandbox);
vm.runInContext(constants + "\n" + extract("syncPreviewEmpty") + "\n" + extract("exitPreview"), sandbox);

const panel = () => {
  const current = { children: [], textContent: "" };
  panels.preview = current;
  return current;
};
const button = (field, owner) => {
  const classes = new Set();
  const el = {
    dataset: { field }, removed: false, attributes: {}, style: {}, offsetLeft: 0, offsetTop: 0, disabled: false, draggable: true, tabIndex: 0,
    classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.removed = true; const index = owner.children.indexOf(this); if (index >= 0) owner.children.splice(index, 1); },
  };
  owner.children.push(el);
  return el;
};

const first = panel();
const hidden = button("mcp", first);
sandbox.exitPreview(hidden);
sandbox.exitPreview(hidden);
assert.equal(timers.length, 1, "repeated exits share one timer");
assert.equal(hidden.classList.contains("preview-exit"), true);
assert.equal(hidden.attributes["aria-hidden"], "true");
assert.equal(hidden.disabled, true, "an exiting field stops accepting clicks");
assert.equal(hidden.draggable, false, "an exiting field stops dragging");
assert.equal(hidden.tabIndex, -1, "an exiting field leaves the tab order");
assert.equal(timers[0].delay, Number(fade) + 60, "the timer waits for the fade plus one frame gap");
timers[0].callback();
assert.equal(hidden.removed, true);
assert.equal(first.textContent, "empty preview", "the empty placeholder returns once the last field is gone");

timers.length = 0;
const second = panel();
const stale = button("mcp", second);
sandbox.exitPreview(stale);
const fresh = button("mcp", second);
timers[0].callback();
assert.equal(stale.removed, true);
assert.equal(fresh.removed, false, "a stale fade never removes the button that replaced it");
assert.equal(second.textContent, "", "a live button keeps the empty placeholder away");

timers.length = 0;
reducedMotion = true;
const third = panel();
const soft = button("mcp", third);
sandbox.exitPreview(soft);
assert.equal(soft.removed, false, "reduced motion still fades instead of removing immediately");
assert.equal(timers[0].delay, Number(reduced) + 60, "reduced motion uses the shorter fade");
timers[0].callback();
assert.equal(soft.removed, true);

// A completion notice must follow the write, including when edits arrive mid-save.
const notices = [];
const writes = [];
const saveContext = vm.createContext({
  $: () => ({ hidden: false }),
  structuredClone,
  t: id => id,
  status: (...args) => notices.push(args),
  request: () => new Promise((resolve, reject) => writes.push({ resolve, reject })),
});
vm.runInContext('let saving=false,dirty=true,state={};\nasync ' + extract("save"), saveContext);
const pendingSave = vm.runInContext('save()', saveContext);
assert.equal(notices.some(([text]) => text === 'saved'), false);
vm.runInContext('dirty=true', saveContext);
writes[0].resolve({});
await new Promise(resolve => setImmediate(resolve));
assert.equal(writes.length, 2, 'edits during a write are also saved');
assert.equal(notices.some(([text]) => text === 'saved'), false);
writes[1].resolve({});
await pendingSave;
assert.equal(notices.at(-1)[0], 'saved');
vm.runInContext('dirty=true', saveContext);
const failedSave = vm.runInContext('save()', saveContext);
writes[2].reject(new Error('disk failure'));
await failedSave;
assert.equal(notices.at(-1)[1], true, 'a failed write displays an error, not completion');
assert.equal(vm.runInContext('dirty', saveContext), true, 'failed edits remain available to retry');

console.log("settings preview self-check ok");
