import assert from 'node:assert/strict';
import Module, { registerHooks } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { stripVTControlCharacters as plain } from 'node:util';
const stub = `data:text/javascript,${encodeURIComponent(`
export const CONFIG_DIR_NAME = '.pi';
export const getAgentDir = () => '.pi';
export const SettingsManager = { create: () => ({ drainErrors: () => [], getProjectSettings: () => ({}), setTheme() {}, setTuiMode() {}, async flush() {} }) };
export const getMarkdownTheme = () => Object.fromEntries(['heading','link','linkUrl','code','codeBlock','codeBlockBorder','quote','quoteBorder','hr','listBullet','bold','italic','strikethrough','underline'].map(key => [key, text => text]));
export const getSettingsListTheme = () => ({});
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-coding-agent') return { shortCircuit: true, url: stub };
    return nextResolve(specifier, context);
  },
});
const { Container, Text, TuiAltScreen, ScrollView, VStack, HStack, visibleWidth, setCapabilities } = await import('@earendil-works/pi-tui');
const { getLayoutNode } = await import('@earendil-works/pi-tui/dist/layout-node.js');
const { minimalOutputComponent } = await import('../extensions/footer-status.ts');
const { attachTranscript } = await import('../lib/transcript-adapter.ts');
const { attachAgentWidgets } = await import('../lib/agent-view.ts');
const { attachStickyTool } = await import('../lib/sticky-tool.ts');
setCapabilities({ images: null, trueColor: true, hyperlinks: true });
const theme = { bg: (_, text) => text, fg: (_, text) => text, bold: text => text };
const calls = ['first', 'second'].map(id => ({ id, name: 'bash', task: `${id}-command`, state: 'done', output: Array.from({ length: 70 }, (_, i) => `${id}_${i} 中文 👩‍💻`).join('\n') }));
const turn = { question: 'question\n\n' + 'prompt '.repeat(100), process: ['call first', 'call second'], agentCalls: calls,
  subAgents: [{ runId: 'child', mode: 'single', state: 'completed', steps: [{ agent: 'worker', status: 'completed', recentOutput: ['UNSAFE_ACTIVITY'], finalOutput: 'CHILD_DETAIL\n'.repeat(30) }] }], final: '' };
