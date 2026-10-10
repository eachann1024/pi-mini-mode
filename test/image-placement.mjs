import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Container, Image, ScrollView, Text, TuiAltScreen, VStack, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { initTheme, getThemeByName } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { commitImageCursor } from '../lib/image-placement.ts';
import { attachTranscript } from '../lib/transcript-adapter.ts';
import { minimalOutputComponent } from '../extensions/footer-status.ts';
initTheme('dark', false);

// Model Otty's committed cursor separately from DEC 2026 buffered text motion.
function placements(ansi, staleCursor = true) {
  let synchronized = false, pending = [], row = 0, col = 0;
  const images = [];
  const apply = text => {
    const csi = /^\x1b\[(\d*(?:;\d*)*)([HABCDG])$/.exec(text);
    if (!csi) { if (!text.startsWith('\x1b')) col += visibleWidth(text); return; }
    const [n, m] = csi[1].split(';').map(Number);
    if (csi[2] === 'H') { row = (n || 1) - 1; col = (m || 1) - 1; }
    if (csi[2] === 'A') row -= n || 1;
    if (csi[2] === 'B') row += n || 1;
    if (csi[2] === 'C') col += n || 1;
    if (csi[2] === 'D') col -= n || 1;
    if (csi[2] === 'G') col = (n || 1) - 1;
  };
  for (const token of ansi.matchAll(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]][^\x07\x1b]*(?:\x07|\x1b\\))|[^\x1b]+/g)) {
    const text = token[0];
    if (/^\x1b_Ga=[Tp]/.test(text)) { images.push({ row, col }); continue; }
    if (staleCursor && text === '\x1b[?2026h') { synchronized = true; continue; }
    if (staleCursor && text === '\x1b[?2026l') { synchronized = false; pending.forEach(apply); pending = []; continue; }
    if (synchronized) pending.push(text); else apply(text);
  }
  return images;
}

const savedEnv = Object.fromEntries(['TERM_PROGRAM', 'TERM', 'TMUX', 'STY'].map(key => [key, process.env[key]]));
process.env.TERM_PROGRAM = 'otty';
process.env.TERM = 'xterm-256color';
delete process.env.TMUX;
delete process.env.STY;
setCapabilities({ images: 'kitty', hyperlinks: true, trueColor: true });
let ansi = '';
const terminal = { columns: 100, rows: 40, start() {}, stop() {}, hideCursor() {}, showCursor() {}, write(text) { ansi += text; } };
const tui = new TuiAltScreen(terminal);
let restore;
try {
  const png = (await readFile(new URL('../assets/pi-mini-mode-hero.png', import.meta.url))).toString('base64');
  const image = new Image(png, 'image/png', { fallbackColor: text => text }, { maxWidthCells: 40, maxHeightCells: 12 });
  class UserMessageComponent extends Text {}
  class ToolExecutionComponent extends Container { toolCallId = 'photo'; imageComponents = [image]; }
  const document = new Container(), chat = new Container();
  chat.addChild(new UserMessageComponent('QUESTION', 0, 0));
  chat.addChild(new ToolExecutionComponent());
  for (const child of [new Container(), new Container(), chat]) document.addChild(child);
  const path = new URL('../assets/pi-mini-mode-hero.png', import.meta.url).pathname;
  const turn = { question: 'QUESTION', process: ['call photo', 'output AFTER IMAGE'], final: `BEFORE\n![result](${path})\nFINAL`, agentCalls: [{ id: 'photo', name: 'read', task: path, state: 'done' }] };
  let ready;
  const loaded = new Promise(resolve => { ready = resolve; });
  const view = minimalOutputComponent(getThemeByName('dark'), () => [turn], undefined, undefined, undefined, undefined, undefined, undefined, { cwd: () => process.cwd(), requestRender: () => { tui.requestRender(); ready(); } });
  tui.children = [document, ...Array.from({ length: 6 }, () => new Container())];
  restore = attachTranscript(tui, view, { turnCount: () => 1 });
  const scroll = new ScrollView(document, { primary: true, follow: 'start' });
  tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1 }, { component: new Text('INPUT DOCK', 0, 0), basis: 2, shrink: 0 }]));
  tui.start();
  tui.renderNow();
  await loaded;
  ansi = ''; tui.renderNow();
  const rows = document.render(100);
  const firstImage = rows.findIndex(line => line.includes('\x1b_G'));
  assert.ok(firstImage > rows.findIndex(line => line.includes('BEFORE')), 'tool step has no inline image; assistant reply does');
  assert.equal(rows.filter(line => line.includes('\x1b_G')).length, 1);
  assert.ok(rows.some(line => line.includes('图片 1') && line.includes('\x1b]8;;file:')), 'read path becomes a hover image chip');
  const target = tui.previousScreen.findIndex(line => line.includes('\x1b_G'));
  assert.ok(target > 0);
  assert.deepEqual(placements(ansi).at(-1), { row: target, col: 0 }, 'first upload uses the transcript cursor, not the input dock');
  assert.notDeepEqual(placements(ansi.replace(/\x1b\[\?2026l\x1b\[0m/g, '\x1b[0m')).at(-1), { row: target, col: 0 }, 'the old behavior reproduces the misplaced image');
  turn.question = 'QUESTION\nSECOND';
  ansi = ''; tui.renderNow();
  const movedTarget = tui.previousScreen.findIndex(line => line.includes('\x1b_G'));
  assert.ok(ansi.includes('\x1b_Ga=T,'), 'Otty redraw retransmits pixels after clearing placements');
  assert.ok(!ansi.includes('\x1b_Ga=p,'), 'Otty avoids the placement-only redraw that loses images');
  assert.deepEqual(placements(ansi).at(-1), { row: movedTarget, col: 0 }, 'cached placement also commits the cursor');
  terminal.rows = 10;
  tui.renderNow();
  scroll.scrollTo(movedTarget + 2, { disableFollow: true });
  ansi = ''; tui.renderNow();
  assert.ok(ansi.includes(',y='), 'scrolling into the image invokes native source cropping');
  const croppedTarget = tui.previousScreen.findIndex(line => line.includes('\x1b_G'));
  assert.equal(croppedTarget, 0, 'cropped image starts at the viewport top');
  assert.deepEqual(placements(ansi).at(-1), { row: croppedTarget, col: 0 }, 'cropped image commits its viewport cursor');
  ansi = '';
  terminal.rows = 40;
  tui.renderNow();
  scroll.scrollTo(0, { disableFollow: true });
  tui.renderNow();
  assert.ok(ansi.includes('\x1b_Ga=T,'), 'scrolling back restores the full uploaded image');
  assert.ok(!ansi.includes('\x1b_Ga=p,'));
  turn.final = 'FINAL';
  chat.clear(); chat.addChild(new UserMessageComponent('QUESTION', 0, 0));
  ansi = ''; tui.renderNow();
  assert.equal(placements(ansi).length, 0, 'no image produces no image placement');
  assert.ok(!document.render(100).some(line => line.includes('\x1b_G')));
  for (const name of ['kitty', 'ghostty', 'unknown']) {
    process.env.TERM_PROGRAM = name;
    const line = image.render(80)[0];
    assert.equal(commitImageCursor(line), line, 'other terminals retain their atomic frames');
  }
  view.dispose();
  restore(); restore = undefined;
  assert.equal(Object.hasOwn(tui, 'prepareKittyScreen'), false, 'unmount restores the host cache method');
  console.log('Image placement passed: assistant-only inline, hover step chip, upload/scroll/crop/re-entry, no-image rows and restored host cache.');
} finally {
  restore?.(); tui.stop();
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
