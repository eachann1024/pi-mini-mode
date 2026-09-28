import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The same suite can check an installed host without importing a second Pi module instance.
const agentEntry = process.env.PI_MINI_MODE_TEST_AGENT_ENTRY
  ? pathToFileURL(process.env.PI_MINI_MODE_TEST_AGENT_ENTRY).href
  : import.meta.resolve('@earendil-works/pi-coding-agent');
const { createJiti } = await import(pathToFileURL(createRequire(agentEntry).resolve('jiti')).href);
const { loadExtensions } = await import(new URL('./core/extensions/loader.js', agentEntry));
const { SettingsManager } = await import(agentEntry);
const tuiEntry = new URL('../node_modules/@earendil-works/pi-tui/dist/index.js', agentEntry).href;
// npm may hoist pi-tui beside pi-coding-agent rather than nesting it inside the package.
const hostTuiEntry = process.env.PI_MINI_MODE_TEST_AGENT_ENTRY ? tuiEntry : import.meta.resolve('@earendil-works/pi-tui');
const tuiApi = await import(hostTuiEntry);
const { getCapabilities, setCapabilityOverrides, resetCapabilitiesCache, setCellDimensions, getCellDimensions,
  TuiAltScreen, TuiMainScreen, renderImage, getImageDimensions, Box } = tuiApi;
const jiti = createJiti(new URL('./core/extensions/loader.js', agentEntry).href, {
  moduleCache: false, fsCache: false,
  alias: { '@earendil-works/pi-coding-agent': fileURLToPath(agentEntry), '@earendil-works/pi-tui': fileURLToPath(hostTuiEntry) },
});
const bridgePath = new URL('../lib/terminal-capabilities.ts', import.meta.url).pathname;
const { installTerminalCapabilities } = await jiti.import(bridgePath);
const { inlinePreviewLines, previewLines } = await jiti.import(new URL('../lib/input-enhancements.ts', import.meta.url).pathname);
const envKeys = ['TERM', 'TERM_PROGRAM', 'TERMINAL_EMULATOR', 'COLORTERM', 'TMUX', 'STY', 'SSH_CONNECTION',
  'HERDR_PANE_ID', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'WARP_SESSION_ID', 'WARP_TERMINAL_SESSION_UUID',
  'ITERM_SESSION_ID', 'WT_SESSION', 'PI_IMAGE_PROTOCOL', 'PI_HYPERLINKS', 'PI_TRUE_COLOR'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const original = SettingsManager.prototype.getTerminalCapabilityOverrides;
const cells = getCellDimensions();
const dir = await mkdtemp(join(tmpdir(), 'pi-terminal-capabilities-'));
const owned = [];
function environment(overrides = {}) {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, { TERM: 'xterm-256color', TERM_PROGRAM: 'otty' }, overrides);
  setCapabilityOverrides({});
  resetCapabilitiesCache();
}
function install() {
  const cleanup = installTerminalCapabilities();
  owned.push(cleanup);
  return cleanup;
}
function apply(manager) {
  setCapabilityOverrides(manager.getTerminalCapabilityOverrides());
  resetCapabilitiesCache();
  return getCapabilities();
}
async function shutdown(extension, reason = 'quit') {
  for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason }, {});
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=';
const imagePath = join(dir, 'image.png');
const theme = { fg: (_key, text) => text };
function previewState() {
  return { editor: { getText: () => imagePath }, enabled: () => true, previewMode: () => 'inline',
    inlineImages: new Map([[imagePath, { kind: 'image', path: imagePath, mimeType: 'image/png', base64: png, widthPx: 1, heightPx: 1 }]]),
    inlinePending: new Map(), inlineGraphics: new Map() };
}
function renderPreviews(Tui = TuiAltScreen) {
  let output = '';
  const terminal = { columns: 80, rows: 24, start() {}, stop() {}, hideCursor() {}, showCursor() {}, write: s => { output += s; } };
  const ui = new Tui(terminal);
  const state = { ...previewState(), tui: ui };
  const cards = new Box(1, 1);
  cards.addChild({ render: width => inlinePreviewLines(state, theme, width), invalidate() {} });
  ui.addChild(cards);
  ui.start();
  const graphic = renderImage(png, getImageDimensions(png, 'image/png'), { maxWidthCells: 6, maxHeightCells: 3, moveCursor: false });
  ui.showOverlay({ render: width => previewLines({ path: imagePath, graphic }, theme, width), invalidate() {} },
    { row: 12, col: 30, width: 10, nonCapturing: true });
  output = '';
  ui.renderNow();
  const result = { output, state, graphic, protocol: getCapabilities().images, rendererProtocol: ui.imageProtocol };
  ui.stop();
  return result;
}

