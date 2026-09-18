import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Markdown, renderImage, allocateImageId, getImageDimensions, TuiAltScreen, Text, setCapabilities, stripTerminalSequences, getOsc8LinkAtColumn } from '@earendil-works/pi-tui';
import { createSkillAutocompleteProvider, expandSkillTokens, imagePathsInLine, installInputEnhancements, readPreview, previewLines } from '../lib/input-enhancements.ts';
import { filePaths, inputCapabilities, linkMessageFiles } from '../lib/file-links.ts';

setCapabilities({ images: null, hyperlinks: false, trueColor: false });
assert.deepEqual(inputCapabilities({ TERM_PROGRAM: 'otty' }), { images: 'kitty', hyperlinks: true, trueColor: false });
assert.equal(inputCapabilities({ TERM_PROGRAM: 'otty', PI_HYPERLINKS: '0' }).hyperlinks, false);
process.env.TERM_PROGRAM = 'test-terminal';
setCapabilities({ images: null, hyperlinks: true, trueColor: false });
const dir = await mkdtemp(join(tmpdir(), 'pi-input-'));
try {
  const image = join(dir, 'a picture.png');
  const file = join(dir, 'notes.txt');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=', 'base64'));
  await writeFile(file, 'hello');
  assert.equal((await readPreview(image, dir)).kind, 'image');
  assert.equal(await readPreview(join(dir, 'missing.png'), dir), undefined);
  assert.deepEqual(imagePathsInLine(`"${image}" https://x/a.png a.png.bak`).map(x => x.path), [image]);
  for (const path of [image, file]) {
    const linked = linkMessageFiles(`see "${path}"`, dir);
    assert.ok(linked.includes(pathToFileURL(path).href));
    const theme = Object.fromEntries(['heading','link','linkUrl','code','codeBlock','codeBlockBorder','quote','quoteBorder','hr','listBullet','bold','italic','strikethrough','underline'].map(k => [k, t => t]));
    assert.ok(new Markdown(linked, 0, 0, theme).render(30).join('\n').includes(pathToFileURL(path).href), 'links survive actual Markdown wrapping');
  }
  const existing = `[file](${pathToFileURL(file).href})`;
  assert.equal(linkMessageFiles(existing, dir), existing);
  assert.equal(linkMessageFiles('https://example.com/a.png /missing/file.txt', dir), 'https://example.com/a.png /missing/file.txt');
  const separators = '派发子代理 / executor / 其他 agent';
assert.deepEqual(filePaths(separators), [], 'standalone slashes are prose separators, not paths');
assert.equal(linkMessageFiles(separators, dir), separators, 'prose separators must not become underlined links');
const fencedPath = '```text\nsee "' + file + '"\n```';
  assert.deepEqual(filePaths(fencedPath), [], 'paths inside a fence are not links');
  assert.equal(linkMessageFiles(fencedPath, dir), fencedPath);
  assert.equal(filePaths('see `' + file + '`')[0]?.path, file, 'inline ticks remain paths');
  const afterFence = 'see ' + file + '\n```text\n' + file + '\n```\nsee ' + file;
  assert.deepEqual(filePaths(afterFence).map(match => match.path), [file, file], 'a closing fence does not open a new range');
  assert.ok(linkMessageFiles(afterFence, dir).split(pathToFileURL(file).href).length === 3, 'paths after a fence still link');
  const paddedClose = '```text\n' + file + '\n```   \nsee ' + file;
  assert.deepEqual(filePaths(paddedClose).map(match => match.path), [file], 'a padded close fence still ends the range');

  const skills = new Map(['alpha', 'beta'].map(name => [`skill:${name}`, { command: `skill:${name}`, name, path: file, baseDir: dir }]));
  const native = { getSuggestions: async () => ({ items: [{ value: 'native', label: 'native' }], prefix: '/' }), applyCompletion: () => 'native' };
  let enabled = true;
  const provider = createSkillAutocompleteProvider(native, () => skills, () => enabled);
  const options = { signal: new AbortController().signal };
  for (const text of ['text /al', 'text\t/al', '/al']) {
    const found = await provider.getSuggestions([text], 0, text.length, options);
    assert.ok(found.items.some(item => item.value === '/skill:alpha'));
  }
  const completion = provider.applyCompletion(['before /al after', 'next'], 0, 10, { value: '/skill:alpha' }, '/al');
  assert.deepEqual(completion, { lines: ['before /skill:alpha after', 'next'], cursorLine: 0, cursorCol: 19 });
  for (const text of ['https://x/a', 'abc/al', '/tmp/a']) assert.equal((await provider.getSuggestions([text], 0, text.length, options)).items[0].value, 'native');
  enabled = false;
  assert.equal((await provider.getSuggestions(['text /al'], 0, 8, options)).items[0].value, 'native');
  enabled = true;
  const expanded = await expandSkillTokens('/skill:alpha then /skill:beta', skills, async () => 'BODY', () => {});
  assert.ok(expanded.includes('name="alpha"') && expanded.includes('name="beta"'));
  assert.equal(await expandSkillTokens('/skill:alpha only', skills, async () => 'BODY', () => {}), undefined);
  assert.equal(await expandSkillTokens('text /skill:alpha', skills, async () => { throw Error(); }, () => {}), undefined);

  // Render through Pi's actual fullscreen compositor, not just the preview component.
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  let ansi = '';
  const terminal = { columns: 80, rows: 24, start() {}, stop() {}, hideCursor() {}, showCursor() {}, write: text => { ansi += text; } };
  const actualTui = new TuiAltScreen(terminal);
  actualTui.addChild(new Text('background', 0, 0));
  actualTui.start();
  const png = (await readPreview(image, dir)).base64;
  const preview = { path: image, graphic: renderImage(png, getImageDimensions(png, 'image/png'), { maxWidthCells: 30, maxHeightCells: 6, imageId: allocateImageId(), moveCursor: false }) };
  actualTui.showOverlay({ render: width => previewLines(preview, { fg: (_key, text) => text }, width, { row: 12, col: 4 }), invalidate() {} }, { row: 12, col: 4, width: 32, nonCapturing: true });
  actualTui.renderNow();
  assert.ok(ansi.includes(png + '\x1b\\'), 'image payload survives real overlay composition');
  actualTui.stop();
  for (const dimensions of [{ widthPx: 1600, heightPx: 200 }, { widthPx: 200, heightPx: 1600 }]) {
    const graphic = renderImage(png, dimensions, { maxWidthCells: 58, maxHeightCells: 10, imageId: allocateImageId(), moveCursor: false });
    const frame = previewLines({ path: image, graphic }, { fg: (_key, text) => text }, graphic.columns + 2);
    assert.equal(frame.length, graphic.rows + 2, 'no extra blank rows beyond image and border');
    assert.ok(frame.every(line => stripTerminalSequences(line).length === graphic.columns + 2), 'border fits image width, not fixed popup width');
  }
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });

  const overlays = [];
  const pointerWrites = [];
  const tui = { previousScreen: [], terminal: { rows: 24, columns: 100, write: text => pointerWrites.push(text) }, requestRender() {}, invalidate() {}, showOverlay(component, options) {
    const overlay = { component, options, hidden: false }; overlays.push(overlay);
    return { hide() { overlay.hidden = true; }, getBounds() {} };
  } };
  const handlers = new Map();
  let factory, editor, autocomplete, terminalInput;
  const theme = { fg: (_key, text) => text };
  const ctx = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: {}, ui: {
    theme, notify() {}, getEditorComponent: () => factory,
    setEditorComponent(value) { factory = value; editor = value?.(tui, { borderColor: t => t, selectList: { selectedPrefix: t => t, selectedText: t => t, description: t => t, scrollInfo: t => t, noMatch: t => t } }, { matches: () => false }); if (editor) editor.onChange = () => {}; },
    addAutocompleteProvider(value) { autocomplete = value; },
    onTerminalInput(value) { terminalInput = value; return () => { terminalInput = undefined; }; },
  } };
  const pi = { on: (name, fn) => handlers.set(name, fn), getCommands: () => [...skills.values()].map(skill => ({ name: skill.command, source: 'skill', sourceInfo: { path: skill.path, baseDir: dir } })) };
  const cleanup = installInputEnhancements(pi, ctx, () => enabled);
  editor.setAutocompleteProvider(autocomplete(native));
  editor.focused = true;
  for (const char of '123 /') editor.handleInput(char);
  await delay(150);
  assert.ok(editor.render(100).join('\n').includes('skill:alpha'), 'typing a whitespace slash opens the real editor menu');
  editor.handleInput('\t');
  assert.equal(editor.getText(), '123 /skill:alpha ', 'completion preserves text before the cursor');
  editor.setText(`"${image}" tail`);
  for (let i = 0; i < 6; i++) editor.handleInput('\x1b[D');
  await delay(30);
  const rows = editor.render(25);
  assert.ok(rows.join('\n').includes(pathToFileURL(image).href), 'image chip links to actual file');
  assert.ok(stripTerminalSequences(rows.join('\n')).includes('[image1]'));
  assert.equal(editor.getText(), `"${image}" tail`, 'external reads and reload retain the real attachment');
  assert.ok(rows.join('\n').includes('\x1b[4m'), 'link is underlined');
  assert.ok(rows.join('\n').includes('\x1b_pi:c\x07'), 'IME cursor marker retained');
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].options.nonCapturing, true);
  assert.ok(overlays[0].component.render(100).join('\n').includes('终端未能'));
  assert.ok(!overlays[0].component.render(100).join('\n').includes(image), 'tooltip never shows filesystem paths');
  assert.equal(terminalInput('\x1b').consume, true);
  editor.render(200);
  editor.handleMouse({ type: 'move', button: 'none', x: 6, y: 1, width: 200, height: 3, screenX: 6, screenY: 1, ctrl: false, alt: false, shift: false });
  await delay(30);
  assert.equal(overlays[0].options.visible(), true, 'editor hover is wired');
  assert.equal(pointerWrites.at(-1), '\x1b]22;pointer\x07');
  assert.equal(overlays[0].options.row, 2, 'preview opens below a top-of-screen target');
  tui.previousScreen[23] = linkMessageFiles(`"${image}"`, dir);
  terminalInput('\x1b[<35;3;24M');
  await delay(30);
  assert.equal(overlays[0].options.visible(), true, 'sent message hover uses rendered link hit testing');
  assert.ok(overlays[0].options.row < 23, 'bottom-of-screen hover opens above the image label');
  terminalInput('\x1b[<35;90;24M');
  assert.equal(overlays[0].options.visible(), false, 'leaving link clears preview');
  assert.equal(pointerWrites.at(-1), '\x1b]22;default\x07');
  let submitted;
  editor.onSubmit = text => { submitted = text; };
  editor.handleInput('\r');
  assert.equal(submitted, `"${image}" tail`, 'submit expands image chips to paths');
  editor.setText(`"${image}" tail`);
  enabled = false; cleanup.refresh();
  assert.equal(overlays[0].options.visible(), false);
  assert.ok(!editor.render(200).join('\n').includes('\x1b]8;'));
  assert.equal(editor.getText().includes(image), true);
  enabled = true;
  editor.setText(`before "${image}" after`);
  const linkedRow = editor.render(100)[1];
  const plainRow = stripTerminalSequences(linkedRow);
  for (let col = 0; col < plainRow.length; col++) {
    assert.equal(!!getOsc8LinkAtColumn(linkedRow, col), col >= 8 && col < 16, `only image label is linked at column ${col}`);
  }
  editor.setText(`中文 before "${image}" middle "${image}" after`);
  for (const width of [12, 25, 100]) {
    for (const row of editor.render(width)) {
      const text = stripTerminalSequences(row);
      const ranges = [...text.matchAll(/\[image\d+\]/g)].map(match => ({ start: Array.from(text.slice(0, match.index)).reduce((n, c) => n + (/[^\u0000-\u00ff]/.test(c) ? 2 : 1), 0), length: match[0].length }));
      for (let col = 0; col < width; col++) assert.equal(!!getOsc8LinkAtColumn(row, col), ranges.some(range => col >= range.start && col < range.start + range.length), `wrapped CJK label only: width ${width}, column ${col}`);
    }
  }
  cleanup();
  assert.equal(factory, undefined);
  assert.equal(terminalInput, undefined);
  assert.equal(overlays[0].hidden, true);

  // Real fullscreen mouse dispatch must reach history before the native consuming listener.
  let sendInput;
  const liveTerminal = { ...terminal, start: fn => { sendInput = fn; }, write: text => { ansi += text; } };
  const live = new TuiAltScreen(liveTerminal);
  const originalViewport = live.handleViewportInput;
  const history = new Text(linkMessageFiles(`"${image}" tail`, dir), 0, 0);
  live.addChild(history);
  live.start();
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  const liveCtx = { ...ctx, sessionManager: {}, ui: { ...ctx.ui,
    getEditorComponent: () => undefined,
    setEditorComponent: value => { if (value) value(live, { borderColor: t => t, selectList: {} }, { matches: () => false }); },
    onTerminalInput: fn => live.addInputListener(fn),
  } };
  const stop = installInputEnhancements({ ...pi }, liveCtx, true);
  live.renderNow();
  ansi = '';
  sendInput('\x1b[<35;3;1M');
  await delay(40);
  live.renderNow();
  assert.ok(ansi.includes(png + '\x1b\\'), 'real history hover emits complete image, not just a path');
  assert.ok(live.previousScreen.some(line => stripTerminalSequences(line).includes('╭')), 'preview has a visible frame');
  assert.ok(!live.previousScreen.slice(1).some(line => stripTerminalSequences(line).includes(image)), 'no path caption');
  sendInput('\x1b[<35;75;1M');
  await delay(40);
  live.renderNow();
  assert.ok(!live.previousScreen.some(line => stripTerminalSequences(line).includes('╭')), 'moving outside label dismisses preview');
  const stale = () => { throw new Error('This extension context is stale after session replacement/reload.'); };
  Object.defineProperties(liveCtx, {
    ui: { get: stale, configurable: true },
    cwd: { get: stale, configurable: true },
    hasUI: { get: stale, configurable: true },
    mode: { get: stale, configurable: true },
    sessionManager: { get: stale, configurable: true },
  });
  const nextCtx = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: {}, ui: {
    theme, notify() {}, addAutocompleteProvider() {},
    getEditorComponent: () => undefined,
    setEditorComponent: value => { if (value) value(live, { borderColor: t => t, selectList: {} }, { matches: () => false }); },
    onTerminalInput: fn => live.addInputListener(fn),
  } };
  const next = installInputEnhancements({ ...pi }, nextCtx, true);
  ansi = '';
  assert.doesNotThrow(() => sendInput('\x1b[<35;3;1M'), 'mouse after /new must not read the replaced ctx');
  await delay(40);
  live.renderNow();
  assert.ok(ansi.includes(png + '\x1b\\'), 'hover after /new still previews');
  assert.doesNotThrow(() => stop(), 'late shutdown of the replaced instance must ignore stale ctx');
  sendInput('\x1b[<35;75;1M');
  await delay(40);
  live.renderNow();
  assert.ok(!live.previousScreen.some(line => stripTerminalSequences(line).includes('╭')), 'late shutdown must not tear down the new session hook');
  next();
  assert.equal(live.handleViewportInput, originalViewport, 'replacement cleanup restores native mouse dispatch');
  live.stop();
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('input enhancements self-check passed');
