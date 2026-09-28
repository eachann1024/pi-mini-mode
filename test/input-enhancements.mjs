import './terminal-capabilities.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { ProcessTerminal } from '@earendil-works/pi-tui/dist/terminal.js';
import { Box, Markdown, renderImage, allocateImageId, getCapabilities, getCellDimensions, setCellDimensions, isKittyProtocolActive, setKittyProtocolActive, resetCapabilitiesCache, setCapabilityOverrides, getImageDimensions, TuiAltScreen, TuiMainScreen, Text, setCapabilities, stripTerminalSequences, getOsc8LinkAtColumn, sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';
import { createSkillAutocompleteProvider, expandSkillTokens, imagePathsInLine, installInputEnhancements, readPreview, previewLines, inlinePreviewLines } from '../lib/input-enhancements.ts';
import { filePaths, inputCapabilities, linkMessageFiles } from '../lib/file-links.ts';

// Track protocol cursor placement in the actual compositor output, not terminal paint timing.
function imagePositions(ansi, ottySynchronizedCursor = false) {
  let synchronized = false;
  let pending = [];
  let row = 0, col = 0, saved = [0, 0];
  const images = [];
  const apply = value => {
    const csi = /^\x1b\[(\d*(?:;\d*)*)([HABCDGsu])$/.exec(value);
    if (csi) {
      const [n, m] = csi[1].split(';').map(Number);
      if (csi[2] === 'H') { row = (n || 1) - 1; col = (m || 1) - 1; }
      if (csi[2] === 'A') row -= n || 1;
      if (csi[2] === 'B') row += n || 1;
      if (csi[2] === 'C') col += n || 1;
      if (csi[2] === 'D') col -= n || 1;
      if (csi[2] === 'G') col = (n || 1) - 1;
      if (csi[2] === 's') saved = [row, col];
      if (csi[2] === 'u') [row, col] = saved;
    } else if (!value.startsWith('\x1b')) col += visibleWidth(value);
  };
  for (const token of ansi.matchAll(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]][^\x07\x1b]*(?:\x07|\x1b\\))|[^\x1b]+/g)) {
    const value = token[0];
    if (/^\x1b_Ga=[Tp]/.test(value)) { images.push({ row, col }); continue; }
    if (ottySynchronizedCursor && value === '\x1b[?2026h') { synchronized = true; continue; }
    if (ottySynchronizedCursor && value === '\x1b[?2026l') {
      synchronized = false; pending.forEach(apply); pending = []; continue;
    }
    if (ottySynchronizedCursor && synchronized) pending.push(value);
    else apply(value);
  }
  return images;
}

function inverseColumns(row) {
  const clean = row.replace(/\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const columns = [];
  let inverse = false, col = 0;
  for (const part of clean.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) {
      for (const code of part.slice(2, -1).split(';').map(Number)) {
        if (code === 0 || code === 27) inverse = false;
        if (code === 7) inverse = true;
      }
    } else {
      const width = visibleWidth(part);
      if (inverse) for (let i = 0; i < width; i++) columns.push(col + i);
      col += width;
    }
  }
  assert.equal(inverse, false, 'reverse-video is closed at the row boundary');
  return columns;
}

