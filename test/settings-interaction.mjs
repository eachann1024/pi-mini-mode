import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerHooks } from "node:module";
import { setTimeout } from "node:timers/promises";

// Keep real TUI components, but avoid loading the unrelated Pi server runtime.
const piStub = `data:text/javascript,${encodeURIComponent(`
export const CONFIG_DIR_NAME = ".pi";
export const getAgentDir = () => ".pi";
export const getMarkdownTheme = () => Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(key => [key, text => text]));
export const getSettingsListTheme = () => ({
  hint: (text) => text, description: (text) => text,
});
export const SettingsManager = { create: () => ({
  drainErrors: () => [], getProjectSettings: () => ({}), setTheme() {}, setTuiMode() {},
  async flush() {},
}) };
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { shortCircuit: true, url: piStub };
    return nextResolve(specifier, context);
  },
});
const { default: extension, loadSettings, settingsPath, settingsPreviewLine, DEFAULT_SETTINGS, FOOTER_FIELDS } = await import("../extensions/footer-status.ts");

const dir = await mkdtemp(join(tmpdir(), "pi-mini-mode-pointer-"));
process.env.PI_MINI_MODE_AGENT_DIR = dir;
process.env.LANG = "en_US.UTF-8";
const commands = new Map();
const handlers = new Map();
let openedUrl = "";
extension({
  events: { on() { return () => {}; } },
  on(name, handler) { handlers.set(name, handler); },
  registerCommand(name, command) { commands.set(name, command); },
  registerEntryRenderer() {},
  appendEntry() {},
  exec: async (_command, args) => { openedUrl = args[0]; return { code: 0 }; },
});
const notices = [];
const theme = {
  bg(color, text) { assert.equal(color, "selectedBg"); return `\x1b[47m${text}\x1b[49m`; },
  fg(color, text) { return color === "accent" ? `\x1b[32m${text}\x1b[39m` : text; },
  bold(text) { return `\x1b[1m${text}\x1b[22m`; },
};
const ctx = {
  mode: "tui",
  ui: {
    setWidget() {},
    notify(message, level) { notices.push({ message, level }); },
  },
};
await commands.get("pi-mini-mode-settings").handler("", ctx);
assert.match(openedUrl, /^https?:\/\//, "settings command opens the local HTML page");
const settingsUrl = new URL(openedUrl);
const settingsHeaders = { Authorization: `Bearer ${settingsUrl.hash.slice(1)}`, "Content-Type": "application/json" };
const settingsEndpoint = `${settingsUrl.origin}/settings`;
assert.equal((await fetch(settingsUrl.origin)).status, 200, "settings entry serves the local page");
const served = await (await fetch(settingsEndpoint, { headers: settingsHeaders })).json();
assert.deepEqual(served.order, FOOTER_FIELDS, "settings page serves the footer field order");
assert.ok("tuiMode" in served, "settings page serves the TUI mode for the fullscreen notice");
const items = new Map(served.items.map((item) => [item.id, item]));
assert.equal(items.get("pi-mini-mode-model-show")?.label, "显示模型");
assert.equal(items.get("pi-mini-mode-minimal-show")?.currentValue, "on", "极简输出默认打开");
assert.equal(items.get("pi-mini-mode-input-enhancements")?.currentValue, "on", "输入增强默认打开");
assert.ok([...items.values()].every((item) => !/显示工具调用|显示过程输出|显示技能|Agent token 用量|Ctrl\+O 提示/.test(item.label ?? "")), "极简输出的旧细项不再展示");
assert.equal(items.get("pi-mini-mode-mcp-show")?.currentValue, "off", "MCP toggle defaults to off");

const enabled = { ...served.settings, "pi-mini-mode-mcp-show": true };
assert.equal((await fetch(settingsEndpoint, { method: "PUT", headers: settingsHeaders, body: JSON.stringify(enabled) })).status, 200, "settings page saves accepted changes");

for (const width of [140, 80, 40, 20]) {
  const preview = settingsPreviewLine(theme, { ...DEFAULT_SETTINGS, "pi-mini-mode-mcp-show": true }, width, "pi-mini-mode-mcp-show");
  assert.ok(visibleWidth(preview) <= width, `MCP settings stay within ${width} columns`);
}
for (let width = 0; width <= 140; width++) {
  const preview = settingsPreviewLine(theme, { ...DEFAULT_SETTINGS, "pi-mini-mode-mcp-show": true }, width, "pi-mini-mode-mcp-show");
  assert.ok(visibleWidth(preview) <= width, `ANSI-styled MCP preview respects ${width} columns`);
}
for (let attempt = 0; attempt < 100; attempt++) {
  if ((await loadSettings(settingsPath(dir))).settings["pi-mini-mode-mcp-show"]) break;
  await setTimeout(10);
}
assert.equal((await loadSettings(settingsPath(dir))).settings["pi-mini-mode-mcp-show"], true, "real settings toggle persists");
assert.equal(notices.filter((notice) => notice.level === "warning").length, 0, "toggling settings does not warn");
handlers.get("session_shutdown")?.({}, ctx);
await rm(dir, { recursive: true, force: true });
delete process.env.PI_MINI_MODE_AGENT_DIR;
console.log("settings interaction check ok");