try {
  environment();
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  const manager = SettingsManager.inMemory();
  assert.equal(apply(manager).images, null, 'baseline Pi does not recognize Otty');

  // Actual extension factory runs before main/interactive apply settings and before renderer.start().
  const footer = await loadExtensions([new URL('../extensions/footer-status.ts', import.meta.url).pathname], process.cwd());
  assert.deepEqual(footer.errors, []);
  assert.notEqual(SettingsManager.prototype.getTerminalCapabilityOverrides, original, 'actual footer installs the bridge in its factory');
  assert.deepEqual(apply(manager), { images: 'kitty', hyperlinks: true, trueColor: false });
  const first = renderPreviews();
  assert.equal(first.rendererProtocol, 'kitty', 'first fullscreen start selects Kitty without private renderer writes');
  assert.ok(first.state.inlineGraphics.size > 0, 'automatic recognition restores real inline graphics');
  assert.ok(first.output.includes([...first.state.inlineGraphics.values()][0].sequence), 'actual compositor transmits automatic inline preview');
  assert.ok(first.graphic && first.output.includes(first.graphic.sequence), 'actual compositor transmits automatic hover preview');
  await shutdown(footer.extensions[0]);
  assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, original, 'footer shutdown uninstalls its own bridge');

  const release = install();
  for (const value of ['none', '0', 'NONE']) {
    environment({ PI_IMAGE_PROTOCOL: value });
    assert.equal(apply(manager).images, null, `environment ${value} stays disabled`);
    const frame = renderPreviews();
    assert.equal(frame.graphic, null);
    assert.equal(frame.state.inlineGraphics.size, 0);
    assert.doesNotMatch(frame.output, /\x1b_Ga=[Tp]|\x1b\]1337;File=/, 'disabled images never transmit or place new data');
    assert.equal(getCapabilities().hyperlinks, true, 'image opt-out does not turn off link recognition');
  }
  for (const value of ['kitty', 'KiTtY', 'iterm2']) {
    environment({ PI_IMAGE_PROTOCOL: value });
    assert.equal(manager.getTerminalCapabilityOverrides().images, undefined, 'bridge does not shadow a valid protocol env override');
    assert.equal(apply(manager).images, value.toLowerCase());
  }
  for (const value of ['auto', 'invalid', 'sixel']) {
    environment({ PI_IMAGE_PROTOCOL: value });
    assert.equal(apply(manager).images, 'kitty', 'unrecognized env values retain the native auto-detection semantics');
  }
  for (const env of [{}, { PI_IMAGE_PROTOCOL: 'kitty' }, { PI_IMAGE_PROTOCOL: 'iterm2' }]) {
    environment(env);
    const disabled = SettingsManager.inMemory({ terminal: { images: false } });
    const before = disabled.getGlobalSettings();
    assert.equal(apply(disabled).images, null, 'settings false retains precedence over env and detection');
    assert.deepEqual(disabled.getGlobalSettings(), before, 'bridge does not mutate settings');
    assert.doesNotMatch(renderPreviews().output, /\x1b_Ga=[Tp]|\x1b\]1337;File=/);
  }
  environment({ PI_IMAGE_PROTOCOL: 'none' });
  assert.equal(apply(SettingsManager.inMemory({ terminal: { images: 'iterm2' } })).images, 'iterm2', 'explicit settings retain Pi precedence over env');
  assert.equal(apply(SettingsManager.inMemory({ terminal: { images: 'kitty' } })).images, 'kitty');
  environment();
  const iterm = SettingsManager.inMemory({ terminal: { images: 'iterm2' } });
  apply(iterm);
  assert.match(renderPreviews(TuiMainScreen).output, /\x1b\]1337;File=/, 'explicit iTerm2 still renders in regular mode');
  const fullscreen = renderPreviews();
  assert.equal(fullscreen.protocol, null, 'fullscreen iTerm2 prohibition remains effective');
  assert.doesNotMatch(fullscreen.output, /\x1b_Ga=[Tp]|\x1b\]1337;File=/);
  assert.equal(getCapabilities().images, 'iterm2', 'native renderer restores capabilities on stop');

  for (const env of [{ TMUX: 'test' }, { STY: 'test' }, { TERM: 'tmux-256color' }, { TERM: 'screen-256color' }]) {
    environment({ ...env, PI_HYPERLINKS: '0' });
    assert.equal(apply(manager).images, null, 'multiplexer must not inherit the outer Otty graphics hint');
    assert.equal(getCapabilities().hyperlinks, false);
    process.env.PI_IMAGE_PROTOCOL = 'kitty';
    assert.equal(apply(manager).images, 'kitty', 'explicit user protocol remains Pi-owned even under a multiplexer');
  }
  for (const env of [{ TERM_PROGRAM: 'unknown' }, { TERM_PROGRAM: 'unknown', HERDR_PANE_ID: 'w1:p1' }, { TERM_PROGRAM: 'unknown', SSH_CONNECTION: 'remote' }]) {
    environment(env);
    assert.equal(apply(manager).images, null, 'unknown hosts and forks receive no new mapping');
    assert.equal(getCapabilities().hyperlinks, false);
  }
  environment({ TERM_PROGRAM: 'OtTy', PI_HYPERLINKS: '0' });
  assert.equal(apply(manager).images, 'kitty');
  assert.equal(getCapabilities().hyperlinks, false, 'link opt-out does not suppress images');
  environment({ PI_IMAGE_PROTOCOL: 'none', PI_HYPERLINKS: '1' });
  assert.equal(apply(manager).images, null);
  assert.equal(getCapabilities().hyperlinks, true);
  environment({ PI_HYPERLINKS: '1', PI_TRUE_COLOR: '1' });
  const linksDisabled = SettingsManager.inMemory({ terminal: { hyperlinks: false, trueColor: false } });
  assert.deepEqual(apply(linksDisabled), { images: 'kitty', hyperlinks: false, trueColor: false }, 'settings links/color remain independent and authoritative');
  environment();
  for (const program of ['ghostty', 'wezterm', 'kitty', 'iterm.app']) {
    environment({ TERM_PROGRAM: program });
    assert.deepEqual(manager.getTerminalCapabilityOverrides(), {}, 'recognized non-Otty terminals are not patched');
  }
  environment();
  const runtime = SettingsManager.inMemory();
  runtime.applyOverrides({ terminal: { images: false, hyperlinks: false } });
  assert.deepEqual(apply(runtime), { images: null, hyperlinks: false, trueColor: false }, 'in-memory runtime disable uses original this, not a disk approximation');
  runtime.applyOverrides({ terminal: { images: 'auto', hyperlinks: true } });
  assert.equal(apply(runtime).images, 'kitty', 'runtime auto setting restores mapped detection');
  const writes = [];
  const draft = { ...previewState(), tui: { terminal: { write: sequence => writes.push(sequence) } } };
  const draftRows = () => inlinePreviewLines(draft, theme, 80).join('');
  assert.match(draftRows(), /\x1b_Ga=T/);
  const oldId = [...draft.inlineGraphics.values()][0].imageId;
  runtime.applyOverrides({ terminal: { images: false } }); apply(runtime);
  assert.doesNotMatch(draftRows(), /\x1b_Ga=[Tp]/);
  assert.equal(draft.inlineGraphics.size, 0, 'settings disable clears the previous automatic preview cache');
  assert.ok(writes.includes(`\x1b_Ga=d,d=I,i=${oldId},q=2\x1b\\`), 'settings disable frees only the previous owned image');
  runtime.applyOverrides({ terminal: { images: 'auto' } }); apply(runtime);
  assert.match(draftRows(), /\x1b_Ga=T/, 'automatic previews resume after settings re-enable, without env export');
  assert.notEqual([...draft.inlineGraphics.values()][0].imageId, oldId, 're-enable rebuilds the released graphic');
  draft.enabled = () => false; draftRows();
  const unrelated = SettingsManager.inMemory({ terminal: { images: false } });
  unrelated.getTerminalCapabilityOverrides();
  assert.equal(apply(runtime).images, 'kitty', 'no manager binding leaks across unrelated instances');
  release();

  // Shared symbol ownership survives separate module evaluations, with both cleanup orders.
  environment();
  for (const oldestFirst of [true, false]) {
    const a = install();
    const wrapped = SettingsManager.prototype.getTerminalCapabilityOverrides;
    const otherModule = await jiti.import(bridgePath);
    const b = otherModule.installTerminalCapabilities(); owned.push(b);
    assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, wrapped, 'multiple owners do not wrap twice');
    (oldestFirst ? a : b)();
    assert.equal(manager.getTerminalCapabilityOverrides().images, 'kitty', 'one owner cannot uninstall the other');
    (oldestFirst ? b : a)();
    assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, original);
    a(); b();
  }

  // Preserve original receiver/arguments/object and any later third-party wrapper.
  const raw = Object.freeze({ images: null, hyperlinks: false });
  let receiver, args;
  SettingsManager.prototype.getTerminalCapabilityOverrides = function (...values) { receiver = this; args = values; return raw; };
  const frozenCleanup = install();
  assert.equal(manager.getTerminalCapabilityOverrides('sentinel'), raw);
  assert.equal(receiver, manager);
  assert.deepEqual(args, ['sentinel']);
  frozenCleanup();
  SettingsManager.prototype.getTerminalCapabilityOverrides = original;
  const oldOwner = install();
  const previous = SettingsManager.prototype.getTerminalCapabilityOverrides;
  const thirdParty = function (...values) { return { ...previous.apply(this, values), trueColor: true }; };
  SettingsManager.prototype.getTerminalCapabilityOverrides = thirdParty;
  const newOwner = install();
  oldOwner();
  assert.equal(manager.getTerminalCapabilityOverrides().images, 'kitty');
  newOwner();
  assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, thirdParty, 'cleanup cannot overwrite a newer third-party wrapper');
  assert.deepEqual(manager.getTerminalCapabilityOverrides(), { trueColor: true }, 'retained inactive wrapper is transparent');
  const again = install();
  oldOwner(); newOwner();
  assert.equal(manager.getTerminalCapabilityOverrides().images, 'kitty', 'late old cleanup cannot deactivate a fresh bridge');
  again();
  assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, thirdParty);
  SettingsManager.prototype.getTerminalCapabilityOverrides = original;

  // Actual loader/reload factories use the very same SettingsManager prototype as the host.
  const fixture = join(dir, 'terminal-capabilities.ts');
  await writeFile(fixture, `import {SettingsManager} from '@earendil-works/pi-coding-agent';
    import {getCapabilities} from '@earendil-works/pi-tui';
    import {installTerminalCapabilities} from ${JSON.stringify(bridgePath)};
    export default pi => { const release = installTerminalCapabilities();
      pi.on('session_shutdown', release);
      pi.registerCommand('identity', {handler: () => ({SettingsManager,getCapabilities})}); };`);
  environment();
  let loaded = await loadExtensions([fixture], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const identity = loaded.extensions[0].commands.get('identity').handler();
  assert.equal(identity.SettingsManager, SettingsManager);
  assert.equal(identity.getCapabilities, getCapabilities);
  const storage = { global: '{}', project: '{}', withLock(scope, fn) { const result = fn(this[scope]); if (result !== undefined) this[scope] = result; } };
  const liveSettings = SettingsManager.fromStorage(storage);
  assert.equal(apply(liveSettings).images, 'kitty');
  const staleOwner = loaded.extensions[0];
  for (const terminal of [{ images: false }, { images: 'auto' }, { hyperlinks: false }, { images: false, hyperlinks: true }]) {
    await shutdown(loaded.extensions[0], 'reload');
    storage.global = JSON.stringify({ terminal });
    await liveSettings.reload();
    loaded = await loadExtensions([fixture], process.cwd());
    assert.deepEqual(loaded.errors, []);
    await shutdown(staleOwner, 'reload');
    assert.equal(apply(liveSettings).images, terminal.images === false ? null : 'kitty', 'reload factories precede host settings application');
    assert.equal(getCapabilities().hyperlinks, terminal.hyperlinks ?? true);
  }
  for (const reason of ['new', 'resume', 'fork']) {
    await shutdown(loaded.extensions[0], reason);
    loaded = await loadExtensions([fixture], process.cwd());
    assert.deepEqual(loaded.errors, []);
    assert.equal(apply(SettingsManager.inMemory()).images, 'kitty', `${reason}: new factory installs before host rebind applies settings`);
  }
  await shutdown(loaded.extensions[0], 'reload');
  assert.equal(SettingsManager.prototype.getTerminalCapabilityOverrides, original);
  assert.equal(apply(manager).images, null, 'reload with extension disabled restores native unknown-terminal behavior');
} finally {
  for (const cleanup of owned) cleanup();
  SettingsManager.prototype.getTerminalCapabilityOverrides = original;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  setCapabilityOverrides({}); resetCapabilitiesCache(); setCellDimensions(cells);
  await rm(dir, { recursive: true, force: true });
}
console.log('terminal capabilities self-check passed');