function assertChipColors(row) {
  const plain = stripTerminalSequences(row);
  for (const match of plain.matchAll(/  #\d+/g)) {
    const start = visibleWidth(plain.slice(0, match.index));
    const end = start + visibleWidth(match[0]);
    for (let col = start; col < end; col++) {
      const prefix = sliceByColumn(row, 0, col + 1).replace(/\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
      let fg;
      for (const sgr of prefix.matchAll(/\x1b\[([0-9;]*)m/g)) {
        for (const code of sgr[1].split(';').map(Number)) {
          if (code === 0 || code === 39) fg = undefined;
          if (code >= 30 && code <= 37) fg = code;
        }
      }
      assert.equal(fg, 36, `image glyph and label retain accent at column ${col}`);
    }
  }
}

const capabilityEnv = ['TERM', 'TERM_PROGRAM', 'TERMINAL_EMULATOR', 'COLORTERM', 'TMUX', 'STY', 'SSH_CONNECTION', 'SSH_TTY', 'SHELL',
  'HERDR_PANE_ID', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'WARP_SESSION_ID', 'WARP_TERMINAL_SESSION_UUID',
  'ITERM_SESSION_ID', 'WT_SESSION', 'PI_IMAGE_PROTOCOL', 'PI_HYPERLINKS', 'PI_TRUE_COLOR'];
const originalEnv = Object.fromEntries(capabilityEnv.map(key => [key, process.env[key]]));
function capabilities(env = {}, overrides = {}) {
  for (const key of capabilityEnv) delete process.env[key];
  Object.assign(process.env, { TERM: 'xterm-256color', TERM_PROGRAM: 'test-terminal' }, env);
  setCapabilityOverrides(overrides);
  resetCapabilitiesCache();
  return inputCapabilities();
}
const dir = await mkdtemp(join(tmpdir(), 'pi-input-'));
try {
  assert.equal(inputCapabilities, getCapabilities, 'capabilities are Pi-owned, not another detection policy');
  for (const env of [{ TERM_PROGRAM: 'otty' }, { HERDR_PANE_ID: 'w1:p1' }, { SHELL: '/bin/kitty' },
    { SSH_CONNECTION: 'remote', TERM_PROGRAM: 'unknown' }, { PI_IMAGE_PROTOCOL: 'auto' }, { PI_IMAGE_PROTOCOL: 'sixel' }, { PI_IMAGE_PROTOCOL: 'invalid' }]) {
    assert.equal(capabilities(env).images, null, 'unknown apps, shells, remote hosts and unsupported protocols do not imply Kitty');
    assert.equal(inputCapabilities().hyperlinks, false, 'images do not grant hyperlinks');
  }
  for (const program of ['otty', 'ghostty', 'kitty', 'wezterm', 'iterm.app', 'unknown']) {
    for (const [override, expected] of [['kitty', 'kitty'], ['iterm2', 'iterm2'], ['KiTtY', 'kitty'], ['none', null], ['0', null]]) {
      assert.equal(capabilities({ TERM_PROGRAM: program, PI_IMAGE_PROTOCOL: override }).images, expected, `${program}: explicit ${override}`);
    }
  }
  assert.equal(capabilities({ TERM_PROGRAM: 'ghostty', PI_IMAGE_PROTOCOL: 'auto' }).images, 'kitty', 'reuse native known protocol detection');
  assert.equal(capabilities({ TERM_PROGRAM: 'ghostty', PI_IMAGE_PROTOCOL: 'invalid' }).images, 'kitty', 'invalid hints do not override native detection');
  assert.equal(capabilities({ TERM_PROGRAM: 'iterm.app' }).images, 'iterm2');
  assert.equal(capabilities({ PI_IMAGE_PROTOCOL: 'kitty', PI_HYPERLINKS: '0' }).hyperlinks, false);
  assert.equal(capabilities({ PI_IMAGE_PROTOCOL: 'none', PI_HYPERLINKS: '1' }).hyperlinks, true);
  assert.equal(capabilities({ TERM_PROGRAM: 'ghostty', PI_IMAGE_PROTOCOL: 'kitty' }, { images: null }).images, null, 'Pi settings disable wins over env and detection');
  assert.equal(capabilities({ PI_IMAGE_PROTOCOL: 'none' }, { images: 'iterm2' }).images, 'iterm2', 'Pi settings select the effective protocol');
  for (const env of [{ TMUX: 'test', PI_HYPERLINKS: '0' }, { TERM: 'screen-256color' }, { TERM: 'tmux-256color', PI_HYPERLINKS: '0' }]) {
    assert.equal(capabilities({ TERM_PROGRAM: 'ghostty', ...env }).images, null, 'multiplexer cannot inherit outer terminal graphics');
    assert.equal(capabilities({ ...env, PI_IMAGE_PROTOCOL: 'kitty' }).images, 'kitty', 'only an explicit user override bypasses native multiplexer protection');
  }
  assert.equal(capabilities({ SSH_TTY: '/dev/pts/1', PI_IMAGE_PROTOCOL: 'iterm2' }).images, 'iterm2', 'SSH uses explicit protocol rather than local filesystem inference');
  const disabledCaps = capabilities({ TERM_PROGRAM: 'otty', HERDR_PANE_ID: 'w1:p1' }, { images: null, hyperlinks: false });
  const noUiCleanup = installInputEnhancements({ on() {} }, { mode: 'print', hasUI: false, cwd: dir }, true);
  assert.equal(getCapabilities(), disabledCaps, 'non-TUI installation cannot force app capabilities');
  noUiCleanup();
  capabilities();
  // Use Pi's actual loader: transitive extension imports must share the host cache and cell metrics.
  const agentEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const { loadExtensions } = await import(new URL('./core/extensions/loader.js', agentEntry));
  const fixture = join(dir, 'capabilities.ts');
  await writeFile(fixture, `import {getCapabilities,getCellDimensions} from '@earendil-works/pi-tui';
    import {inputCapabilities} from ${JSON.stringify(new URL('../lib/file-links.ts', import.meta.url).pathname)};
    export default pi => pi.registerCommand('capabilities-test', {handler: () => ({getCapabilities,getCellDimensions,inputCapabilities})});`);
  const loaded = await loadExtensions([fixture], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const shared = loaded.extensions[0].commands.get('capabilities-test').handler();
  assert.equal(shared.getCapabilities, getCapabilities, 'loader shares capability getter with host');
  assert.equal(shared.inputCapabilities, getCapabilities, 'transitive local import also uses host capability cache');
  assert.equal(shared.getCellDimensions, getCellDimensions, 'cell-size replies need no second query or cache bridge');
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });
  const image = join(dir, 'a picture.png');
  const file = join(dir, 'notes.txt');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=', 'base64'));
  const spacedDir = join(dir, 'Application Support');
  await (await import('node:fs/promises')).mkdir(spacedDir);
  const spacedImage = join(spacedDir, 'clipboard image.png');
  await writeFile(spacedImage, await readFile(image));
  assert.deepEqual(imagePathsInLine(spacedImage).map(match => match.path), [spacedImage], 'unquoted clipboard path with spaces is one image');
  const raycastImage = join(spacedDir, '小姐妹 (1).png');
  await writeFile(raycastImage, await readFile(image));
  const escapedImage = raycastImage.replace(/[ ()]/g, '\\$&');
  const escapedPair = `${escapedImage} ${escapedImage}`;
  const escapedMatches = imagePathsInLine(escapedPair);
  assert.deepEqual(escapedMatches.map(match => match.path), [raycastImage, raycastImage], 'Raycast shell escapes are decoded only for file access');
  assert.deepEqual(escapedMatches.map(match => escapedPair.slice(match.start, match.end)), [escapedImage, escapedImage], 'replacement spans include every escape character');
  const escapedLinks = linkMessageFiles(escapedPair, dir);
  assert.match(stripTerminalSequences(escapedLinks), /^  #1   #2$/, 'sent escaped paths leave no Application\\ fragment');
  assert.equal(getOsc8LinkAtColumn(escapedLinks, 0), pathToFileURL(raycastImage).href);
  assert.equal(filePaths(`"${raycastImage}"`)[0].path, raycastImage, 'quoted literal paths stay unchanged');
  assert.equal(filePaths('C:\\Users\\test\\image.png')[0].path, 'C:\\Users\\test\\image.png', 'Windows separators are not shell escapes');
  const { default: photon } = await import('@silvia-odwyer/photon-node');
  const pixels = new photon.PhotonImage(new Uint8Array([255, 80, 0, 255]), 1, 1);
  try {
    for (const [extension, bytes] of [['jpg', pixels.get_bytes_jpeg(80)], ['webp', pixels.get_bytes_webp()], ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')]]) {
      const path = join(dir, `tiny.${extension}`);
      await writeFile(path, bytes);
      const converted = await readPreview(path, dir);
      assert.equal(converted.kind, 'image', `${extension} remains previewable`);
      assert.equal(converted.mimeType, 'image/png', `${extension} is normalized for Kitty f=100`);
      assert.equal(Buffer.from(converted.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'payload is actual PNG, not a renamed source');
    }
  } finally { pixels.free(); }
  await writeFile(file, 'hello');
  assert.equal((await readPreview(image, dir)).kind, 'image');
  const sentChip = linkMessageFiles(`before "${image}" after`, dir);
  assert.ok(stripTerminalSequences(sentChip).includes('  #1'), 'sent message shows the same image chip');
  assert.equal(getOsc8LinkAtColumn(sentChip, 9), pathToFileURL(image).href, 'sent chip links to the image for hover');
  assert.ok(!sentChip.includes('\x1b[4m'), 'sent image chip is not underlined');
  const twice = linkMessageFiles(`"${image}" then "${image}"`, dir);
  assert.match(stripTerminalSequences(twice), /  #1.*  #2/, 'sent attachments keep distinct labels in source order');
  assert.equal(getOsc8LinkAtColumn(twice, stripTerminalSequences(twice).indexOf('  #2')), pathToFileURL(image).href, 'second sent chip also previews the image');
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
  const html = join(dir, 'HANDOVER.html');
  await writeFile(html, '<html></html>');
  for (const target of [html, './HANDOVER.html']) {
    const linked = linkMessageFiles(`[${html}](${target})`, dir);
    assert.equal(linked, `[${html}](<${pathToFileURL(html).href}>)`);
    const theme = Object.fromEntries(['heading','link','linkUrl','code','codeBlock','codeBlockBorder','quote','quoteBorder','hr','listBullet','bold','italic','strikethrough','underline'].map(k => [k, t => t]));
    const rendered = new Markdown(linked, 0, 0, theme).render(200).join('');
    assert.equal(getOsc8LinkAtColumn(rendered, 0), pathToFileURL(html).href, 'local Markdown links render a file URI for terminal clicks');
  }
  assert.equal(linkMessageFiles('[site](https://example.com)', dir), '[site](https://example.com)');
  assert.equal(linkMessageFiles('[missing](/missing/file.html)', dir), '[missing](/missing/file.html)');
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
  actualTui.showOverlay({ render: width => previewLines(preview, { fg: (_key, text) => text }, width), invalidate() {} }, { row: 12, col: 4, width: 32, nonCapturing: true });
  actualTui.renderNow();
  assert.ok(ansi.includes(png + '\x1b\\'), 'image payload survives real overlay composition');
  assert.deepEqual(imagePositions(ansi).at(-1), { row: 13, col: 5 }, 'hover pixels sit one cell inside the actual frame');
  const protocolFrame = previewLines(preview, { fg: (_key, text) => text }, 32);
  for (const program of ['otty', 'ghostty', 'kitty', 'unknown']) {
    process.env.TERM_PROGRAM = program;
    const frame = previewLines(preview, { fg: (_key, text) => text }, 32);
    assert.deepEqual(frame.map(line => line.replace(/\x1b\[\?2026[hl]/g, '').replace(/(?:\x1b\[0m){2}/g, '\x1b[0m')), protocolFrame);
    assert.equal(frame.join('').includes('\x1b[?2026l'), program === 'otty', 'only direct Otty Kitty previews flush stale synchronized cursor');
  }
  process.env.TERM_PROGRAM = 'otty';
  ansi = ''; actualTui.invalidate(); actualTui.renderNow();
  assert.deepEqual(imagePositions(ansi, true).at(-1), { row: 13, col: 5 }, 'Otty commits the hover target before consuming Kitty APC, including cached placements');
  assert.notDeepEqual(imagePositions(ansi.replace(/\x1b\[\?2026l\x1b\[0m/g, '\x1b[0m'), true).at(-1), { row: 13, col: 5 }, 'regression model reproduces stale-cursor placement without the local commit');
  for (const [key, value] of [['TMUX', '/tmp/mux'], ['STY', 'screen'], ['TERM', 'tmux-256color']]) {
    const saved = process.env[key]; process.env[key] = value;
    assert.ok(!previewLines(preview, { fg: (_key, text) => text }, 32).join('').includes('\x1b[?2026'), 'multiplexers are not treated as direct Otty');
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
  process.env.TERM_PROGRAM = 'test-terminal';
  terminal.columns = 22; terminal.rows = 10; ansi = '';
  actualTui.renderNow();
  const resizedFrameRow = actualTui.previousScreen.findIndex(row => stripTerminalSequences(row).includes('╭'));
  const resizedFrameCol = visibleWidth(stripTerminalSequences(actualTui.previousScreen[resizedFrameRow]).split('╭')[0]);
  assert.deepEqual(imagePositions(ansi).at(-1), { row: resizedFrameRow + 1, col: resizedFrameCol + 1 }, 'clamping an overlay never leaves its image at the old screen coordinates');
  terminal.columns = 80; terminal.rows = 24;
  actualTui.stop();
  const largeImage = new URL('../assets/pi-mini-mode-hero.png', import.meta.url);
  const source = await readFile(largeImage);
  const large = await readPreview(largeImage.pathname, dir, { widthPx: 702, heightPx: 396 });
  assert.equal(large.kind, 'image', 'large source is still previewable');
  const reduced = getImageDimensions(large.base64, large.mimeType);
  assert.ok(reduced.widthPx <= 702 && reduced.heightPx <= 396, 'preview pixels fit terminal cells');
  assert.ok(large.base64.length < 1024 * 1024, 'transmitted image fits bounded payload');
  assert.ok(large.base64.length < source.toString('base64').length, 'terminal receives a reduced copy, not the original');
  const largeGraphic = renderImage(large.base64, reduced, { maxWidthCells: 78, maxHeightCells: 22, imageId: allocateImageId(), moveCursor: false });
  ansi = '';
  const largeTui = new TuiAltScreen(terminal);
  largeTui.addChild(new Text('background', 0, 0));
  largeTui.start();
  largeTui.showOverlay({ render: width => previewLines({ path: largeImage.pathname, graphic: largeGraphic }, { fg: (_key, text) => text }, width), invalidate() {} },
    { row: 4, col: 0, width: largeGraphic.columns + 2, nonCapturing: true });
  largeTui.renderNow();
  assert.ok(ansi.includes(largeGraphic.sequence), 'real fullscreen output transmits the scaled large image');
  assert.ok(largeTui.previousScreen.some(row => stripTerminalSequences(row).includes('╭')), 'large preview keeps its visible frame');
  largeTui.stop();
  for (const dimensions of [{ widthPx: 1600, heightPx: 200 }, { widthPx: 200, heightPx: 1600 }]) {
    const graphic = renderImage(png, dimensions, { maxWidthCells: 58, maxHeightCells: 10, imageId: allocateImageId(), moveCursor: false });
    const frame = previewLines({ path: image, graphic }, { fg: (_key, text) => text }, graphic.columns + 2);
    assert.equal(frame.length, graphic.rows + 2, 'no extra blank rows beyond image and border');
    assert.ok(frame.every(line => stripTerminalSequences(line).length === graphic.columns + 2), 'border fits image width, not fixed popup width');
  }
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });
  const inlineState = { editor: { getText: () => `${image} ${image}` }, enabled: () => true, previewMode: () => 'inline',
    inlineImages: new Map([[image, await readPreview(image, dir)]]), inlinePending: new Map(), inlineGraphics: new Map() };
  assert.match(inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 50)[0], /#1.*#2/, 'duplicate paths retain separate cards');
  const secondImage = join(dir, 'second.png');
  await writeFile(secondImage, await readFile(image));
  inlineState.editor.getText = () => `${image} ${secondImage}`;
  inlineState.inlineImages.set(secondImage, await readPreview(secondImage, dir));
  const cards = inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 50);
  assert.ok(cards[0].includes('  #1') && cards[0].includes('  #2'));
  assert.ok(cards.at(-1).includes('1x1'));
  assert.ok(cards.every(row => visibleWidth(row) <= 50));
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  const actualImage = new URL('../assets/pi-mini-mode-hero.png', import.meta.url);
  const actualPreview = await readPreview(actualImage.pathname, dir);
  inlineState.editor.getText = () => actualImage.pathname;
  inlineState.inlineImages = new Map([[actualImage.pathname, actualPreview]]);
  inlineState.inlineGraphics.clear();
  const realCards = inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 80);
  const graphic = inlineState.inlineGraphics.get(`0:${actualImage.pathname}`);
  assert.equal(realCards.length, 6, 'OMP-sized 12x4 card has stable geometry');
  assert.ok(realCards.at(-1).includes(graphic.sequence), 'direct Kitty placement draws after frame');
  assert.ok(realCards.every(row => visibleWidth(row) <= 80));
  assert.equal(actualPreview.widthPx, getImageDimensions((await readFile(actualImage)).toString('base64'), 'image/png').widthPx, 'caption uses original size');
  ansi = '';
  const inlineTui = new TuiAltScreen(terminal);
  const paddedCards = new Box(3, 2);
  paddedCards.addChild({ render: width => inlinePreviewLines(inlineState, { fg: (_key, text) => text }, width), invalidate() {} });
  inlineTui.addChild(paddedCards);
  inlineTui.start(); inlineTui.renderNow();
  assert.ok(ansi.includes(graphic.sequence), 'fullscreen compositor transmits inline image');
  const cardOrigin = { row: 3 + Math.floor((4 - graphic.rows) / 2), col: 4 + Math.floor((12 - graphic.columns) / 2) };
  assert.deepEqual(imagePositions(ansi).at(-1), cardOrigin, 'thumbnail placement follows parent padding instead of terminal column one');
  for (const program of ['otty', 'ghostty', 'kitty', 'unknown']) {
    process.env.TERM_PROGRAM = program;
    const frame = inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 80);
    assert.deepEqual(frame.map(line => line.replace(/\x1b\[\?2026[hl]/g, '').replace(/(?:\x1b\[0m){2}/g, '\x1b[0m')), realCards);
    assert.equal(frame.join('').includes('\x1b[?2026l'), program === 'otty', 'Otty thumbnail has the same cursor commit boundary');
  }
  process.env.TERM_PROGRAM = 'otty';
  ansi = ''; inlineTui.invalidate(); inlineTui.renderNow();
  assert.deepEqual(imagePositions(ansi, true).at(-1), cardOrigin, 'Otty thumbnail target is committed with real compositor parent padding');
  process.env.TERM_PROGRAM = 'test-terminal';
  assert.ok(!ansi.includes(',y='), 'fullscreen compositor does not crop a picture drawn after its frame');
  assert.ok(inlineTui.previousScreen.some(row => stripTerminalSequences(row).includes(`${actualPreview.widthPx}x${actualPreview.heightPx}`)), 'fullscreen card retains source dimensions');
  inlineTui.stop();
  inlineState.editor.getText = () => `${image} ${secondImage}`;
  inlineState.inlineImages = new Map([[image, await readPreview(image, dir)], [secondImage, await readPreview(secondImage, dir)]]);
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });
  assert.ok(inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 22).join('\n').includes('  #2'), 'overflow retains numbered tags');
  inlineState.previewMode = () => 'hover';
  assert.deepEqual(inlinePreviewLines(inlineState, { fg: (_key, text) => text }, 50), []);

  const deletedIds = text => [...text.matchAll(/\x1b_Ga=d,d=I,i=(\d+),q=2\x1b\\/g)].map(match => +match[1]);
  const graphicIds = text => [...text.matchAll(/\x1b_Ga=T,[^;]*\bi=(\d+)/g)].map(match => +match[1]);
  const imageWrites = [];
  const lifecycle = { ...inlineState, tui: { terminal: { write: text => imageWrites.push(text) } },
    editor: { getText: () => image }, previewMode: () => 'inline', inlineGraphics: new Map() };
  const renderCards = (width = 80) => inlinePreviewLines(lifecycle, { fg: (_key, text) => text }, width).join('\n');
  setCapabilities({ images: 'kitty', hyperlinks: false, trueColor: false });
  const firstCards = renderCards();
  const firstId = graphicIds(firstCards)[0];
  assert.ok(firstId);
  assert.ok(firstCards.includes('C=1'), 'Kitty placement does not move the text cursor');
  assert.equal(renderCards(), firstCards, 'unchanged images reuse the same owned placement');
  const originalCells = getCellDimensions();
  setCellDimensions({ widthPx: 12, heightPx: 24 });
  renderCards();
  assert.deepEqual(deletedIds(imageWrites.join('')), [firstId], 'new cell metrics release the old image before regenerating');
  let previousId = [...lifecycle.inlineGraphics.values()][0].imageId;
  setCapabilities({ images: 'iterm2', hyperlinks: false, trueColor: false });
  const itermCards = renderCards();
  assert.ok(itermCards.includes('\x1b]1337;File='), 'regular iTerm2 uses OSC 1337');
  assert.ok(!itermCards.includes('\x1b_G'), 'switching to iTerm2 never reuses a cached Kitty payload');
  assert.ok(deletedIds(imageWrites.join('')).includes(previousId), 'switching protocol releases owned Kitty data');
  assert.equal([...lifecycle.inlineGraphics.values()][0].imageId, undefined, 'iTerm2 has no Kitty deletion id');
  const itermHover = renderImage(png, getImageDimensions(png, 'image/png'), { maxWidthCells: 12, maxHeightCells: 4 });
  assert.ok(previewLines({ path: image, graphic: itermHover }, { fg: (_key, text) => text }, 14).join('').includes('\x1b]1337;File='));
  ansi = '';
  const regularTui = new TuiMainScreen(terminal);
  regularTui.addChild({ render: () => renderCards().split('\n'), invalidate() {} });
  regularTui.start(); regularTui.renderNow();
  regularTui.showOverlay({ render: width => previewLines({ path: image, graphic: itermHover }, { fg: (_key, text) => text }, width), invalidate() {} },
    { row: 12, col: 4, width: 14, nonCapturing: true });
  regularTui.renderNow();
  assert.ok(ansi.includes(itermHover.sequence), 'regular compositor emits the iTerm2 hover payload');
  assert.ok(ansi.includes([...lifecycle.inlineGraphics.values()][0].sequence), 'regular compositor emits the iTerm2 thumbnail payload');
  regularTui.stop();
  ansi = '';
  const itermTui = new TuiAltScreen(terminal);
  itermTui.addChild({ render: () => renderCards().split('\n'), invalidate() {} });
  itermTui.start(); itermTui.renderNow();
  assert.equal(shared.inputCapabilities().images, null, 'fullscreen disables iTerm2 through the same host cache');
  assert.ok(!ansi.includes('\x1b]1337;File=') && !ansi.includes('\x1b_G'), 'fullscreen honors Pi\'s deliberate text fallback');
  itermTui.stop();
  assert.equal(shared.inputCapabilities().images, 'iterm2', 'leaving fullscreen restores native capability');
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  renderCards(); previousId = [...lifecycle.inlineGraphics.values()][0].imageId;
  setCapabilities({ images: null, hyperlinks: true, trueColor: true });
  assert.ok(!renderCards().includes('\x1b_G'), 'no graphics protocol gives text cards');
  assert.ok(deletedIds(imageWrites.join('')).includes(previousId), 'disable frees previous Kitty data');
  for (const reason of ['path', 'mode', 'enabled', 'narrow']) {
    setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
    lifecycle.editor.getText = () => image; lifecycle.previewMode = () => 'inline'; lifecycle.enabled = () => true;
    renderCards(); previousId = [...lifecycle.inlineGraphics.values()][0].imageId;
    if (reason === 'path') lifecycle.editor.getText = () => '';
    if (reason === 'mode') lifecycle.previewMode = () => 'hover';
    if (reason === 'enabled') lifecycle.enabled = () => false;
    assert.equal(renderCards(reason === 'narrow' ? 10 : 80), '');
    assert.ok(deletedIds(imageWrites.join('')).includes(previousId), `${reason}: hidden thumbnail frees its Kitty data`);
    assert.equal(lifecycle.inlineGraphics.size, 0);
  }
  assert.ok(imageWrites.every(write => /^\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\$/.test(write)), 'extension only deletes its ids, never all terminal images');
  setCellDimensions(originalCells);
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });

  const overlays = [];
  const pointerWrites = [];
  let renders = 0;
  const tui = { previousScreen: [], terminal: { rows: 24, columns: 100, write: text => pointerWrites.push(text) }, requestRender() { renders++; }, invalidate() {}, showOverlay(component, options) {
    const overlay = { component, options, hidden: false }; overlays.push(overlay);
    return { hide() { overlay.hidden = true; }, getBounds() {} };
  } };
  const handlers = new Map();
  let factory, editor, autocomplete, terminalInput;
  const theme = { fg: (_key, text) => text };
  const ctx = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: {}, ui: {
    theme, notify() {}, setWidget() {}, getEditorComponent: () => factory,
    setEditorComponent(value) { factory = value; editor = value?.(tui, { borderColor: t => t, selectList: { selectedPrefix: t => t, selectedText: t => t, description: t => t, scrollInfo: t => t, noMatch: t => t } }, { matches: () => false }); if (editor) editor.onChange = () => {}; },
    addAutocompleteProvider(value) { autocomplete = value; },
    onTerminalInput(value) { terminalInput = value; return () => { terminalInput = undefined; }; },
  } };
  const pi = { on: (name, fn) => handlers.set(name, fn), getCommands: () => [...skills.values()].map(skill => ({ name: skill.command, source: 'skill', sourceInfo: { path: skill.path, baseDir: dir } })) };
  let mode = 'hover';
  const cleanup = installInputEnhancements(pi, ctx, () => enabled, () => mode);
  assert.equal(terminalInput instanceof Function, true, 'uses Pi terminal input observer, not a second stdin reader');
  assert.ok(!pointerWrites.includes('\x1b[16t'), 'Pi owns the cell-size query at terminal startup');
  editor.setAutocompleteProvider(autocomplete(native));
  editor.focused = true;
  for (const char of '123 /') editor.handleInput(char);
  await delay(150);
  assert.ok(editor.render(100).join('\n').includes('skill:alpha'), 'typing a whitespace slash opens the real editor menu');
  editor.handleInput('\t');
  assert.equal(editor.getText(), '123 /skill:alpha ', 'completion preserves text before the cursor');
  const webUrl = 'https://example.com/a/long/path?query=value';
  editor.setText(webUrl);
  const webRows = editor.render(25).filter(line => line.includes(`\x1b]8;;${webUrl}\x07`));
  assert.ok(webRows.length >= 2, 'wrapped URLs retain the complete browser target on each row');
  editor.setText('[website](https://example.com)');
  assert.ok(editor.render(80).join('\n').includes('\x1b]8;;https://example.com\x07'), 'Markdown links in the editor expose their browser target');
  editor.setText('');
  editor.insertTextAtCursorInternal(`"${image}"`);
  assert.ok(stripTerminalSequences(editor.render(80).join('\n')).includes('[img1]'), 'Pi 0.87 image paste compacts the private insertion');
  assert.ok(!stripTerminalSequences(editor.render(80).join('\n')).includes('pi-clipboard'), 'render does not read the submit path back onto screen');
  assert.equal(editor.getText(), `"${image}"`, 'private insertion still submits the original path');
  mode = 'inline'; cleanup.refresh();
  const inlineEditor = editor.render(80);
  assert.ok(inlineEditor[0].includes('  #1'), 'thumbnail cards are inside editor, not an outer widget');
  assert.ok(!stripTerminalSequences(inlineEditor.slice(6).join('\n')).includes('[img1]'), 'inline mode shows an icon instead of the duplicate token');
  assert.ok(stripTerminalSequences(inlineEditor.slice(6).join('\n')).includes('  #1'), 'attachment icon remains in editable text');
  assert.ok(!inlineEditor.join('\n').includes('\x1b[4m'), 'inline attachment chip does not inherit the file-link underline');
  const chipRow = inlineEditor[7];
  const chipCol = stripTerminalSequences(chipRow).indexOf('');
  assert.equal(getOsc8LinkAtColumn(chipRow, chipCol), pathToFileURL(image).href, 'inline input chip retains image link for hover');
  for (let col = chipCol + 5; col < 80; col++) assert.equal(getOsc8LinkAtColumn(chipRow, col), undefined, `input outside the chip is not linked at ${col}`);
  assert.equal(editor.getText(), `"${image}"`, 'hidden token still submits the original image path');
  editor.setText(`"${image}"`);
  for (let cursor = 0; cursor < 10; cursor++) {
    const row = editor.render(80)[7];
    for (let col = 7; col < 80; col++) assert.equal(getOsc8LinkAtColumn(row, col), undefined, `cursor ${cursor} does not link blank col ${col}`);
    editor.handleInput('\x1b[D');
  }
  for (const text of [`"${image}"`, `"${image}" "${image}"`, `中文 "${image}" tail`, `"${image}"\n\nblank`]) {
    editor.setText(text);
    for (const width of [12, 25, 80]) {
      for (const [row, line] of editor.render(width).entries()) {
        const plain = stripTerminalSequences(line);
        const ranges = [...plain.matchAll(/  #\d+/g)].map(match => ({ start: visibleWidth(plain.slice(0, match.index)), end: visibleWidth(plain.slice(0, match.index + match[0].length)) }));
        for (let col = 0; col < width; col++) {
          if (!ranges.some(range => col >= range.start && col < range.end)) assert.equal(getOsc8LinkAtColumn(line, col), undefined, `inline blank/text is not linked: width ${width}, row ${row}, col ${col}`);
        }
        assert.equal(getOsc8LinkAtColumn(line + ' sentinel', visibleWidth(line) + 1), undefined, `inline row closes link before subsequent output: ${row}`);
      }
    }
  }

  // Repeated clipboard inserts have no text separators inside the native editor.
  editor.setText('');
  for (let i = 0; i < 3; i++) editor.insertTextAtCursor(image);
  await delay(30);
  assert.equal(editor.getText(), [image, image, image].join(' '), 'adjacent image nodes expand to separate attachment paths');
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  const repeatedRows = editor.render(80);
  assert.match(stripTerminalSequences(repeatedRows[0]), /#1.*#2.*#3/, 'all three repeated attachments have cards');
  assert.ok(!stripTerminalSequences(repeatedRows.join('\n')).includes('无法预览'), 'all repeated attachments load');
  assert.equal(new Set([...repeatedRows.join('').matchAll(/\x1b_G[^;]*\bi=(\d+)/g)].map(match => match[1])).size, 3, 'each duplicate has its own Kitty placement');
  const endRow = repeatedRows[7];
  const endMarker = visibleWidth(endRow.slice(0, endRow.indexOf('\x1b_pi:c\x07')));
  const lastChip = [...stripTerminalSequences(endRow).matchAll(/  #\d+/g)].at(-1);
  assert.equal(endMarker, visibleWidth(stripTerminalSequences(endRow).slice(0, lastChip.index + lastChip[0].length)), 'end caret touches the last visible chip');
  const endCol = editor.getCursor().col;
  for (const col of [endCol - 6, endCol - 12, 0]) {
    editor.handleInput('\x1b[D');
    assert.equal(editor.getCursor().col, col, 'one left press crosses exactly one image');
    const row = editor.render(80)[7];
    assert.equal(row.split('\x1b_pi:c\x07').length - 1, 1, 'image cursor marker survives exactly once');
    const markerCol = visibleWidth(row.slice(0, row.indexOf('\x1b_pi:c\x07')));
    assert.equal(markerCol, col + editor.getPaddingX(), 'caret sits directly after the previous image without token-padding gaps');
    assert.deepEqual(inverseColumns(row), [markerCol], 'only one caret cell is highlighted, never the image or trailing whitespace');
  }
  editor.handleMouse({ type: 'click', button: 'left', x: 4, y: 7, width: 80, height: 12, screenX: 4, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(editor.getCursor().col, 0, 'click inside image stays at its atomic boundary');
  editor.handleInput('\x1b[C');
  assert.equal(editor.getCursor().col, 6, 'one right press crosses one image');
  editor.handleInput('\x7f');
  assert.equal(editor.getText(), [image, image].join(' '), 'backspace removes exactly one image');
  editor.setText('');
  const thirdImage = join(dir, 'third.png');
  await writeFile(thirdImage, await readFile(image));
  for (const path of [image, secondImage, thirdImage]) editor.insertTextAtCursor(path);
  await delay(30);
  assert.match(stripTerminalSequences(editor.render(80)[0]), /#1.*#2.*#3/, 'clipboard copies with distinct temp paths all render');
  assert.ok(!stripTerminalSequences(editor.render(80).join('\n')).includes('无法预览'));
  const plainFg = theme.fg;
  theme.fg = (_key, text) => `\x1b[36m${text}\x1b[39m`;
  for (const key of ['\x1b[D', '\x1b[D', '\x1b[D', '\x1b[C', '\x1b[C', '\x1b[C']) {
    editor.handleInput(key);
    const row = editor.render(80)[7];
    const markerCol = visibleWidth(row.slice(0, row.indexOf('\x1b_pi:c\x07')));
    assert.deepEqual(inverseColumns(row), [markerCol], 'colored chips keep a single caret in both directions, including end of input');
    assert.equal(stripTerminalSequences(sliceByColumn(row, markerCol, 1)), ' ', 'image insertion caret occupies a gap, not a label');
    assertChipColors(row);
    assert.match(stripTerminalSequences(row), /^ *  #1   #2   #3/, 'adjacent images have exactly one insertion cell between chips');

  }
  editor.handleInput('\x1b[D');
  const cursorTui = new TuiAltScreen(terminal);
  cursorTui.addChild(editor);
  cursorTui.start(); cursorTui.renderNow();
  const composed = cursorTui.previousScreen.filter(row => stripTerminalSequences(row).includes('  #1') && stripTerminalSequences(row).includes('  #3') && !row.includes('╭'));
  assert.equal(composed.length, 1, 'real compositor retains the input chip row');
  assert.deepEqual(inverseColumns(composed[0]), [editor.getCursor().col + editor.getPaddingX()], 'real fullscreen output puts the caret directly after the second image');
  assertChipColors(composed[0]);
  for (let i = 0; i < 2; i++) {
    editor.handleInput('\x1b[D');
    cursorTui.invalidate(); cursorTui.renderNow();
    const row = cursorTui.previousScreen.find(row => stripTerminalSequences(row).includes('  #1') && stripTerminalSequences(row).includes('  #3') && !row.includes('╭'));
    assertChipColors(row);
    assert.deepEqual(inverseColumns(row), [editor.getCursor().col + editor.getPaddingX()], 'fullscreen cursor before a chip does not alter its color or width');
  }
  editor.handleInput('\x1b[C'); editor.handleInput('\x1b[C');
  cursorTui.stop();
  editor.handleInput('\x1b[C');
  theme.fg = plainFg;
  for (const width of [12, 25, 80]) {
    editor.render(width);
    for (let i = 0; i < 3; i++) {
      editor.handleInput('\x1b[D');
      const rendered = editor.render(width).join('\n');
      assert.equal(rendered.split('\x1b_pi:c\x07').length - 1, 1, 'wrapped atomic images retain one hardware cursor');
      const cursorRow = rendered.split('\n').find(row => row.includes('\x1b_pi:c\x07'));
      assert.equal(inverseColumns(cursorRow).length, 1, 'wrapped cursor never highlights a whole row');
    }
    for (let i = 0; i < 3; i++) editor.handleInput('\x1b[C');
  }
  // Numbered chips grow with their native markers, including #9 -> #10.
  while (editor.imageAttachments.size < 12) {
    const path = join(dir, `numbered-${editor.imageAttachments.size + 1}.png`);
    await writeFile(path, await readFile(image));
    editor.insertTextAtCursor(path);
  }
  editor.setText('');
  for (const number of [9, 10, 11]) editor.insertTextAtCursor(editor.imageAttachments.get(`[img${number}]`));
  await delay(30);
  theme.fg = (_key, text) => `\x1b[36m${text}\x1b[39m`;
  for (const expectedCol of [20, 13, 6, 0]) {
    assert.equal(editor.getCursor().col, expectedCol);
    const row = editor.render(80)[7];
    assert.match(stripTerminalSequences(row), /^ *  #9   #10   #11/, 'two-digit chips do not add artificial gaps');
    assertChipColors(row);
    assert.deepEqual(inverseColumns(row), [expectedCol + editor.getPaddingX()]);
    editor.handleInput('\x1b[D');
  }
  const numberedRow = editor.render(80)[7];
  const thirdCol = stripTerminalSequences(numberedRow).indexOf('  #11');
  editor.handleMouse({ type: 'click', button: 'left', x: thirdCol + 2, y: 7, width: 80, height: 12, screenX: thirdCol + 2, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(editor.getCursor().col, 13, 'clicking the third compact chip uses the same native coordinates');
  assert.equal(getOsc8LinkAtColumn(numberedRow, thirdCol), pathToFileURL(editor.imageAttachments.get('[img11]')).href);
  const beforeUndo = editor.getText();
  editor.handleInput('\x7f');
  editor.handleInput('\x1f');
  assert.equal(editor.getText(), beforeUndo, 'undo preserves compact attachment markers and source paths');
  theme.fg = plainFg;
  setCapabilities({ images: null, hyperlinks: true, trueColor: false });

  editor.setText('');
  editor.insertTextAtCursor(image);
  editor.handleInput(' ');
  const spacedRow = editor.render(80)[7];
  const spacedCaret = visibleWidth(spacedRow.slice(0, spacedRow.indexOf('\x1b_pi:c\x07')));
  assert.equal(spacedCaret, editor.getCursor().col + editor.getPaddingX(), 'explicitly typed spaces still occupy editable positions');

  editor.setText(`说明 "${image}" 更多文字`);
  const beforeClick = editor.getText();
  editor.render(80);
  editor.handleMouse({ type: 'click', button: 'left', x: 8, y: 7, width: 80, height: 12, screenX: 8, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(editor.getText(), beforeClick, 'card rows do not move the text cursor or edit the draft');
  editor.render(80);
  editor.handleMouse({ type: 'move', button: 'none', x: 9, y: 7, width: 80, height: 12, screenX: 9, screenY: 7, ctrl: false, alt: false, shift: false });
  await delay(30);
  assert.equal(overlays[0].options.visible(), true, 'inline input chip hover opens image preview');
  assert.ok(overlays[0].options.col >= 16 || overlays[0].options.row >= 8, 'inline hover popup stays clear of the thumbnail band');
  const visibleChipRow = stripTerminalSequences(editor.render(80)[7]);
  const chipEnd = visibleWidth(visibleChipRow.slice(0, visibleChipRow.indexOf(''))) + visibleWidth('  #1');
  editor.handleMouse({ type: 'move', button: 'none', x: chipEnd, y: 7, width: 80, height: 12, screenX: chipEnd, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(overlays[0].options.visible(), false, 'invisible token padding is not an image hover target');

  editor.handleMouse({ type: 'move', button: 'none', x: 60, y: 7, width: 80, height: 12, screenX: 60, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(overlays[0].options.visible(), false, 'moving across empty input space closes image preview');
  editor.handleMouse({ type: 'click', button: 'left', x: 60, y: 7, width: 80, height: 12, screenX: 60, screenY: 7, ctrl: false, alt: false, shift: false });
  assert.equal(overlays[0].options.visible(), false, 'clicking empty input space does not open image preview');
  tui.previousScreen[23] = linkMessageFiles(`"${image}"`, dir);
  terminalInput('\x1b[<35;3;24M');
  await delay(30);
  assert.equal(overlays[0].options.visible(), true, 'sent chip hover opens image preview in inline mode');
  mode = 'hover'; cleanup.refresh();
  editor.setText(`"${image}" tail`);
  for (let i = 0; i < 6; i++) editor.handleInput('\x1b[D');
  await delay(30);
  const rows = editor.render(25);
  assert.ok(rows.join('\n').includes(pathToFileURL(image).href), 'image chip links to actual file');
  assert.ok(stripTerminalSequences(rows.join('\n')).includes('[img1]'));
  assert.equal(editor.getText(), `"${image}" tail`, 'external reads and reload retain the real attachment');
  assert.ok(!rows.join('\n').includes('\x1b[4m'), 'image chip is not underlined');
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
  const initialPosition = { row: overlays[0].options.row, col: overlays[0].options.col };
  const initialRenders = renders;
  tui.previousScreen[23] = 'overlay temporarily obscures the link';
  terminalInput('\x1b[<35;4;24M');
  assert.equal(overlays[0].options.visible(), true, 'moving within the original label keeps preview despite overlay redraw');
  assert.deepEqual({ row: overlays[0].options.row, col: overlays[0].options.col }, initialPosition, 'hover position stays at its first appearance');
  assert.equal(renders, initialRenders, 'same-label movement does not re-render or flash the image');
  tui.previousScreen[23] = linkMessageFiles(`"${image}"                  "${image}"`, dir);
  const duplicateCol = stripTerminalSequences(tui.previousScreen[23]).lastIndexOf('') + 1;
  terminalInput(`\x1b[<35;${duplicateCol};24M`);
  assert.ok(overlays[0].options.col > initialPosition.col, 'another occurrence of the same file anchors at the newly hovered label');
  terminalInput('\x1b[<35;90;24M');
  assert.equal(overlays[0].options.visible(), false, 'leaving link clears preview');
  assert.equal(pointerWrites.at(-1), '\x1b]22;default\x07');
  terminalInput('\x1b[<35;3;24M');
  await delay(30);
  terminalInput('\x1b[O');
  assert.equal(overlays[0].options.visible(), false, 'losing terminal focus dismisses hover');
  let submitted;
  editor.onSubmit = text => { submitted = text; };
  editor.handleInput('\r');
  assert.equal(submitted, `"${image}" tail`, 'submit expands image chips to paths');
  editor.addToHistory(`"${image}" tail`);
  editor.setText('');
  editor.handleInput('\x1b[A');
  assert.ok(stripTerminalSequences(editor.render(80).join('\n')).includes('[img1]'), 'up-arrow history restores a compact image chip');
  assert.equal(editor.getText(), `"${image}" tail`, 'history chip still submits the image path');
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
    assert.equal(!!getOsc8LinkAtColumn(linkedRow, col), col >= 8 && col < 14, `only image label is linked at column ${col}`);
  }
  editor.setText(`中文 before "${image}" middle "${image}" after`);
  for (const width of [12, 25, 100]) {
    for (const row of editor.render(width)) {
      const text = stripTerminalSequences(row);
      const ranges = [...text.matchAll(/\[img\d+\]/g)].map(match => ({ start: Array.from(text.slice(0, match.index)).reduce((n, c) => n + (/[^\u0000-\u00ff]/.test(c) ? 2 : 1), 0), length: match[0].length }));
      for (let col = 0; col < width; col++) assert.equal(!!getOsc8LinkAtColumn(row, col), ranges.some(range => col >= range.start && col < range.start + range.length), `wrapped CJK label only: width ${width}, column ${col}`);
    }
  }
  editor.setText('');
  editor.insertTextAtCursorInternal(spacedImage);
  assert.equal(editor.getText(), spacedImage, 'space-containing clipboard image still submits the complete path');
  assert.match(stripTerminalSequences(editor.render(120).join('\n')), /\[img\d+\]/, 'space-containing clipboard image is one token');
  editor.setText('');
  editor.handleInput(`\x1b[200~${escapedPair}\x1b[201~`);
  assert.equal(editor.getText(), escapedPair, 'bracketed Raycast paste preserves paths for submission');
  assert.ok(!stripTerminalSequences(editor.render(120).join('\n')).includes('Application'), 'complete escaped paths compact without a leftover prefix');
  editor.handleInput('\r');
  assert.equal(submitted, escapedPair, 'submitting never truncates a shell-escaped source path');
  editor.setText(`"${raycastImage}" ${escapedImage}`);
  assert.equal(editor.getText(), `"${raycastImage}" ${escapedImage}`, 'the same image keeps each original quoting form');
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  tui.imageProtocol = null;
  editor.render(80);
  assert.equal(tui.imageProtocol, null, 'extension must not rewrite host protocol state');
  cleanup();
  assert.equal(factory, undefined);
  assert.equal(terminalInput, undefined);
  assert.equal(overlays[0].hidden, true);
  // Hold image reads to exercise deletion/re-add, cancellation and reload without timing races.
  const nativeOpen = fs.open;
  const pendingReads = [];
  const bytes = Buffer.from(png, 'base64');
  const slowImage = join(dir, 'slow.png');
  let closedReads = 0;
  fs.open = (path, ...args) => path === slowImage ? new Promise(resolve => pendingReads.push(() => resolve({
    stat: async () => ({ isFile: () => true, size: bytes.length }),
    read: async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, position + length) }),
    close: async () => { closedReads++; },
  }))) : nativeOpen(path, ...args);
  syncBuiltinESMExports();
  const asyncPi = { ...pi };
  let asyncCleanup;
  try {
    mode = 'inline'; enabled = true;
    asyncCleanup = installInputEnhancements(asyncPi, ctx, () => enabled, () => mode);
    editor.setText(slowImage);
    assert.equal(pendingReads.length, 1);
    editor.setText(''); editor.setText(slowImage);
    assert.equal(pendingReads.length, 2, 're-adding a removed path starts a new read');
    let before = renders;
    pendingReads.shift()(); await delay(0);
    assert.equal(renders, before, 'old completion cannot render or replace a newer pending read');
    assert.ok(editor.render(80).join('').includes('加载中'));
    pendingReads.shift()(); await delay(0);
    assert.ok(editor.render(80).join('').includes('\x1b_Ga=T'), 'current read becomes visible');
    const owned = graphicIds(editor.render(80).join(''));
    pointerWrites.length = 0;
    enabled = false; asyncCleanup.refresh();
    assert.deepEqual(deletedIds(pointerWrites.join('')), owned, 'disabling enhancement releases mounted thumbnails immediately');
    enabled = true; asyncCleanup.refresh();
    assert.equal(pendingReads.length, 1);
    asyncCleanup();
    before = renders;
    pendingReads.shift()(); await delay(0);
    assert.equal(renders, before, 'late image completion does not render after cleanup');
    assert.equal(terminalInput, undefined);

    asyncCleanup = installInputEnhancements(asyncPi, ctx, () => enabled, () => mode);
    editor.setText(slowImage);
    assert.equal(pendingReads.length, 1);
    asyncCleanup();
    ctx.sessionManager = {};
    asyncCleanup = installInputEnhancements(asyncPi, ctx, () => enabled, () => mode);
    editor.setText(slowImage);
    assert.equal(pendingReads.length, 2);
    before = renders;
    pendingReads.shift()(); await delay(0);
    assert.equal(renders, before, 'pre-reload promise cannot consume the new session\'s read');
    assert.ok(editor.render(80).join('').includes('加载中'));
    pendingReads.shift()(); await delay(0);
    const mountedIds = graphicIds(editor.render(80).join(''));
    assert.equal(mountedIds.length, 1);
    pointerWrites.length = 0;
    asyncCleanup();
    assert.deepEqual(deletedIds(pointerWrites.join('')), mountedIds, 'shutdown frees the mounted owned image');
    const afterCleanup = pointerWrites.length;
    asyncCleanup();
    assert.equal(pointerWrites.length, afterCleanup, 'cleanup is idempotent');
    assert.equal(closedReads, 5, 'all completed file reads close, even when discarded');
    mode = 'hover';
    asyncCleanup = installInputEnhancements(asyncPi, ctx, () => enabled, () => mode);
    editor.setText(slowImage); editor.handleInput('\x1b[D');
    assert.equal(pendingReads.length, 1);
    const beforeOverlays = overlays.length;
    asyncCleanup(); before = renders;
    pendingReads.shift()(); await delay(0);
    assert.equal(overlays.length, beforeOverlays, 'late hover read cannot recreate a shutdown overlay');
    assert.equal(renders, before);
    assert.equal(closedReads, 6);
  } finally {
    asyncCleanup?.();
    fs.open = nativeOpen;
    syncBuiltinESMExports();
  }

  // Real fullscreen mouse dispatch must reach history before the native consuming listener.
  let sendInput;
  const liveTerminal = { ...terminal, start: fn => { sendInput = fn; }, write: text => { ansi += text; } };
  const live = new TuiAltScreen(liveTerminal);
  const originalViewport = live.handleViewportInput;
  const history = new Text(linkMessageFiles(`"${image}" tail`, dir), 0, 0);
  live.addChild(history);
  live.start();
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  const stdinListeners = process.stdin.listenerCount('data');
  const liveCtx = { ...ctx, sessionManager: {}, ui: { ...ctx.ui,
    getEditorComponent: () => undefined,
    setEditorComponent: value => { if (value) value(live, { borderColor: t => t, selectList: {} }, { matches: () => false }); },
    onTerminalInput: fn => live.addInputListener(fn),
  } };
  const stop = installInputEnhancements({ ...pi }, liveCtx, true);
  assert.equal(process.stdin.listenerCount('data'), stdinListeners, 'extension installs no stdin readers');
  const unhandled = [];
  live.setFocus({ render: () => [], invalidate() {}, handleInput: data => unhandled.push(data) });
  // Feed the real ProcessTerminal framing route without starting raw stdin or emitting probes.
  const keyboardProtocol = isKittyProtocolActive();
  const inputTerminal = new ProcessTerminal();
  inputTerminal.inputHandler = sendInput;
  inputTerminal.setupStdinBuffer();
  try {
    inputTerminal.stdinBuffer.process('x\x1b[?');
    inputTerminal.stdinBuffer.process('1u\x1b[?1;2c\x1b[6;24;');
    inputTerminal.stdinBuffer.process('12t');
    assert.deepEqual(unhandled, ['x'], 'native keyboard/DA/cell replies never reach the editor');
    assert.deepEqual(getCellDimensions(), { widthPx: 12, heightPx: 24 }, 'Pi owns the shared cell-size response');
    inputTerminal.stdinBuffer.process('\x1b[200~paste\x1b[201~\x1b[D\x1b[<35;75;1M');
    assert.deepEqual(unhandled, ['x', '\x1b[200~paste\x1b[201~', '\x1b[D'], 'typing, bracketed paste and arrows remain intact; mouse follows the host route');
  } finally {
    inputTerminal.clearKeyboardProtocolNegotiationBuffer();
    inputTerminal.stdinBuffer.destroy();
    setKittyProtocolActive(keyboardProtocol);
    setCellDimensions(originalCells);
  }
  live.renderNow();
  ansi = '';
  sendInput('\x1b[<35;3;1M');
  await delay(40);
  live.renderNow();
  assert.ok(ansi.includes(png + '\x1b\\'), 'real history hover emits complete image, not just a path');
  assert.ok(live.previousScreen.some(line => stripTerminalSequences(line).includes('╭')), 'preview has a visible frame');
  assert.ok(!live.previousScreen.slice(1).some(line => stripTerminalSequences(line).includes(image)), 'no path caption');
  const hoverImageId = /\x1b_G[^;]*\bi=(\d+)/.exec(ansi)?.[1];
  assert.ok(hoverImageId, 'hover placement owns a Kitty image id');
  ansi = '';
  setCapabilities({ images: null, hyperlinks: true, trueColor: true });
  live.renderNow(); live.renderNow(); // A changed image size schedules the overlay's new bounds.
  assert.ok(ansi.includes(`\x1b_Ga=d,d=I,i=${hoverImageId},q=2\x1b\\`), 'capability disable frees the active hover image');
  assert.ok(live.previousScreen.some(line => stripTerminalSequences(line).includes('终端未能')), 'disabled hover downgrades to a note');
  assert.ok(!ansi.includes('\x1b_Ga=T'), 'disabled hover cannot emit a stale Kitty payload');
  setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
  ansi = ''; live.renderNow();
  const restoredHoverId = /\x1b_G[^;]*\bi=(\d+)/.exec(ansi)?.[1];
  assert.ok(restoredHoverId && restoredHoverId !== hoverImageId, 'restored capability rebuilds hover with a new owned image');
  live.imageProtocol = null; // Owned-image cleanup must not depend on private host protocol fields.
  ansi = '';
  sendInput('\x1b[<35;75;1M');
  await delay(40);
  live.renderNow();
  assert.ok(!live.previousScreen.some(line => stripTerminalSequences(line).includes('╭')), 'moving outside label dismisses preview');
  assert.ok(ansi.includes(`\x1b_Ga=d,d=I,i=${restoredHoverId},q=2\x1b\\`), 'leaving hover deletes the actual image without relying on host state');
  const stale = () => { throw new Error('This extension context is stale after session replacement/reload.'); };
  Object.defineProperties(liveCtx, {
    ui: { get: stale, configurable: true },
    cwd: { get: stale, configurable: true },
    hasUI: { get: stale, configurable: true },
    mode: { get: stale, configurable: true },
    sessionManager: { get: stale, configurable: true },
  });
  const nextCtx = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: {}, ui: {
    theme, notify() {}, setWidget() {}, addAutocompleteProvider() {},
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
  assert.equal(process.stdin.listenerCount('data'), stdinListeners, 'reload/shutdown leave stdin untouched');

  // /reload reports the saved factory while the focused editor is the unwrapped one Pi restores after the reload box.
  const reloadCtx = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: {}, ui: {
    theme, notify() {}, setWidget() {}, addAutocompleteProvider() {}, getEditorComponent: () => undefined,
    setEditorComponent(value) { this.factory = value; }, onTerminalInput() { return () => {}; },
  } };
  const reload = installInputEnhancements({ ...pi }, reloadCtx, true);
  reloadCtx.ui.getEditorComponent = () => reloadCtx.ui.factory;
  const bare = reloadCtx.ui.factory(live, { borderColor: t => t, selectList: {} }, { matches: () => false });
  installInputEnhancements({ ...pi }, reloadCtx, true);
  const restored = reloadCtx.ui.factory(live, { borderColor: t => t, selectList: {} }, { matches: () => false });
  restored.insertTextAtCursor(image);
  assert.notEqual(restored, bare, 'reload creates a fresh wrapped editor');
  assert.ok(stripTerminalSequences(restored.render(80).join('\n')).includes('[img1]'), 'editor restored after reload compacts pasted images');
  reload();
  live.stop();
} finally {
  for (const key of capabilityEnv) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  setCapabilityOverrides({}); resetCapabilitiesCache();
  await rm(dir, { recursive: true, force: true });
}
console.log('input enhancements self-check passed');
