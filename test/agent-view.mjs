import assert from 'node:assert/strict';
import { Container, Text, visibleWidth } from '@earendil-works/pi-tui';
import { initTheme, getThemeByName } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { registerHooks } from 'node:module';
const themeUrl = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-coding-agent') return { shortCircuit: true, url: themeUrl };
    return nextResolve(specifier, context);
  },
});
const { AGENT_STATUS_ENTRY, savedAgentStatuses, retainAgentStatuses, agentChildren, agentCall, agentCallRows, agentStatusesByTurn, attachAgentWidgets, restyleAgentWidget, liveAgentRows, readAgentStatuses, currentAgentStatuses, liveAgentView, agentCallDisplay, isAgentTool, RUNNING_FRAMES, runningGlyph } = await import('../lib/agent-view.ts');
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const clean = text => text.replace(/\x1b\[[0-9;]*m/g, '');
for (const name of ['dark', 'light']) {
  initTheme(name, false);
  const theme = getThemeByName(name);
  for (const state of ['running', 'complete', 'failed', 'cancelled', 'canceled', 'aborted', 'stopped']) {
    const status = { runId: `saved-${state}`, toolCallId: 'dispatch', mode: 'single', state, startedAt: 1000,
      endedAt: state === 'running' ? undefined : 2000,
      error: state === 'failed' ? 'Subagent timed out after 180000ms.' : undefined,
      steps: [{ agent: 'worker', status: 'running', recentOutput: ['unsafe preview'], finalOutput: 'durable details' }] };
    const entries = JSON.parse(JSON.stringify([{ type: 'custom', customType: AGENT_STATUS_ENTRY, data: status }]));
    const restored = retainAgentStatuses(savedAgentStatuses(entries), []);
    const assigned = agentStatusesByTurn(restored, [{ agentCalls: ['dispatch'] }, { agentCalls: [] }]);
    assert.equal(assigned.get(1).length, 0);
    const result = liveAgentView(assigned.get(0), theme, 120, true, false, new Map(), 90000);
    assert.equal(result.total, 1);
    assert.equal(result.running, state === 'running' ? 1 : 0);
    assert.equal(result.done, state === 'complete' ? 1 : 0);
    assert.equal(result.errors, ['running', 'complete'].includes(state) ? 0 : 1);
    assert.doesNotMatch(result.rows[0], /durable details|unsafe preview/);
    if (state !== 'running') assert.match(result.rows.slice(1).join('\n'), /durable details/);
    if (state !== 'running') assert.match(clean(result.rows[0]), /0:01/);
    assert.equal(agentChildren(restored).length, 1);
  }
  // liveAgentView: runtime model heading, full-width activity, terminal expiry and identities.
  const clock = 50_000;
  const deadlines = new Map();
  const snapshot = [{ runId: 'ui-child', mode: 'single', state: 'running', startedAt: 100,
    steps: [{ agent: 'worker', workflowKey: 'review', model: '9router/GPT-6Astra:high', status: 'running',
      recentTools: [null, { tool: 'read', args: '\x1b[31m中文路径.ts\x1b[0m', endMs: clock }], recentOutput: [] }] }];
  const originalSnapshot = JSON.stringify(snapshot);
  const render = (at, width = 120, expanded = false) => liveAgentView(snapshot, theme, width, expanded, true, deadlines, at);
  const first = render(clock).rows[0];
  assert.match(clean(first), /SubAgent • GPT-6Astra high 0:49 : read 中文路径.ts/);
  assert.doesNotMatch(clean(first), /worker|review|running|9router/);
  assert.ok(first.includes(theme.fg('text', theme.bold('SubAgent'))));
  assert.ok(first.includes(theme.fg('muted', ' high')));
  assert.ok(first.includes(theme.fg('success', ' 0:49')), 'running subagent duration uses the semantic green success color');
  assert.ok(first.includes(theme.fg('muted', 'read 中文路径.ts')));
  for (let width = 1; width <= 160; width++) {
    const row = render(clock, width).rows[0];
    assert.equal(visibleWidth(row), width, `CJK/ANSI exact width ${width}`);
    if (width >= 42) assert.match(clean(row), /SubAgent • GPT-6Astra high 0:49 : /, 'heading and elapsed time stay intact when they fit');
  }
  snapshot[0].steps[0].recentTools.push({ tool: 'bash', args: 'npm test ' + '中文🙂 very-long-activity '.repeat(12), endMs: clock });
  const frameA = render(clock).rows[0], frameB = render(clock + 2000).rows[0];
  assert.equal(clean(frameA).split(' : ')[1], clean(frameB).split(' : ')[1], 'tool activity is truncated, never scrolled');
  assert.match(clean(frameA), /…\s*$/);
  snapshot[0].steps[0].recentOutput = ['AI 回复 ' + '中文回复🙂 '.repeat(40)];
  const replyStart = render(clock + 3000, 120, true);
  assert.match(clean(replyStart.rows.slice(1).join('\n')), /● bash npm test/, 'running expansion shows the current tool on one line');
  assert.doesNotMatch(clean(replyStart.rows.join('\n')), /AI 回复/, 'unstructured prose stays hidden');
  assert.doesNotMatch(clean(replyStart.rows[0]), /AI 回复/);
  assert.equal(clean(replyStart.rows[0]).split(' : ')[1], clean(render(clock + 5000).rows[0]).split(' : ')[1], 'activity never plays back recentOutput');
  assert.match(clean(render(clock + 100000).rows[0]), /bash npm test/, 'tool activity stays visible');
  snapshot[0].steps[0].recentOutput = ['新的回复'];
  assert.doesNotMatch(clean(render(clock + 101000).rows[0]), /新的回复/, 'new previews remain hidden');
  snapshot[0].steps[0].recentOutput = [];
  assert.equal(clean(frameA).split(' : ')[0].replace(/ \d+:\d\d$/, ''), clean(frameB).split(' : ')[0].replace(/ \d+:\d\d$/, ''), 'model heading never scrolls');
  const fullWidth = structuredClone(snapshot);
  fullWidth[0].steps[0].recentTools = [];
  fullWidth[0].steps[0].currentTool = 'x'.repeat(200);
  fullWidth[0].steps[0].recentOutput = ['UNSAFE_PREVIEW'];
  for (const width of [40, 80, 120, 160]) for (const expanded of [false, true]) {
    const row = liveAgentView(fullWidth, theme, width, expanded, true, new Map(), clock).rows[0];
    const heading = `└─ ${runningGlyph(clock)} SubAgent • GPT-6Astra high 0:49 : `;
    assert.equal(clean(row), heading + 'x'.repeat(width - visibleWidth(heading) - 1) + '…', 'body occupies every remaining column, no reserved right area');
    assert.ok(row.includes(theme.fg('muted', ' high')), 'thinking stays gray even when expanded');
    assert.equal(row.includes(theme.getBgAnsi('selectedBg')), expanded, 'only the expanded heading fills selectedBg');
    assert.ok(row.includes(theme.fg(expanded ? 'accent' : 'text', theme.bold('SubAgent'))), 'expanded heading emphasizes SubAgent');
  }
  const sessionDir = mkdtempSync(join(tmpdir(), 'mini-agent-session-'));
  try {
    const sessionFile = join(sessionDir, 'session.jsonl');
    const rawPath = '/Users/eachann/.pi/agent/sessions/--Users-eachann-iWork-ravenclaw--/long-child-session.jsonl';
    writeFileSync(sessionFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'write', input: { path: rawPath } }] } }) + '\n');
    const truncated = [{ runId: 'raw-input', steps: [{ agent: 'worker', status: 'completed', sessionFile,
      recentTools: [{ tool: 'write', args: rawPath.slice(0, 60) + '...' }] }] }];
    const row = clean(liveAgentView(truncated, theme, 160, false, true, new Map(), clock).rows[0]);
    assert.match(row, new RegExp(rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'truncated status preview is hydrated from the child session before fitting the terminal width');
    assert.equal(visibleWidth(row), 160, 'hydrated activity still exactly fits the render width');
    const command = "python3 - <<'PY'\nimport csv, pathlib\nbase=pathlib.Path('/" + 'long-path/'.repeat(30) + "')\nPY";
    const flatCommand = command.replace(/\s+/g, ' ');
    writeFileSync(sessionFile, [
      { type: 'thinking_level_change', thinkingLevel: 'off' },
      { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    truncated[0].steps[0] = { agent: 'delegate', model: '9router/low', status: 'completed', sessionFile,
      recentTools: [{ tool: 'bash', args: flatCommand.slice(0, 57) + '...' }] };
    const hydrated = clean(liveAgentView(truncated, theme, 200, false, true, new Map(), clock).rows[0]);
    const heading = '└─ ✓ SubAgent • low off 0:00 : bash ';
    assert.equal(hydrated, heading + flatCommand.slice(0, 199 - visibleWidth(heading)) + '…', 'real arguments + multiline preview fill the available width; low remains the model, off comes from session');
    truncated[0].steps[0].thinking = 'high';
    assert.match(clean(liveAgentView(truncated, theme, 200).rows[0]), /SubAgent • low high /, 'explicit snapshot thinking wins');
    delete truncated[0].steps[0].thinking;
    writeFileSync(sessionFile, JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium' }) + '\n{partial');
    assert.match(clean(liveAgentView(truncated, theme, 200).rows[0]), /SubAgent • low medium /, 'cache refresh recovers valid entries before a partial write');
    truncated[0].steps[0].sessionFile = join(sessionDir, 'missing.jsonl');
    assert.match(clean(liveAgentView(truncated, theme, 200).rows[0]), /SubAgent • low \? /, 'unavailable thinking stays explicit, never guessed from model name');
  } finally { rmSync(sessionDir, { recursive: true, force: true }); }
  for (let width = 1; width <= 160; width++) {
    assert.equal(visibleWidth(render(clock + 2000, width).rows[0]), width, `scrolling CJK/emoji width ${width}`);
  }
  const noModel = [{ runId: 'unknown', steps: [{ agent: 'worker', status: 'running', recentOutput: ['waiting for model'] }] }];
  assert.doesNotMatch(clean(liveAgentView(noModel, theme, 80).rows[0]), /worker|undefined|null/);
  snapshot[0].state = 'complete';
  snapshot[0].steps[0].recentTools = [{ tool: 'read', args: 'result.ts', endMs: clock }];
  assert.match(clean(render(clock).rows[0]), /✓ SubAgent • GPT-6Astra high 0:49 : read result.ts/);
  assert.equal(render(clock + 9999).total, 1);
  assert.equal(render(clock + 10000).total, 1, 'completed rows remain in the current session');
  assert.equal(render(clock + 10001, 120, true).total, 1, 'Ctrl+S can still expand completed rows');
  snapshot[0].endedAt = clock + 10001;
  assert.equal(render(clock + 10002).total, 1, 'terminal updates retain the completed row');
  snapshot[0].startedAt = clock + 11000;
  snapshot[0].state = 'running';
  assert.equal(render(clock + 12000).running, 1, 'new attempt is not removed by old deadline');
  snapshot[0].state = 'complete';
  snapshot[0].endedAt = clock + 12000;
  assert.equal(render(clock + 12000).total, 1);
  assert.equal(render(clock + 22000).total, 1, 'completed retries remain visible in the current session');
  const twins = ['one', 'two'].map(runId => ({ runId, workflowChildren: { children: [{ childId: 'same', agent: 'worker', state: 'complete' }] } }));
  const isolated = new Map();
  assert.equal(liveAgentView([twins[0]], theme, 100, false, false, isolated, clock).total, 1);
  assert.equal(liveAgentView(twins, theme, 100, false, false, isolated, clock + 10000).total, 2, 'same childId in different workflows is isolated and retained');
  const historic = [{ runId: 'historic', mode: 'single', state: 'complete', endedAt: clock - 10000, steps: [{ agent: 'worker' }] }];
  assert.equal(liveAgentView(historic, theme, 100, true, false, new Map(), clock).total, 1, 'a supplied current-session terminal snapshot remains visible');
  const frozen = JSON.parse(originalSnapshot);
  liveAgentView(frozen, theme, 100);
  assert.equal(JSON.stringify(frozen), originalSnapshot, 'source snapshot is not mutated');
  for (const [tool, action] of [['subagent', 'list'], ['subagent', 'status'], ['subagent_supervisor', 'reply'], ['subagent', 'run']]) {
    const call = agentCall('control', tool, { action });
    call.state = 'done';
    call.output = 'Executable agents (capabilities):\nORIGINAL_DIAGNOSTIC';
    assert.ok(isAgentTool(call.tool));
    assert.doesNotMatch(agentCallDisplay(call).summary, /Executable agents/);
    assert.equal(agentCallDisplay(call).detail, call.output, 'raw diagnostic retained');
  }
  const markdownActivity = '**含 `code` 的中文。 **后续';
  const markdownStatuses = [{ runId: 'markdown', steps: [{ agent: 'scout', status: 'running', recentOutput: [markdownActivity] }] }];
  for (const width of [12, 40, 100]) {
    const live = liveAgentRows(markdownStatuses, theme, width);
    const widget = restyleAgentWidget(['Async agents', '● scout · running', markdownActivity], theme, width, true);
    for (const rows of [live, widget]) {
      assert.doesNotMatch(clean(rows.join('\n')), /\*\*|`code`/);
      assert.ok(rows.every(row => visibleWidth(row) <= width));
    }
  }
  const calls = [agentCall('1', 'subagent', { agent: 'research', task: 'Investigate' }), agentCall('2', 'Agent', { subagent_type: 'review', prompt: 'Review' })];
  calls[1].state = 'error';
  calls[1].output = 'Review failed';
  for (const width of [1, 12, 40, 100]) {
    for (const expanded of [false, true]) {
      const rows = agentCallRows(calls, theme, width, expanded, text => [text]);
      assert.ok(rows.every(row => visibleWidth(row) <= width));
      assert.ok(rows.every(row => !/\x1b\[48;/.test(row)));
    }
  }
  assert.equal(agentCallRows(calls, theme, 100, false, text => [text]).length, 1);
  assert.match(clean(agentCallRows(calls, theme, 100, true, text => [text]).join('\n')), /Review failed/);
  const statuses = [{ runId: 'workflow', steps: Array.from({ length: 40 }, (_, i) => ({ runId: `child-${i}`, agent: 'reviewer', model: 'openai/gpt-5', thinking: 'low', currentTool: `read file-${i}`, status: 'running' })) }];
  for (const width of [1, 12, 100]) {
    const all = liveAgentRows(statuses, theme, width);
    assert.equal(all.length, 41, 'every child has exactly one row, no count cap');
    assert.ok(all.every(row => visibleWidth(row) <= width));
  }
  assert.match(clean(liveAgentRows(statuses, theme, 100).at(-1)), /SubAgent • gpt-5 low 0:00 : read file-39/);
  const liveHost = { children: Array.from({ length: 7 }, () => new Container()) };
  const restoreLive = attachAgentWidgets(liveHost, theme, () => true, () => statuses);
  for (const title of ['Async agents', '● subagents (40 running)', '├─ async workflow: new — background', ...RUNNING_FRAMES.map(frame => `${frame} Async agents · background`)]) {
    liveHost.children[3].clear();
    liveHost.children[3].addChild(new Text(title, 0, 0));
    const firstFrame = liveHost.children[3].render(100);
    assert.equal(firstFrame.length, 81, 'expanded running children show a heading and current activity');
    assert.doesNotMatch(clean(firstFrame.join('\n')), /async workflow|Async agents|subagents \(/);
  }
  statuses[0].steps.push({ runId: 'new-child', agent: 'reviewer', model: 'gpt-5', thinking: 'high', currentTool: 'write new.ts' });
  assert.equal(liveHost.children[3].render(100).length, 83);
  liveHost.children[5].addChild(new Text('⠇ Async agents · background', 0, 0));
  assert.deepEqual(liveHost.children[5].render(100), [], 'native panel stays hidden below editor too');
  restoreLive();
  assert.equal(new Set(RUNNING_FRAMES.map((_, i) => runningGlyph(i * 100))).size, RUNNING_FRAMES.length);
  const starting = [{ runId: 'starting', workflowChildren: { children: [{ childId: 'a', agent: 'scout', state: 'running' }] } }];
  assert.equal(liveAgentRows(starting, theme, 100).length, 2, 'inventory visible before steps are populated');
  const outputStatus = [{ runId: 'details', steps: [{ agent: 'scout', recentOutput: ['FIRST_DETAIL', 'LATEST'], status: 'running' }] }];
  assert.equal(liveAgentRows(outputStatus, theme, 100).length, 2);
  const markdownOutput = '# 结果\n\n- **重点**：使用 `inlineCode`\n- 第二项';
  const markdownDetails = liveAgentRows([{ runId: 'markdown-details', steps: [{ agent: 'scout', status: 'completed', finalOutput: markdownOutput }] }], theme, 100, true).join('\n');
  assert.doesNotMatch(clean(markdownDetails), /# 结果|\*\*重点\*\*|`inlineCode`/);
  assert.match(clean(markdownDetails), /结果[\s\S]*重点.*inlineCode/);
  assert.ok(markdownDetails.includes(theme.bold('重点')), 'expanded SubAgent output uses the shared Markdown emphasis');
  const jsonDetails = liveAgentRows([{ runId: 'json-details', steps: [{ agent: 'scout', status: 'completed', finalOutput: '{"key":"**literal**"}' }] }], theme, 100, true).join('\n');
  assert.match(clean(jsonDetails), /\{\"key\":\"\*\*literal\*\*\"\}/, 'structured output stays literal');
  const acceptance = '本轮代码已完成。\n\n```acceptance-report\n{\n  "criteriaSatisfied": [\n    { "id": "criterion-1", "status": "satisfied", "evidence": "ok" }\n  ]\n}\n```';
  const acceptanceDetails = liveAgentRows([{ runId: 'acceptance', steps: [{ agent: 'worker', status: 'completed', finalOutput: acceptance }] }], theme, 100, true).join('\n');
  assert.match(clean(acceptanceDetails), /本轮代码已完成/);
  assert.doesNotMatch(clean(acceptanceDetails), /acceptance-report|criteriaSatisfied/, 'gate JSON stays out of the child card');
  assert.equal(liveAgentRows(outputStatus, theme, 100, true).length, 3, 'running expansion shows its state, not raw replies');
  assert.doesNotMatch(clean(liveAgentRows(outputStatus, theme, 100, true).join('\n')), /FIRST_DETAIL/);
  for (const state of ['queued', 'running', 'completed', 'failed']) {
    const step = outputStatus[0].steps[0];
    step.status = state;
    step.error = state === 'failed' ? 'Model unavailable' : undefined;
    for (const expanded of [false, true]) {
      const rows = liveAgentRows(outputStatus, theme, 100, expanded).map(clean);
      assert.equal(rows.length, expanded && state !== 'completed' ? 3 : 2, `${state}: current activity or error expands, unstructured previews do not`);
      assert.doesNotMatch(rows.join('\n'), /FIRST_DETAIL|LATEST/);
      if (rows.length === 1) continue;
      assert.match(rows[1], state === 'failed' ? /^└─ × / : state === 'completed' ? /^└─ ✓ / : /^└─ [\u2800-\u28ff] /);
    }
  }
  const parentStatus = { runId: 'parent', toolCallId: 'current-call', mode: 'workflow', steps: [{ runId: 'child', agent: 'delegate', status: 'completed' }] };
  const child = { runId: 'child', parentWorkflowRunId: 'parent', mode: 'single', steps: [{ agent: 'delegate', model: 'gpt-5', thinking: 'low', recentOutput: ['UNSAFE_PREVIEW'], finalOutput: 'Actual result', status: 'completed' }] };
  const history = { runId: 'old', toolCallId: 'old-call', steps: [{ agent: 'reviewer' }] };
  assert.deepEqual(currentAgentStatuses([history, child, parentStatus], ['current-call']), [child, parentStatus]);
  assert.deepEqual(currentAgentStatuses([history, child, parentStatus], []), []);
  for (const order of [[child, parentStatus], [parentStatus, child]]) {
    const rows = liveAgentRows(order, theme, 100, true).map(clean);
    assert.equal(rows.length, 3, 'workflow summary and actual child merge into one heading with retained detail');
    assert.match(rows[0], /Sub Agent · running 0 · done 1/);
    assert.match(rows[1], /✓ SubAgent • gpt-5 low 0:00 : completed/);
    assert.match(rows[2], /Actual result/);
    assert.doesNotMatch(rows.join('\n'), /delegate : completed|─{3}/);
  }
  const staleParent = { ...parentStatus, steps: [{ runId: 'child', agent: 'delegate', label: 'Receiver contract', status: 'running' }] };
  const completedChild = { ...child, state: 'completed', steps: [{ ...child.steps[0], status: 'running' }] };
  for (const order of [[completedChild, staleParent], [staleParent, completedChild]]) {
    assert.equal(liveAgentRows(order, theme, 100).length, 2, 'terminal child snapshot overrides stale parent and step state');
    const rows = liveAgentRows(order, theme, 100, true).map(clean);
    assert.match(rows[0], /running 0 · done 1/);
    assert.match(rows[1], /✓ SubAgent • gpt-5 low 0:00 : completed/);
  }
  const mixed = [{ runId: 'mixed', steps: Array.from({ length: 9 }, (_, i) => ({
    runId: `mixed-${i}`, agent: 'loop', status: i < 4 ? 'completed' : 'running', activityState: 'active_long_running',
  })) }];
  const mixedRows = liveAgentRows(mixed, theme, 100).map(clean);
  assert.equal(mixedRows.length, 10);
  assert.match(mixedRows[0], /running 5 · done 4/);
  assert.equal(visibleWidth(mixedRows[0]), 100, 'summary is right aligned');
  assert.doesNotMatch(mixedRows.join('\n'), /active_long_running|4\/9/);
  assert.equal(liveAgentRows(mixed, theme, 100, true).length, 15);
  const fleetHost = { children: Array.from({ length: 7 }, () => new Container()) };
  let clicked = false;
  let fleet = ['5 active agents · ↓ 540.3k tokens · ↓/← to inspect'];
  fleetHost.children[5].addChild({ render: () => fleet, invalidate() {}, handleMouse() { clicked = true; } });
  const restoreFleet = attachAgentWidgets(fleetHost, theme, () => false, () => mixed);
  assert.deepEqual(fleetHost.children[5].render(100), []);
  fleet = ['↑↓/jk select · enter inspect · esc back', 'main'];
  assert.deepEqual(fleetHost.children[5].render(100), fleet, 'interactive fleet stays available');
  fleetHost.children[5].handleMouse({ y: 0, width: 100 });
  assert.ok(clicked, 'unrelated native interaction is preserved');
  fleet = ['5 active agents · 2 panes · ↓/← to inspect'];
  assert.deepEqual(fleetHost.children[5].render(100), fleet, 'pane information stays visible');
  restoreFleet();
  const inlineHost = { children: Array.from({ length: 7 }, () => new Container()) };
  for (const index of [3, 5]) {
    inlineHost.children[index].addChild(new Text('Async agents', 0, 0));
    inlineHost.children[index].addChild(new Text('5 active agents · inspect', 0, 0));
    inlineHost.children[index].addChild(new Text('UNRELATED', 0, 0));
  }
  const restoreInline = attachAgentWidgets(inlineHost, theme, () => false, undefined, true);
  for (const index of [3, 5]) assert.equal(clean(inlineHost.children[index].render(100).join('\n')).trim(), 'UNRELATED');
  restoreInline();
  assert.match(clean(inlineHost.children[3].render(100).join('\n')), /Async agents/);
  let expanded = false;
  let native = ['async subagent · background', '● reviewer · running · 3 turns', 'task: Review changes', 'Press ctrl+option+o for live detail', 'output: /tmp/output.log'];
  const host = { children: Array.from({ length: 7 }, () => new Container()) };
  const widgets = host.children[3];
  widgets.addChild({ render: () => native, invalidate() {} });
  widgets.addChild(new Text('UNRELATED', 0, 0));
  const original = widgets.render;
  const restore = attachAgentWidgets(host, theme, () => expanded);
  assert.equal(widgets.render(100).length, 3);
  assert.match(clean(widgets.render(100).join('\n')), /Sub Agent[\s\S]*reviewer : task: Review changes/);
  expanded = true;
  assert.doesNotMatch(clean(widgets.render(100).join('\n')), /ctrl\+option\+o|Fleet/);
  assert.equal(widgets.render(100).length, 3, 'expanding never adds child detail rows');
  const grouped = restyleAgentWidget(['Async agents', '● first · running', 'task: first task', 'Press ctrl+option+o for live detail · Ctrl+Alt+F Fleet', 'output: first.log', '● second · done', 'task: second task'], theme, 100, true);
  const blockRows = grouped.map(clean);
  assert.equal(blockRows.filter(row => /^[├└]─ /.test(row)).length, 2);
  assert.equal(blockRows.length, 3);
  assert.doesNotMatch(blockRows.join('\n'), /─{3}/);
  assert.doesNotMatch(blockRows.join('\n'), /Press|Fleet/);
  for (const width of [1, 12, 40]) assert.ok(restyleAgentWidget(native, theme, width, true).every(row => visibleWidth(row) <= width));
  native = ['Async agents · background', '● reviewer · running (gpt-5 · thinking low)', '⎿  Reading **source**'];
  expanded = false;
  const live = widgets.render(100).join('\n');
  assert.match(clean(live), /└─ [\u2800-\u28ff] reviewer · gpt-5 low : Reading source/);
  assert.ok(live.includes(theme.fg('accent', theme.bold('gpt-5'))));
  assert.ok(live.includes(theme.fg('muted', ' low')));
  assert.ok(!theme.fg('muted', ' low').includes('\x1b[1m'));
  const workflow = restyleAgentWidget(['Async agents', '├─ async workflow: abc — background', '│ ├─ ● reviewer · running (gpt-5 · thinking low)', '│ ⎿ Reading **source**', '… 10 lines hidden · ctrl+option+o expands'], theme, 100, false).join('\n');
  assert.match(clean(workflow), /└─ [\u2800-\u28ff] reviewer · gpt-5 low : Reading source/);
  assert.doesNotMatch(clean(workflow), /async workflow|lines hidden|├─ ├─/);
  native[2] = '⎿  Running `npm test`';
  assert.match(clean(widgets.render(100).join('\n')), /Running npm test/);
  assert.doesNotMatch(clean(widgets.render(100).join('\n')), /Reading source/);
  native = ['Async agents · background', '✗ reviewer · failed', 'error: model unavailable'];
  expanded = false;
  assert.match(clean(widgets.render(100).join('\n')), /└─ × reviewer : error: model unavailable/);
  assert.match(clean(widgets.render(100).join('\n')), /UNRELATED/);
  const unknown = ['Different widget', 'running'];
  assert.equal(restyleAgentWidget(unknown, theme, 100, false), unknown);
  restore();
  assert.equal(widgets.render, original);
  assert.match(widgets.render(100).join('\n'), /model unavailable/);
}
const root = mkdtempSync(join(tmpdir(), 'mini-agent-status-'));
try {
  const directory = join(root, 'async-subagent-runs', 'run');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ sessionId: 'own', runId: 'r', steps: [] }));
  assert.equal(readAgentStatuses('own', root).length, 1);
  assert.equal(readAgentStatuses('other', root).length, 0);
  writeFileSync(join(directory, 'status.json'), '{partial');
  assert.deepEqual(readAgentStatuses('own', root), []);
  const previous = [{ sessionId: 'own', runId: 'run', steps: [{ agent: 'scout' }] }];
  assert.deepEqual(readAgentStatuses('own', root, previous), previous, 'partial writes retain last valid rows');
  assert.deepEqual(readAgentStatuses('other', root, previous), [], 'snapshots never leak across sessions');
} finally { rmSync(root, { recursive: true, force: true }); }

// Regression 1: Single async & workflow identity association
const singleAsyncId = 'b99e312e-cf84-4b99-9a1c-b6681969a057';
const singleAsyncStatus = { runId: singleAsyncId, mode: 'single', state: 'running', startedAt: 1_000, steps: [{ agent: 'worker', status: 'running', model: '9router/GPT-5.6Terra:medium' }] };
const workflowParentId = '5f96be06-1b53-4073-8aaf-08e43376a763';
const workflowChildId = 'child-run-4073';
const workflowParent = { runId: workflowParentId, mode: 'workflow', state: 'running', steps: [] };
const workflowChild = { runId: workflowChildId, parentWorkflowRunId: workflowParentId, mode: 'single', state: 'running', steps: [{ agent: 'reviewer', status: 'running' }] };
const singleCall = agentCall('call-1', 'subagent', { action: 'run' });
singleCall.output = `Run fan-out: 1/64 used, 63 remaining\nAsync: worker [${singleAsyncId}]\nDetached.`;
const workflowCall = agentCall('call-2', 'subagent', { action: 'workflow' });
workflowCall.output = `Async workflow [${workflowParentId}]`;
const allStatuses = [singleAsyncStatus, workflowParent, workflowChild];
assert.deepEqual(currentAgentStatuses(allStatuses, [singleCall]), [singleAsyncStatus], 'single async run matches by runId in call output');
assert.deepEqual(currentAgentStatuses(allStatuses, [workflowCall]), [workflowParent, workflowChild], 'workflow and children match by workflow runId in call output');

// Regression 2: Snapshot ownership stays with its dispatching user turn.
// The old workflow finishes after a later user prompt; it must not move forward.
const lateOldStatus = { runId: 'late-old', toolCallId: 'old-turn-call', state: 'completed', steps: [{ agent: 'worker', status: 'completed' }] };
const currentStatus = { runId: 'current-run', toolCallId: 'current-turn-call', state: 'running', steps: [{ agent: 'reviewer', status: 'running' }] };
const byTurn = agentStatusesByTurn([lateOldStatus, currentStatus], [
  { agentCalls: [{ id: 'old-turn-call' }] },
  { agentCalls: [{ id: 'current-turn-call' }] },
  { agentCalls: [] },
]);
assert.deepEqual(byTurn.get(0), [lateOldStatus], 'late completion remains on the earlier turn');
assert.deepEqual(byTurn.get(1), [currentStatus], 'current turn still receives its own running child');
assert.deepEqual(byTurn.get(2), [], 'unclaimed historical snapshots never appear on a new user turn');

// Regression 3: Parent turn ended while subagent still running
initTheme('dark', false);
const testTheme = getThemeByName('dark');
const activeDeadlines = new Map();
const runningClock = 100_000;
const runningView = liveAgentView([singleAsyncStatus], testTheme, 100, false, true, activeDeadlines, runningClock);
assert.equal(runningView.running, 1);
assert.equal(runningView.done, 0);
assert.match(clean(runningView.rows[0]), /SubAgent • GPT-5.6Terra medium 1:39 : running/);
assert.match(clean(runningView.rows[0]), /^└─ [\u2800-\u28ff] /);
const laterRunningView = liveAgentView([singleAsyncStatus], testTheme, 100, false, true, activeDeadlines, runningClock + 15_000);
assert.equal(laterRunningView.running, 1, 'running subagent never expires');

// Regression 3: Real completion retention vs error permanence
const completedStatus = { ...singleAsyncStatus, state: 'completed', steps: [{ agent: 'worker', status: 'completed' }] };
const completeClock = runningClock + 20_000;
const completeDeadlines = new Map();
const doneView1 = liveAgentView([completedStatus], testTheme, 100, false, true, completeDeadlines, completeClock);
assert.equal(doneView1.done, 1);
assert.match(clean(doneView1.rows[0]), /^└─ ✓ SubAgent.* 1:59 :/, 'terminal child shows its final elapsed duration');
assert.ok(doneView1.rows[0].includes(testTheme.fg('muted', ' 1:59')), 'terminal subagent duration uses the semantic gray muted color');
const doneView2 = liveAgentView([completedStatus], testTheme, 100, false, true, completeDeadlines, completeClock + 5_000);
assert.equal(doneView2.done, 1, 'completed subagent remains visible');
const doneView3 = liveAgentView([completedStatus], testTheme, 100, false, true, completeDeadlines, completeClock + 60_000);
assert.equal(doneView3.total, 1, 'completed subagent does not expire during the current session');
assert.match(clean(doneView3.rows[0]), / 1:59 :/, 'completed child retains its terminal elapsed duration rather than continuing to count');
const completedControls = [];
const completedExpanded = liveAgentView([{ ...completedStatus, steps: [{ agent: 'worker', status: 'completed', finalOutput: 'Completed detail' }] }], testTheme, 100, false, true, completeDeadlines, completeClock + 60_000, new Set([singleAsyncId]), completedControls);
assert.equal(completedControls.length, 1, 'completed subagent remains clickable');
assert.match(clean(completedExpanded.rows.join('\n')), /Completed detail/, 'completed subagent expansion retains its detail');

// Error permanence: failed subagent NEVER auto-cleared
const failedStatus = { ...singleAsyncStatus, state: 'failed', steps: [{ agent: 'worker', status: 'failed', error: 'Process crashed' }] };
const errorDeadlines = new Map();
const errView1 = liveAgentView([failedStatus], testTheme, 100, false, true, errorDeadlines, completeClock);
assert.equal(errView1.errors, 1);
assert.match(clean(errView1.rows[0]), /^└─ × SubAgent .* : Process crashed/);
const errView2 = liveAgentView([failedStatus], testTheme, 100, false, true, errorDeadlines, completeClock + 60_000);
assert.equal(errView2.errors, 1, 'failed subagent is never auto-cleared');
const failedControls = [];
const failedExpanded = liveAgentView([{ ...failedStatus, steps: [{ agent: 'worker', status: 'failed', error: 'Process crashed', recentOutput: ['Failure detail'] }] }], testTheme, 100, false, true, errorDeadlines, completeClock + 60_000, new Set([singleAsyncId]), failedControls);
assert.equal(failedControls.length, 1, 'failed subagent remains clickable');
assert.match(clean(failedExpanded.rows.slice(1).join('\n')), /Process crashed/, 'failed subagent expansion retains its error');
assert.doesNotMatch(clean(failedExpanded.rows.join('\n')), /Failure detail/, 'failure does not authorize unstructured logs');

// Regression 4: Supervisor notice attached to subagent: loading glyph + task summary + purified body + accent color heading
const noticeMessage = {
  customType: 'subagent_supervisor_request',
  content: 'Subagent progress update.\nRun: b99e312e-cf84-4b99-9a1c-b6681969a057\nAgent: worker\nChild index: 0\n\nUPDATE: 本轮代码已完成并通过所有测试\n\nLive guidance: subagent(...)',
  details: {
    runId: singleAsyncId, agent: 'worker', reason: 'progress_update', expectsReply: false,
    requestBody: 'UPDATE: 本轮代码已完成并通过所有测试',
  },
};
const subagentWithNotice = {
  ...singleAsyncStatus,
  notice: { state: '进度', color: 'muted', summary: '本轮代码已完成并通过所有测试' },
  noticeMessages: [noticeMessage],
};
const askNotice = {
  customType: 'subagent_supervisor_request',
  details: {
    runId: singleAsyncId, agent: 'worker', reason: 'need_decision', expectsReply: true,
    requestBody: '是否继续执行？',
  },
};
const collapsedAskView = liveAgentView([{
  ...singleAsyncStatus,
  notice: { state: '需要裁决', color: 'warning', summary: '是否继续执行？', alert: true },
  noticeMessages: [askNotice],
}], testTheme, 120, false, true, new Map(), completeClock);
assert.match(clean(collapsedAskView.rows[0]), /⚠ SubAgent .* : 是否继续执行？/);
assert.ok(collapsedAskView.rows[0].includes(testTheme.fg('warning', '⚠ ')));
assert.doesNotMatch(clean(collapsedAskView.rows[0]), /代理间沟通已收纳|内部协作/);

const collapsedNoticeView = liveAgentView([subagentWithNotice], testTheme, 120, false, true, new Map(), completeClock);
assert.match(clean(collapsedNoticeView.rows[0]), /SubAgent • GPT-5.6Terra medium 1:59 : 本轮代码已完成并通过所有测试/);
assert.doesNotMatch(clean(collapsedNoticeView.rows[0]), /进度/);
assert.ok(collapsedNoticeView.rows[0].includes(testTheme.fg('muted', '本轮代码已完成并通过所有测试')));
assert.ok(!collapsedNoticeView.rows[0].includes(testTheme.getBgAnsi('selectedBg')), 'collapsed heading has no selectedBg');
assert.equal(collapsedNoticeView.rows.length, 1, 'collapsed subagent has 1 heading row');

const expandedControls = [];
const expandedNoticeView = liveAgentView([subagentWithNotice], testTheme, 120, true, true, new Map(), completeClock, undefined, expandedControls);
assert.equal(expandedControls.length, 1);
assert.equal(expandedControls[0].runId, singleAsyncId);
assert.ok(expandedNoticeView.rows[0].includes(testTheme.getBgAnsi('selectedBg')), 'expanded heading uses selectedBg');
assert.ok(expandedNoticeView.rows[0].includes(testTheme.fg('accent', testTheme.bold('SubAgent'))), 'expanded heading emphasizes SubAgent');
assert.equal(clean(expandedNoticeView.rows[0]), clean(collapsedNoticeView.rows[0]), 'expanding preserves heading text');
assert.ok(expandedNoticeView.rows[0].includes(testTheme.fg('muted', ' medium')), 'expanded thinking stays gray');
const renderedExpandedText = clean(expandedNoticeView.rows.join('\n'));
assert.match(renderedExpandedText, /本轮代码已完成并通过所有测试/);
assert.match(clean(expandedNoticeView.rows.slice(1).join('\n')), /本轮代码已完成并通过所有测试/, 'running expansion renders the current notice, not its history');
assert.doesNotMatch(clean(expandedNoticeView.rows.slice(1).join('\n')), /当前活动/);
assert.doesNotMatch(renderedExpandedText, /Subagent progress update|Run:|Child index|Live guidance|subagent\(|REQUEST_ID/);

const clickedIds = new Set([singleAsyncId]);
const clickedNoticeView = liveAgentView([subagentWithNotice], testTheme, 120, false, true, new Map(), completeClock, clickedIds);
assert.ok(clickedNoticeView.rows[0].includes(testTheme.getBgAnsi('selectedBg')), 'clicked expanded heading uses selectedBg');
assert.equal(clean(clickedNoticeView.rows[0]), clean(collapsedNoticeView.rows[0]), 'click expansion preserves heading text');
const markdownDetail = liveAgentView([{ ...completedStatus, steps: [{ agent: 'worker', status: 'completed', finalOutput: '验证结果：\n\n- 数据行保持不变' }] }], testTheme, 100, true, true, new Map(), completeClock);
assert.ok(markdownDetail.rows.slice(1).join('\n').includes(testTheme.fg('muted', '数据行保持不变')), 'Markdown list prose uses normal foreground');
assert.match(clean(clickedNoticeView.rows.join('\n')), /本轮代码已完成并通过所有测试/);

const stacked = liveAgentView([{
  runId: 'stacked-report', mode: 'single', state: 'running', startedAt: 1000,
  steps: [{
    agent: 'worker', status: 'running',
    recentTools: [{ tool: 'read', args: '/Users/eachann/Work/goose-notes/' + 'very-long-baseline-path/'.repeat(8) + 'table.ts' }],
    notice: { summary: '已读截图并对照 原生模型支持 headeredCols 与单元格颜色' },
    noticeMessages: [{
      customType: 'subagent_supervisor_request',
      details: {
        runId: 'stacked-report', agent: 'worker', reason: 'progress_update', expectsReply: false,
        requestBody: '已读截图并对照。\n\n- **原生模型**支持 `headeredCols`\n- 单元格 textColor / backgroundColor',
      },
    }],
  }],
}], testTheme, 80, true, true, new Map(), completeClock);
const stackedDetails = stacked.rows.slice(1);
assert.match(clean(stackedDetails[0]), /^ {3}● read /);
assert.match(clean(stackedDetails[0]), /…\s*$/, 'tool process stays on one truncated line');
assert.doesNotMatch(clean(stackedDetails[0]), /原生模型|headeredCols|textColor/);
assert.doesNotMatch(clean(stackedDetails.join('\n')), /当前活动/);
assert.ok(stackedDetails.some(row => row.includes(testTheme.bold('原生模型'))), 'expanded notice keeps Markdown emphasis');
assert.ok(stackedDetails.filter(row => /headeredCols|textColor/.test(clean(row))).length >= 2, 'notice prose keeps its line breaks');

// Screenshot regression: tool process, notice prose and activity previews stay
// in separate channels when a running child is expanded.
const compacted = liveAgentView([{
  runId: 'screenshot-child', mode: 'single', state: 'running', startedAt: 1000,
  steps: [{
    agent: 'worker', status: 'running',
    recentTools: [{ tool: 'read', args: '/Users/eachann/Work/goose-notes/' + 'very-long-baseline-path/'.repeat(8) + 'Column.tsx' }],
    recentOutput: ['碎片一 正在整理', '碎片二 继续整理', '碎片三 仍需整理'],
    notice: { summary: '代理间沟通已收纳', state: '内部协作', color: 'muted', internal: true },
    noticeMessages: [{ type: 'custom', customType: 'subagent_supervisor_reply', data: {
      requestId: 'req-1', runId: 'screenshot-child', agent: 'worker', childIndex: 0, createdAt: 1,
      message: '已读截图并对照：\n\n- **原生模型**支持 `headeredCols`\n- 单元格 textColor / backgroundColor',
    } }],
  }],
}], testTheme, 80, true, true, new Map(), completeClock);
const compactedDetails = compacted.rows.slice(1);
assert.match(clean(compacted.rows[0]), /代理间沟通已收纳/);
assert.match(clean(compactedDetails[0]), /^ {3}● read .*…$/, 'tool process stays one truncated line above the prose');
assert.ok(compacted.rows.every(row => visibleWidth(row) <= 80));
assert.doesNotMatch(clean(compactedDetails.join('\n')), /当前活动|碎片/);
assert.ok(compactedDetails.some(row => row.includes(testTheme.bold('原生模型'))), 'expanded reply keeps Markdown emphasis');
assert.equal(compactedDetails.filter(row => /headeredCols|textColor/.test(clean(row))).length, 2, 'expanded reply keeps one list item per row');

const unclickedNoticeView = liveAgentView([subagentWithNotice], testTheme, 120, false, true, new Map(), completeClock, new Set());
assert.ok(unclickedNoticeView.rows[0].includes(testTheme.fg('muted', '本轮代码已完成并通过所有测试')), 'unclicked subagent activity reverts to normal style');
assert.equal(unclickedNoticeView.rows.length, 1);

// Regression 5: Reload recovery from status directory
const reloadRoot = mkdtempSync(join(tmpdir(), 'mini-reload-test-'));
try {
  const reloadDir = join(reloadRoot, 'async-subagent-runs', singleAsyncId);
  mkdirSync(reloadDir, { recursive: true });
  writeFileSync(join(reloadDir, 'status.json'), JSON.stringify({
    sessionId: '/path/to/session.jsonl',
    runId: singleAsyncId,
    mode: 'single',
    state: 'running',
    steps: [{ agent: 'worker', status: 'running', recentOutput: ['Reloaded activity'] }],
  }));
  const loaded = readAgentStatuses('/path/to/session.jsonl', reloadRoot);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].runId, singleAsyncId);
  const matched = currentAgentStatuses(loaded, [singleCall]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].runId, singleAsyncId);
} finally { rmSync(reloadRoot, { recursive: true, force: true }); }

// Structured final whitelist mirrors real Pi JSONL: no channel, stop -> toolUse -> stop.
const finalRoot = mkdtempSync(join(tmpdir(), 'mini-agent-final-'));
try {
  const sessionFile = join(finalRoot, 'session.jsonl');
  const entry = (stopReason, content, extra = {}) => ({ type: 'message', message: { role: 'assistant', stopReason, content, ...extra } });
  const txt = text => ({ type: 'text', text });
  const tool = { type: 'toolCall', name: 'bash', arguments: { command: 'TOOL_INPUT' } };
  const process = entry('toolUse', [txt('PROCESS_ONLY'), tool]);
  const oldFinal = entry('stop', [txt('OLD_FINAL')]);
  const final = entry('stop', [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, txt('FINAL_FIRST'), txt('FINAL_SECOND')]);
  const status = { runId: 'final-run', mode: 'single', state: 'completed', startedAt: 1000,
    steps: [{ agent: 'worker', sessionFile, recentOutput: ['LOG_ONLY', 'PROCESS_ONLY', 'FINAL_FIRST'] }] };
  const write = entries => writeFileSync(sessionFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n{partial');
  const render = (statuses, expanded = true, ids) => liveAgentView(statuses, testTheme, 120, expanded, false, new Map(), 2000, ids);
  const body = statuses => clean(render(statuses).rows.slice(1).join('\n'));
  write([process, oldFinal, process]);
  assert.equal(body([status]).trim(), 'PROCESS_ONLY', 'the newest narration replaces the earlier stopped answer');
  assert.doesNotMatch(body([status]), /OLD_FINAL/);
  for (const [invalid, narration] of [
    [entry('toolUse', [txt('NARRATION')]), 'NARRATION'],
    [entry('length', [txt('NARRATION')]), 'NARRATION'],
    [entry('error', [txt('NARRATION')]), 'NARRATION'],
    [entry('aborted', [txt('NARRATION')]), 'NARRATION'],
    [entry('pending', [txt('NARRATION')]), 'NARRATION'],
    [entry(undefined, [txt('NARRATION')]), 'NARRATION'],
    [entry('stop', [txt('NARRATION'), tool]), 'NARRATION'],
    [entry('stop', [txt('NARRATION')], { channel: 'commentary' }), 'NARRATION'],
    [entry('stop', [txt('NARRATION')], { channel: 'analysis' }), 'NARRATION'],
    [entry('stop', 'NARRATION'), ''],
    [entry('stop', [null, { type: 'text', text: 42 }, { type: 'thinking', thinking: 'NARRATION' }]), ''],
    [entry('stop', [txt('NARRATION')], { role: 'toolResult' }), ''],
    [entry('stop', [txt('NARRATION')], { role: 'user' }), ''],
    [{ type: 'custom', message: { role: 'assistant', stopReason: 'stop', content: [txt('NARRATION')] } }, ''],
  ]) {
    write([invalid]);
    assert.equal(body([status]).trim(), narration, 'only a string text block of an assistant message is rendered');
    assert.equal(agentChildren(retainAgentStatuses([], [status]))[0].finalOutput, '', 'non-stopped messages never become the durable final');
  }
  write([process, oldFinal, process, final]);
  const source = JSON.stringify(status);
  let retained = retainAgentStatuses([], [status]);
  assert.equal(JSON.stringify(status), source, 'hydration never mutates producer snapshots');
  assert.equal(agentChildren(retained)[0].finalOutput, 'FINAL_FIRST\n\nFINAL_SECOND');
  for (const width of [1, 40, 120]) {
    const collapsed = liveAgentView(retained, testTheme, width);
    assert.equal(collapsed.rows.length, 1);
    assert.doesNotMatch(clean(collapsed.rows.join('\n')), /FINAL_|PROCESS_|LOG_|OLD_FINAL/);
  }
  assert.match(body(retained), /FINAL_FIRST[\s\S]*FINAL_SECOND/);
  assert.doesNotMatch(body(retained), /PROCESS_|LOG_|OLD_FINAL|PRIVATE_THINKING|TOOL_INPUT/);
  const other = { runId: 'other-final', steps: [{ agent: 'worker', status: 'completed', finalOutput: 'OTHER_FINAL' }] };
  const clicked = render([...retained, other], false, new Set(['final-run']));
  assert.match(clicked.rows.join('\n'), /FINAL_SECOND/);
  assert.doesNotMatch(clicked.rows.join('\n'), /OTHER_FINAL/);
  assert.match(render([...retained, other]).rows.join('\n'), /OTHER_FINAL/);

  write([process, oldFinal, process]);
  retained = retainAgentStatuses(retained, [status]);
  assert.equal(agentChildren(retained)[0].finalOutput, '', 'continued work clears persisted old final');
  assert.equal(body(retained).trim(), 'PROCESS_ONLY', 'continued work shows only its newest narration');
  assert.doesNotMatch(body(retained), /OLD_FINAL|LOG_ONLY|TOOL_INPUT/);
  write([process, final]);
  retained = retainAgentStatuses(retained, []);
  assert.match(body(retained), /FINAL_SECOND/, 'retained runs hydrate even after status directory disappears');
  const entries = JSON.parse(JSON.stringify(retained.map(data => ({ type: 'custom', customType: AGENT_STATUS_ENTRY, data }))));
  rmSync(sessionFile);
  const restored = retainAgentStatuses(savedAgentStatuses(entries), [status]);
  assert.match(body(restored), /FINAL_FIRST[\s\S]*FINAL_SECOND/, 'persisted final survives missing JSONL and producer snapshots without finalOutput');
  assert.equal(body([status]), '', 'legacy recentOutput never becomes trusted after session deletion');
  assert.equal(body(retainAgentStatuses(restored, [{ ...status, startedAt: 3000 }])), '', 'a new attempt cannot inherit old final');
  assert.equal(body(retainAgentStatuses(restored, [{ ...status, steps: [{ ...status.steps[0], sessionFile: join(finalRoot, 'new-missing.jsonl') }] }])), '', 'a replacement child session cannot inherit old final');
  const request = reason => ({ customType: 'subagent_supervisor_request', details: {
    runId: 'final-run', agent: 'worker', reason, expectsReply: true, requestBody: reason === 'progress_update' ? 'PROGRESS_HISTORY' : `KEEP_${reason}`,
  } });
  const errorNotice = { customType: 'subagent_control_notice', details: { event: {
    type: 'needs_attention', reason: 'tool_failures', agent: 'worker', message: 'KEEP_FAILURE', runId: 'final-run',
  } } };
  const notified = [{ ...restored[0], state: 'failed', error: 'KEEP_ERROR', noticeMessages: [
    request('progress_update'), request('need_decision'), request('interview_request'), errorNotice,
    'RAW_NOTICE', { content: 'UNKNOWN_NOTICE' }, request('progress_update'),
  ] }];
  const details = body(notified);
  assert.match(details, /KEEP_need_decision/);
  assert.match(details, /KEEP_interview_request/);
  assert.match(details, /KEEP_FAILURE/);
  assert.match(details, /KEEP_ERROR/);
  assert.match(details, /FINAL_SECOND/);
  assert.doesNotMatch(details, /PROGRESS_HISTORY|RAW_NOTICE|UNKNOWN_NOTICE|LOG_ONLY/);
  assert.match(clean(render(notified, false).rows[0]), /× .*KEEP_ERROR/);
} finally { rmSync(finalRoot, { recursive: true, force: true }); }

// Completed child body: the child's own newest prose, never activity previews.
const bodyRoot = mkdtempSync(join(tmpdir(), 'mini-agent-body-'));
try {
  const sessionFile = join(bodyRoot, 'session.jsonl');
  const text = value => ({ type: 'text', text: value });
  const stop = { type: 'message', message: { role: 'assistant', stopReason: 'stop',
    content: [text('三段正文：\n\n第一段说明改了什么。\n第二段说明验证了什么。')] } };
  const toolTurn = { type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
    content: [text('现在改动 renderer。'), { type: 'toolCall', name: 'write', arguments: { path: 'renderer.ts' } }] } };
  const child = { runId: 'body-child', mode: 'single', state: 'complete', startedAt: 1000, endedAt: 2000,
    steps: [{ agent: 'worker', status: 'complete', sessionFile, recentOutput: ['墙一 墙二 墙三'] }] };
  const write = entries => writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const details = () => liveAgentView([child], testTheme, 120, true, true, new Map(), completeClock).rows.slice(1).map(clean);
  write([toolTurn, stop]);
  assert.equal(details().filter(row => /第一段|第二段/.test(row)).length, 2, 'a stopped answer keeps its line breaks');
  assert.doesNotMatch(details().join('\n'), /墙一|现在改动/);
  write([toolTurn]);
  assert.match(details().join('\n'), /现在改动 renderer/, 'a child that ended on a tool call shows its newest prose instead of nothing');
  assert.doesNotMatch(details().join('\n'), /墙一|● write/);
  assert.equal(liveAgentView([child], testTheme, 120).rows.length, 1, 'activity previews stay hidden while collapsed');
  write([{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [text('中'.repeat(60))] } }]);
  const wrapped = liveAgentView([child], testTheme, 40, true, true, new Map(), completeClock);
  assert.equal([...clean(wrapped.rows.slice(1).join(''))].filter(ch => ch === '中').length, 60, 'literal CJK prose keeps every character when wrapped');
  assert.ok(wrapped.rows.every(row => visibleWidth(row) <= 40));
  const narrow = liveAgentView([child], testTheme, 5, true, true, new Map(), completeClock);
  assert.equal([...clean(narrow.rows.slice(1).join(''))].filter(ch => ch === '中').length, 60, 'narrow terminals still keep every literal character');
  assert.ok(narrow.rows.every(row => visibleWidth(row) <= 5));
} finally { rmSync(bodyRoot, { recursive: true, force: true }); }

console.log('Agent views: aggregation, failure, live widgets, restore, dark/light, widths PASS');