const view = minimalOutputComponent(theme, () => [turn]);
const document = new Container();
const header = new Container(); header.addChild(new Text('HEADER\nRESOURCE', 0, 0));
for (const c of [header, new Container(), new Container()]) document.addChild(c);
const docks = Array.from({ length: 6 }, () => new Container());
const editor = new Text('EDITOR\nEDITOR', 0, 0); docks[3].addChild(editor);
let input, copied, opened;
const terminal = { columns: 80, rows: 24, start(fn) { input = fn; }, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: async text => { copied = text; return true; }, openUrl: url => { opened = url; } });
for (const c of [document, ...docks]) tui.addChild(c);
const scroll = new ScrollView(document, { follow: 'end', primary: true, scrollbar: 'always' });
const dockLayout = new VStack(docks.map(component => ({ component, shrink: 1, minSize: 0 })));
const originalRoot = new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }, { component: dockLayout, basis: 'auto', shrink: 0 }]);
tui.setLayoutRoot(originalRoot);
const restoreWidgets = attachAgentWidgets(tui, theme, () => false, undefined, true);
const restore = attachTranscript(tui, view);
assert.equal(getLayoutNode(getLayoutNode(tui.layoutRoot).entries[0].component).entries[1].component, scroll);
assert.equal(getLayoutNode(tui.layoutRoot).entries[1].component, dockLayout);
tui.start();
const paint = async () => { tui.requestRender(); await wait(45); };
const mouse = (code, x, y, release = false) => input(`\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
const click = (x, y) => { mouse(0, x, y); mouse(0, x, y, true); };
const screen = () => tui.previousScreen.map(plain);
const docRows = () => document.render(scroll.getContentWidth(terminal.columns)).map(plain);
const toolY = id => view.toolChoices().find(c => c.id === id).y + 2;
const pinned = id => assert.match(screen()[0], new RegExp(`▾ bash ${id}-command`));
try {
  await paint(); scroll.scrollToEnd(); await paint();
  assert.equal(scroll.isFollowingEnd, true);
  const openingTop = scroll.scrollTop;
  click(3, toolY('first') - openingTop); await paint();
  assert.equal(scroll.scrollTop, openingTop, 'opening at follow-end keeps the clicked viewport');
  assert.equal(scroll.isFollowingEnd, false, 'opening disables follow-end before content grows');
  assert.doesNotMatch(screen()[0], /▾ bash/, 'no premature sticky row');
  assert.match(docRows().join('\n'), /first_69/, 'full detail expanded inline');
  scroll.scrollTo(toolY('first') + 1); await paint(); pinned('first');
  assert.match(screen()[1], /first_0/, 'sticky row never overwrites the first detail');
  const wheelTop = scroll.scrollTop;
  mouse(65, 8, 0); await paint(); pinned('first');
  assert.ok(scroll.scrollTop > wheelTop, 'wheel over heading scrolls content');
  mouse(0, 5, 1); mouse(32, 16, 1); mouse(0, 16, 1, true); await paint();
  assert.match(copied, /first_/, 'native copy still selects the correct detail row');
  await wait(1600); // Let Pi's native clipboard flash leave the top row.
  const readingTop = scroll.scrollTop;
  calls[0].output += '\nSTREAM_GROWTH\n'.repeat(15); await paint();
  assert.equal(scroll.scrollTop, readingTop, 'stream growth preserves manual reading position');
  scroll.scrollTo(toolY('first')); await paint();
  assert.match(screen()[1], /first_0/, 'at original heading there is no duplicate');
  scroll.scrollTo(0); await paint();
  assert.doesNotMatch(screen()[0], /▾ bash/);
  scroll.scrollTo(toolY('first') + 5); await paint(); pinned('first');
  scroll.scrollTo(toolY('second') - 3); await paint();
  const switchTop = scroll.scrollTop;
  click(3, toolY('second') - switchTop + 1); await paint();
  assert.equal(scroll.scrollTop, switchTop, 'switching expanded tools does not jump');
  assert.doesNotMatch(screen()[0], /▾ bash/, 'new heading stays inline until scrolled past');
  assert.equal(view.toolChoices().filter(c => c.expanded).length, 2);
  scroll.scrollTo(toolY('second') + 1); await paint(); pinned('second');
  for (const width of [20, 8, 4, 80]) {
    terminal.columns = width; await paint();
    const headerHeight = header.render(scroll.getContentWidth(width)).length;
    scroll.scrollTo(view.pinnedTool().y + headerHeight + 1); await paint();
    assert.ok(screen().every(row => visibleWidth(row) <= width));
    assert.match(screen()[0], /▾/);
  }
  for (const rows of [45, 18, 32, 24]) {
    terminal.rows = rows; await paint(); pinned('second');
  }
  editor.setText('ONE_ROW_DOCK'); await paint(); pinned('second');
  turn.final = '[BODY_LINK](https://example.com)\n\n' + 'tail\n'.repeat(35); await paint();
  scroll.scrollTo(docRows().findIndex(row => row.includes('BODY_LINK'))); await paint(); pinned('second');
  click(1, 1); await paint(); assert.equal(opened, 'https://example.com');
  opened = undefined; click(20, 0); await paint();
  assert.equal(opened, undefined, 'sticky collapse cannot click underlying link');
  assert.equal(view.toolChoices().find(c => c.id === 'second').expanded, false);
  view.toggleTool('first'); await paint();
  scroll.scrollTo(0); await paint();
  const childY = () => docRows().findIndex(row => row.includes('SubAgent'));
  click(3, childY()); await paint();
  assert.equal(scroll.scrollTop, 0, 'SubAgent also opens in place');
  assert.match(docRows().join('\n'), /CHILD_DETAIL/);
  scroll.scrollTo(childY() + 1); await paint(); assert.match(screen()[0], /SubAgent/);
  click(12, 0); await paint(); assert.equal(view.pinnedSubagent(), undefined);
  const live = turn.subAgents[0];
  live.state = 'running';
  live.steps[0].status = 'running';
  live.steps[0].currentTool = 'bash';
  live.steps[0].currentToolArgs = 'npm test ' + '中文👩‍💻é <literal> **args** '.repeat(12) + 'LIVE_END';
  turn.final = ''; await paint();
  scroll.scrollToEnd(); await paint();
  const liveTop = scroll.scrollTop;
  click(3, childY() - liveTop); await paint();
  assert.equal(scroll.scrollTop, liveTop, 'running SubAgent opens without jumping');
  assert.match(screen().join('\n'), /● bash npm test/, 'real SGR click reveals the current tool in the viewport');
  assert.match(docRows().join('\n'), /…/, 'tool process stays on one truncated line');
  assert.doesNotMatch(docRows().join('\n'), /LIVE_END/, 'overflowing tool arguments are not dumped as a wrapped paragraph');
  assert.match(docRows().join('\n'), /<literal> \*\*args\*\*/, 'tool arguments stay literal');
  assert.doesNotMatch(docRows().join('\n'), /CHILD_DETAIL|UNSAFE_ACTIVITY/, 'running attempt hides stale finals and raw previews');
  live.steps[0].currentToolArgs = 'npm run check'; await paint();
  assert.match(screen().join('\n'), /● bash npm run check/, 'expanded live activity refreshes');
  click(3, childY() - scroll.scrollTop); await paint();
  assert.doesNotMatch(docRows().join('\n'), /当前活动|● bash npm run check/, 'second real click collapses a running SubAgent');
  click(3, childY() - scroll.scrollTop); await paint();
  live.state = 'completed'; live.steps[0].finalOutput = 'NEW_FINAL'; await paint();
  assert.match(screen().join('\n'), /NEW_FINAL/, 'completion replaces activity while staying expanded');
  assert.doesNotMatch(docRows().join('\n'), /当前活动/);
  click(3, childY() - scroll.scrollTop); await paint();
  turn.final = ''; calls[1].output = 'SHORT_RESULT'; await paint();
  scroll.scrollToEnd(); await paint();
  const shortTop = scroll.scrollTop;
  click(3, toolY('second') - shortTop); await paint();
  assert.equal(scroll.scrollTop, shortTop, 'short result opens without alignment or padding');
  assert.match(docRows().join('\n'), /SHORT_RESULT/);
  assert.ok(docRows().length < terminal.rows, 'no artificial terminal-height tail');
  calls[1].output += '\nLIVE_B\n'.repeat(40); await paint();
  assert.equal(scroll.scrollTop, shortTop, 'short result streaming does not steal viewport');
  scroll.scrollTo(toolY('second') + 1); await paint(); pinned('second');
  click(12, 0); await paint();
  scroll.scrollToEnd(); await paint();
  const oldEnd = scroll.scrollTop;
  turn.final = 'NORMAL_STREAM\n'.repeat(60); await paint();
  assert.equal(scroll.isFollowingEnd, true);
  assert.ok(scroll.scrollTop > oldEnd, 'ordinary streaming follow-end remains intact');
} finally { restore(); restoreWidgets(); tui.stop(); }
assert.equal(tui.layoutRoot, originalRoot);
for (const dock of docks) assert.equal(Object.hasOwn(dock, 'handleMouse'), false);
for (const root of [new HStack([scroll]), new VStack([scroll, new ScrollView(new Text('other'), { primary: true })])]) {
  tui.setLayoutRoot(root);
  const fallback = attachTranscript(tui, view);
  assert.ok(fallback); assert.equal(tui.layoutRoot, root);
  document.render(80); view.toggleTool('first');
  assert.match(document.render(80).join('\n'), /first_69/);
  view.toggleTool('first'); fallback();
}
assert.equal(attachStickyTool({ mode: 'fullscreen' }, document, view), undefined);
tui.setLayoutRoot(originalRoot);
const originalLoad = Module._load;
try {
  Module._load = function (specifier, ...args) {
    if (specifier === '@earendil-works/pi-tui/dist/layout-node.js') throw new Error('optional API missing');
    return originalLoad.call(this, specifier, ...args);
  };
  const fallback = attachTranscript(tui, view);
  assert.ok(fallback); assert.equal(tui.layoutRoot, originalRoot);
  view.toggleTool('first'); assert.match(document.render(80).join('\n'), /first_69/);
  view.toggleTool('first'); fallback();
} finally { Module._load = originalLoad; }
console.log('Sticky tool PASS: inline expansion, follow-end/manual viewport preservation, scroll-only sticky headings, click collapse, copy/links, resize, streaming, restore and fallback.');
