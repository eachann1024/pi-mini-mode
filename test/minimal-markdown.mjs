import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getThemeByName } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { minimalSurface } from '../lib/minimal-theme.ts';
import { diagramMarkdown, isFencedMarkdown, isMarkdownProse, minimalMarkdownTheme, normalizeProseMarkdown, renderMinimalMarkdown } from '../lib/minimal-markdown.ts';
const moduleUrl = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url).href;
const stub = `data:text/javascript,${encodeURIComponent(`export const CONFIG_DIR_NAME = '.pi'; export const getAgentDir = () => '.pi'; export const SettingsManager = { create: () => ({ drainErrors: () => [], getProjectSettings: () => ({}), setTheme() {}, setTuiMode() {}, async flush() {} }) }; export { getMarkdownTheme, getSettingsListTheme } from '${moduleUrl}';`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-coding-agent') return { shortCircuit: true, url: stub };
    return nextResolve(specifier, context);
  },
});
const { minimalOutputComponent, minimalTurnsFromBranch } = await import('../extensions/footer-status.ts');
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const diagram = '```mermaid\nflowchart LR\nA[Start] --> B[End]\n```';
const screenshotReply = '**Hono 完全可以接收上报；放 Java 不是技术限制，而是复用现有日志出口。 **我刚核对了 PR 的实现。\n\n现在 Java 的 `AiErrorLogController.java` 做了三件事：\n- 复用 Java 的登录会话认证；\n- 用内部 Token 接收 Agent 错误；\n- 通过现有 **KnowallLog.post** 发到日志平台。';
for (const source of [
  '`**literal。 **`', '```md\n**literal。 **\n```', '    **literal。 **\n',
  '\\*\\*literal。 \\*\\*', '[link](https://example.com/**path**)',
  '**valid** and ***nested***', '**still streaming',
  'a * b * c', 'file__name__part', '\\**literal。 **',
  '```md\n*中文。*后续\n~~中文。 ~~后续\n```',
  '[link](https://example.com/__path__ "**title。 **")',
]) assert.equal(normalizeProseMarkdown(source), source);
assert.equal(normalizeProseMarkdown('**中文。**后续'), '**中文**。后续');
assert.equal(normalizeProseMarkdown('- **中文。 **后续'), '- **中文**。 后续');
assert.equal(normalizeProseMarkdown('> **中文。 **后续'), '> **中文**。 后续');
const proseCases = [
  ['**PTY_FINAL。 **后续', '**PTY_FINAL**。 后续'],
  ['**含 `code` 的中文。 **后续', '**含 `code` 的中文**。 后续'],
  ['**含 [链接](https://example.com) 的中文。 **后续', '**含 [链接](https://example.com) 的中文**。 后续'],
  ['> 第一行\n> **中文。 **后续', '> 第一行\n> **中文**。 后续'],
  ['- 第一行\n  **中文。 **后续', '- 第一行\n  **中文**。 后续'],
  ['| 列 |\n|---|\n| **中文。 **后续 |', '| 列 |\n|---|\n| **中文**。 后续 |'],
  ['*中文。*后续', '*中文*。后续'],
  ['~~中文。~~后续', '~~中文~~。后续'],
  ['__中文。__后续', '**中文**。后续'],
  ['**加粗 *斜体* 中文。 **后续', '**加粗 *斜体* 中文**。 后续'],
  ['> 外层\n> > **内层。 **后续', '> 外层\n> > **内层**。 后续'],
  ['- 外层\n  - **内层。 **后续', '- 外层\n  - **内层**。 后续'],
  ['# **标题。 **后续', '# **标题**。 后续'],
  ['- [x] **完成。 **后续', '- [x] **完成**。 后续'],
];
for (const [source, expected] of proseCases) {
  assert.equal(normalizeProseMarkdown(source), expected);
  assert.equal(normalizeProseMarkdown(expected), expected, 'normalization is idempotent');
}
assert.match(diagramMarkdown(diagram, 100), /┌/);
assert.match(diagramMarkdown(diagram, 2), /```mermaid/);
assert.match(diagramMarkdown('```mermaid\nunknown graph\n```', 100), /unknown graph/);
for (const name of ['dark', 'light']) {
  initTheme(name, false);
  const theme = getThemeByName(name);
  const replyTurn = { question: '', process: [], final: screenshotReply };
  const replyView = minimalOutputComponent(theme, () => [replyTurn]);
  for (const width of [12, 40, 100]) {
    const rows = replyView.render(width);
    assert.doesNotMatch(plain(rows.join('\n')), /\*\*/);
    assert.ok(rows.every(row => visibleWidth(row) <= width));
  }
  const reply = replyView.render(160).join('\n');
  assert.ok(reply.includes(theme.bold('Hono 完全可以接收上报；放 Java 不是技术限制，而是复用现有日志出口')));
  assert.ok(reply.includes(theme.fg('mdHeading', theme.bold('Hono 完全可以接收上报；放 Java 不是技术限制，而是复用现有日志出口'))), 'CJK and Latin receive the same emphasis color');
  assert.match(plain(reply), /AiErrorLogController.java/);
  for (const [source] of proseCases) {
    for (const width of [12, 40, 100]) {
      const rows = minimalOutputComponent(theme, () => [{ question: '', process: [], final: source }]).render(width);
      assert.doesNotMatch(plain(rows.join('\n')), /\*\*|__|~~|\*中文/);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${name}/${width}: ${source}`);
    }
  }
  replyTurn.final = '**尚未结束';
  assert.match(plain(replyView.render(100).join('\n')), /尚未结束/);
  replyTurn.final += '。 **继续';
  assert.doesNotMatch(plain(replyView.render(100).join('\n')), /\*\*/);
  const receiptView = minimalOutputComponent(theme, () => [{ question: 'Q', process: ['call workflow'], agentCalls: [{ id: 'workflow', name: 'subagent', task: 'launch', state: 'done', output: 'Run fan-out: 0/64 used\nAsync workflow [run-123]\nThe async run is detached and running in the background.' }] }], () => true);
  const receiptRows = plain(receiptView.render(160).join('\n'));
  assert.match(receiptRows, /Control subagent · dispatch · returned/);
  assert.doesNotMatch(receiptRows, /Run fan-out|The async run is detached/);
  const output = minimalOutputComponent(theme, () => [{ question: 'Q', process: ['output body'], running: false }]).render(100).join('\n');
  assert.match(plain(output), /Output body/);
  assert.ok(output.includes(theme.fg('text', theme.bold('Output'))), 'Output label uses neutral foreground');
  assert.ok(output.includes(theme.fg('muted', 'body')), 'Output body uses neutral gray');
  const neutral = minimalOutputComponent(theme, () => [{ question: '', process: ['call r', 'skill frontend'], agentCalls: [{ id: 'r', name: 'read', task: 'README.md', state: 'done' }] }]).render(100).join('\n');
  for (const label of ['Agent', 'read', 'Skill']) assert.ok(neutral.includes(theme.fg('text', theme.bold(label))), label);
  for (const body of ['README.md', 'frontend']) assert.ok(neutral.includes(theme.fg('muted', body)), body);
  assert.ok(!neutral.includes(theme.fg('accent', '')), 'settled plain process contains no accent foreground');
  const mdOutput = minimalOutputComponent(theme, () => [{ question: 'Q', process: ['output 重点区分 **SAPI 网关** 的职责'], running: false }]).render(100).join('\n');
  assert.doesNotMatch(plain(mdOutput), /\*\*/);
  assert.ok(mdOutput.includes(theme.bold('SAPI 网关')), 'Output prose renders Markdown emphasis');
  // Block and inline structure is decided by the lexer, then rendered for real.
  const renderMd = (source, width = 100) => renderMinimalMarkdown(source, width, getMarkdownTheme(), theme.getBgAnsi('userMessageBg'),
    { color: value => theme.fg('text', value) }, diagramMarkdown);
  const renderProse = source => plain(renderMd(source).join('\n'));
  const syntaxColors = source => [...new Set([...renderMd(source).join('\n').matchAll(/\x1b\[(38;[0-9;]+)m/g)].map(match => match[1]))].sort();
  const structureCases = [
    '| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |',
    '标题\n===',
    '段落\n---',
    '---',
    '- 列表项\n- 第二项',
    '> 引用',
    '# 标题',
    '`代码` 与 **粗体**',
    '*斜体*', '_斜体_', '~~删除~~',
    '[链接](https://example.com)', '<https://example.com>',
    '[引用][1]\n\n[1]: https://example.com',
    '步骤\n\n2. 第二步',
  ];
  for (const source of structureCases) {
    assert.equal(isMarkdownProse(source), true, `${name}: ${JSON.stringify(source)} is Markdown`);
    assert.doesNotMatch(renderProse(source), /▶/, `${name}: ${JSON.stringify(source)} draws no diagram`);
  }
  assert.match(renderProse('| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |'), /甲/, 'tables render their cells');
  assert.doesNotMatch(renderProse('*斜体* 与 ~~删除~~ 与 `代码`'), /\*斜体\*|~~删除~~|`代码`/, 'inline emphasis, deletion and code spans render');
  assert.match(renderProse('[链接](https://example.com)'), /链接/, 'inline links render');
  assert.doesNotMatch(renderProse('<https://example.com>'), /<https/, 'autolinks render');
  const reference = renderProse('[引用][1]\n\n[1]: https://example.com');
  assert.match(reference, /引用/);
  assert.doesNotMatch(reference, /\[引用\]\[1\]|\[1\]:/, 'reference links render');
  // Every fence closes over any language tag: text/plaintext/unknown are code, never diagrams.
  const fenceBody = 'flowchart LR\nA-->B';
  for (const fence of ['```', '~~~']) for (const lang of ['', 'text', 'txt', 'plaintext', 'unknown']) {
    const source = `${fence}${lang}\n${fenceBody}\n${fence}`;
    assert.equal(isMarkdownProse(source), true, `${name}: ${fence}${lang} is Markdown`);
    const rendered = renderProse(source);
    assert.match(rendered, /flowchart LR/, `${name}: ${fence}${lang} keeps its body`);
    assert.match(rendered, /A-->B/, `${name}: ${fence}${lang} keeps its body`);
    assert.doesNotMatch(rendered, /┌|▶/, `${name}: ${fence}${lang} must not become a diagram`);
    assert.doesNotMatch(rendered, /──|│ flowchart LR/);
    assert.doesNotMatch(rendered, /```|~~~/);
  }
  // A fence beats the "looks like source" exclusion, for either fence style and any tag.
  for (const source of ['```js\nconst value = 1;\n```', '~~~js\nconst value = 1;\n~~~', '~~~\nconst value = 1;\n~~~']) {
    assert.equal(isMarkdownProse(source), true, `${name}: ${source} is Markdown`);
  }
  // A fence's info string is "language [options]", so options no longer drop highlighting.
  for (const [tag, code] of [['JS title="a"', 'const value = 1;'], ['typescript filename=x.ts', 'const value: number = 1;'], ['Python', 'def run():\n    return 1']]) {
    const source = '```' + tag + '\n' + code + '\n```';
    assert.notDeepEqual(syntaxColors(source), syntaxColors('```text\n' + code + '\n```'), `${name}: ${tag} highlights`);
    assert.match(renderProse(source), new RegExp(code.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${tag} keeps its code`);
  }
  const json5Body = '// 工程 build-profile.json5\nproducts: [\n  { name: "default", enabled: true, count: 42, },\n]';
  for (const tag of ['json5', 'JSON5 title="build-profile.json5"']) {
    const source = '```' + tag + '\n' + json5Body + '\n```';
    assert.notDeepEqual(syntaxColors(source), syntaxColors('```text\n' + json5Body + '\n```'), `${name}: ${tag} highlights`);
    const rows = renderMd(source).map(plain).map(row => row.trimEnd());
    assert.deepEqual(rows.slice(1, -1), json5Body.split('\n').map(line => ' ' + line), `${name}: ${tag} preserves source without border`);
  }
  const jsoncBody = '{\n  // comment\n  "name": "default", "enabled": true\n}';
  assert.notDeepEqual(syntaxColors('```jsonc\n' + jsoncBody + '\n```'), syntaxColors('```text\n' + jsoncBody + '\n```'));
  for (const tag of ['text', 'txt', 'plaintext', 'made-up-language']) {
    const source = '```' + tag + '\n' + json5Body + '\n```';
    assert.deepEqual(syntaxColors(source), syntaxColors('```text\n' + json5Body + '\n```'), `${name}: ${tag} stays plain`);
    for (const width of [12, 40, 100]) {
      const rows = minimalOutputComponent(theme, () => [{ question: '', process: [], final: source }]).render(width);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${name}/${tag}/${width}: ${JSON.stringify(rows.filter(row => visibleWidth(row) > width).map(plain))}`);
    }
  }
  assert.match(renderProse('```json5\n{ name: "streaming'), /streaming/);
  // A CJK indented tree keeps its guides inside a fence and draws nothing outside one.
  const tree = '项目结构：\n　　├── src\n　　│   └── index.ts\n　　└── package.json';
  for (const lang of ['', 'text', 'txt', 'plaintext', 'unknown']) {
    const rendered = renderProse(`\`\`\`${lang}\n${tree}\n\`\`\``);
    assert.match(rendered, /├── src/, `${name}: ${lang} tree keeps its guides`);
    assert.match(rendered, /└── package\.json/, `${name}: ${lang} tree keeps its guides`);
    assert.doesNotMatch(rendered, /┌|▶/, `${name}: ${lang} tree must not become a diagram`);
  }
  assert.equal(isMarkdownProse(tree), false, `${name}: a bare CJK tree stays literal`);
  assert.equal(diagramMarkdown(tree, 100), tree, `${name}: a bare CJK tree passes through`);
  const screenshotTree = '现在\n    Agents\n        pi · goose-notes\n        Terminals\n            goose-2fa\n            goose-2fa      ← 插在这里\n\n改完\n混排会话\n    pi · goose-notes\n    goose-2fa\n    新会话               ← 落在最下面';
  const screenshotFence = '```text\n' + screenshotTree + '\n```';
  assert.equal(isFencedMarkdown(screenshotFence), true, `${name}: screenshot fence is a single code block`);
  const screenshotView = minimalOutputComponent(theme, () => [{ question: screenshotFence, process: [] }]);
  const screenshotRows = plain(screenshotView.render(80).join('\n'));
  assert.match(screenshotRows, /插在这里/);
  assert.match(screenshotRows, /落在最下面/);
  assert.doesNotMatch(screenshotRows, /展开/);
  assert.deepEqual(screenshotView.promptChoices(), [], `${name}: a fenced user prompt is not sliced mid-block`);
  // Literal bodies stay literal: JSON, obvious source, money and raw HTML are not prose.
  for (const source of ['{"a":1,"b":[2,3]}', '[1,2,3]', 'const value = **not bold**;', 'function f() { return `x`; }', 'SELECT * FROM t WHERE a = 1', '价格 $5 与 $10 元', '<div>x</div>', '<span>纯 HTML</span>', '<br>']) {
    assert.equal(isMarkdownProse(source), false, `${name}: ${source} stays literal`);
  }
  for (const source of ['npm install \\\n  --save x', 'C:\\Users\\each\\\nnext', '步骤\n2. 第二步']) {
    assert.equal(isMarkdownProse(source), false, `${name}: breaks alone do not select Markdown`);
    assert.equal(diagramMarkdown(source, 100), source, `${name}: literal characters remain intact`);
  }
  // Diagram tags are matched on the first language token, whatever its case or options.
  const diagramBodies = {
    flowchart: 'flowchart LR\nA --> B',
    graph: 'graph TD\nA --> B',
    sequence: 'sequenceDiagram\nAlice->>Bob: Hi',
    class: 'classDiagram\nclass Animal',
    state: 'stateDiagram-v2\n[*] --> Still',
    er: 'erDiagram\nCUSTOMER ||--o{ ORDER : places',
  };
  for (const [kind, body] of Object.entries(diagramBodies)) for (const tag of ['mermaid', 'MERMAID', 'mermaid title="图"']) {
    const source = `\`\`\`${tag}\n${body}\n\`\`\``;
    assert.equal(isMarkdownProse(source), true, `${name}: ${kind} is Markdown`);
    const rendered = renderProse(source);
    assert.doesNotMatch(rendered, /```mermaid/i, `${name}: ${kind}/${tag} becomes a diagram`);
    assert.match(rendered, /[┌└│─]/, `${name}: ${kind}/${tag} draws`);
  }
  for (const body of ['unknown graph', 'pie\n"已完成" : 60\n"未完成" : 40', 'flowchart LR\nA[broken']) {
    const rendered = renderProse('```mermaid\n' + body + '\n```');
    assert.doesNotMatch(rendered, /── mermaid/, `${name}: ${body} keeps its source without label`);
    assert.match(rendered, new RegExp(body.split('\n')[0]), `${name}: ${body} keeps its source`);
  }
  // Four backticks wrap a three-backtick example without turning it into a diagram.
  const nested = renderProse('````md\n```js\nconst value = 1;\n```\n````');
  assert.doesNotMatch(nested, /── md/);
  assert.match(nested, /```js/);
  assert.match(nested, /const value = 1;/);
  assert.doesNotMatch(nested, /┌|▶/);
  // Streaming and unfinished input must render without throwing.
  for (const source of ['**still streaming', '```js\nconst value = ', '| 列 | 值 |\n| ---', tree]) {
    assert.doesNotThrow(() => renderMd(source, 40), `${name}: ${source}`);
  }
  assert.match(renderProse('**still streaming'), /still streaming/);
  // Narrow widths reuse the component harness, which truncates every markdown row.
  for (const source of [...structureCases, `\`\`\`text\n${tree}\n\`\`\``, '~~~\n' + fenceBody + '\n~~~', nested]) {
    for (const width of [12, 40, 100]) {
      const rows = minimalOutputComponent(theme, () => [{ question: '', process: [], final: source }]).render(width);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${name}/${width}: ${source}`);
    }
  }
  const turn = { question: '**User**\n\n> quote', process: ['thinking **plan**\n\n```js\nconst count = 1;\n```'], running: true, final: '# Answer\n\n| Name | Value |\n| --- | --- |\n| First | 42 |\n\n```js\nconst value = 42;\n```\n\n' + diagram };
  const usageTurns = minimalTurnsFromBranch([
    { type: 'message', message: { role: 'user', content: 'first' } },
    { type: 'message', message: { role: 'assistant', content: [], usage: { totalTokens: 1100000, cacheRead: 80000 } } },
    { type: 'message', message: { role: 'toolResult', content: [], usage: { totalTokens: 100000, cacheRead: 10000 } } },
    { type: 'message', message: { role: 'user', content: 'second' } },
    { type: 'message', message: { role: 'assistant', content: [], usage: { input: 10, output: 20 } } },
  ]);
  const usageView = minimalOutputComponent(theme, () => usageTurns, () => false, () => false);
  const hiddenUsageView = minimalOutputComponent(theme, () => usageTurns, () => false, () => false, () => false);
  assert.doesNotMatch(plain(hiddenUsageView.render(100).join('\n')), /S 1.2M|C 90K|Ctrl\+O/);
  const headers = usageView.render(100).filter(line => plain(line).startsWith('Agent'));
  assert.match(plain(headers[0]), /S 1.2M \/ C 90K$/);
  assert.match(plain(headers[1]), /S 30 \/ C 0$/);
  assert.ok(headers.every(line => visibleWidth(line) === 100));
  usageTurns[1].pendingUsage = { input: 5, output: 5 };
  assert.match(plain(usageView.render(100).join('\n')), /S 40 \/ C 0/);
  assert.match(plain(usageView.render(100).join('\n')), /S 40 \/ C 0/, 'repeated renders must not accumulate streaming usage');
  for (const width of [1, 12, 30, 40]) assert.ok(usageView.render(width).every(line => visibleWidth(line) <= width));
  const styled = minimalOutputComponent(theme, () => [{ question: '', process: ['thinking **bold** *italic* [link](https://example.com)'], running: true, thinking: 0 }]).render(100).find(line => plain(line).includes('Thinking'));
  assert.doesNotMatch(plain(styled), /\*\*|\*italic\*/);
  assert.ok(styled.includes(theme.fg('text', theme.bold('Thinking'))));
  const toolRow = minimalOutputComponent(theme, () => [{ question: '', process: ['call t'], agentCalls: [{ id: 't', name: 'subagent', task: 'Requesting exact model IDs', state: 'running' }] }]).render(100).find(line => plain(line).includes('subagent'));
  assert.equal(toolRow, undefined, 'management calls are hidden from compact progress');
  if (theme.bold("probe").includes("\x1b[1m")) {
    assert.match(styled, /\x1b\[1m/);
    assert.match(styled, /\x1b\[3m/);
    assert.match(styled, /\x1b\[4m/);
  }
  let expanded = false;
  const view = minimalOutputComponent(theme, () => [turn], () => expanded);
  assert.equal(view.render(100).filter(line => plain(line).includes("const count")).length, 0);
  expanded = true;
  assert.doesNotMatch(plain(view.render(100).join("\n")), /const count/);
  assert.ok(view.render(100).filter(line => plain(line).includes("const count")).every(line => !/\x1b\[48;/.test(line)));
  for (const width of [1, 2, 12, 40, 100]) {
    const lines = view.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${name}/${width}: width overflow`);
  }
  // Expanding reveals more entries, never repeats their full body.
  turn.process.push('skill final-sibling');
  const connected = view.render(100).map(plain);
  const first = connected.findIndex(row => row.startsWith('├─'));
  const last = connected.findIndex(row => row.startsWith('└─'));
  assert.equal(last, first + 1);
  const compactTurn = { question: 'Q', process: ['thinking Checking fixtures', 'call read', 'call failed'], agentCalls: [
    { id: 'read', name: 'read', task: 'src/example.ts', state: 'done', output: 'SOURCE_NOISE\n'.repeat(100) },
    { id: 'failed', name: 'bash', task: 'npm test', state: 'error', output: 'Test failed\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6' },
  ] };
  const compact = minimalOutputComponent(theme, () => [compactTurn], () => true).render(120).map(plain).join('\n');
  assert.equal(compact.split('Checking fixtures').length - 1, 1);
  assert.match(compact, /read src\/example.ts/);
  assert.doesNotMatch(compact, /SOURCE_NOISE|line 5|line 6/);
  assert.equal(compact.split('Test failed').length - 1, 1);
  assert.match(compact, /line 4/);
  assert.match(compact, /\+2 lines/);
  const rendered = plain(view.render(100).join('\n'));
  assert.match(rendered, /Answer/);
  assert.match(rendered, /const value = 42/);
  assert.match(rendered, /┌/);
  assert.doesNotMatch(rendered, /\*\*User\*\*|```mermaid/);
  turn.final += '\n\nStreaming continuation';
  assert.match(plain(view.render(100).join('\n')), /Streaming continuation/);
}
for (const mode of ['truecolor', '256color']) {
  const theme = { getBgAnsi: () => '\x1b[48;2;240;240;240m', fg: () => '\x1b[38;2;30;180;80m', getColorMode: () => mode };
  const user = minimalSurface(theme, 'text\x1b[0mmore', true);
  const secondary = minimalSurface(theme, 'text', false);
  assert.notEqual(user.split('text')[0], secondary.split('text')[0]);
  assert.ok(user.includes('\x1b[0m' + user.split('text')[0]), 'inline resets restore background');
}
console.log('Markdown: dark/light, streaming, block+inline structure, code fences, highlighting, Mermaid kinds, literal bodies, narrow widths and accent surfaces PASS');
