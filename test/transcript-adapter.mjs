import assert from 'node:assert/strict';
import { Container, Text, ScrollView, visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
initTheme('dark', false);
const { attachTranscript, compactSupervisorNotice, supervisorNotice, supervisorNoticeBody } = await import('../lib/transcript-adapter.ts');
const { CustomEntryComponent } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js');

// Standalone failures retain their identity and error, including multiline directory metadata.
{
  const id = '4aea1aa4-0d9d-44ec-afa6-873b7e2ada15';
  const content = `Background task failed: **scout**\nscout:\n400: unsupported thinking level\nRetention-managed async directory:\n/tmp/async-subagent-runs/${id}\nSession file:\n/tmp/session.jsonl`;
  const message = { customType: 'subagent-notify', content };
  const notice = supervisorNotice(message);
  assert.equal(notice.runId, id);
  assert.equal(notice.summary, '400: unsupported thinking level');
  assert.equal(notice.state, '执行失败');
  assert.ok(supervisorNoticeBody(message).includes('/tmp/session.jsonl'));
  assert.equal(supervisorNotice({ ...message, content: content.replace('directory:\n', 'directory: ') }).runId, id);
  assert.equal(supervisorNotice({ ...message, content: content.split('\nRetention-managed')[0] }).runId, undefined);
  assert.equal(supervisorNotice({ ...message, content: content.replace(id, 'not-a-uuid') }).runId, undefined);
  const completed = `Background task completed: **workflow**\nWorkflow completed\nChild runs: format=${id} (failed)`;
  assert.equal(supervisorNotice({ ...message, content: completed }).state, '执行失败');
  assert.equal(supervisorNotice({ ...message, content: completed.replace('(failed)', '(completed)') }).state, '已完成');
}

// Real Pi TUI container and ScrollView objects, not an imitation of their render path.
const document = new Container();
const header = new Container();
const resources = new Container();
const chat = new Container();
header.addChild(new Text('HEADER', 0, 0));
class NativeMessage extends Text {}
chat.addChild(new NativeMessage('NATIVE MESSAGE', 0, 0));
chat.addChild(new Text('NATIVE ERROR', 0, 0));
for (const child of [header, resources, chat]) document.addChild(child);
const editor = new Container();
editor.addChild({ render: () => [], invalidate() {}, getText: () => '' });
const tui = { children: [document, new Container(), new Container(), new Container(), editor, new Container(), new Container()] };
const view = { render: () => ['MINIMAL'], invalidate() {} };
const originalRender = document.render;
const restore = attachTranscript(tui, view);
assert.equal(typeof restore, 'function');
assert.match(document.render(60).join('\n'), /HEADER.*\nNATIVE ERROR.*\nMINIMAL/);
assert.doesNotMatch(document.render(60).join('\n'), /NATIVE MESSAGE/);
const scroll = new ScrollView(document, { follow: 'end', primary: true });
assert.match(scroll.render(60).join('\n'), /MINIMAL/);
assert.equal(document.handleMouse({ type: 'click', button: 'left' }), undefined);
restore();
assert.equal(document.render, originalRender);
assert.equal(Object.hasOwn(document, 'render'), false);
assert.match(document.render(60).join('\n'), /NATIVE MESSAGE/);
assert.equal(attachTranscript({ children: [document] }, view), undefined);
assert.equal(attachTranscript({ ...tui, mode: 'regular' }, view), undefined, 'regular mode preserves Pi native scrollback diffing');
const restoreAgain = attachTranscript(tui, view);
const anotherExtension = () => ['OTHER'];
document.render = anotherExtension;
restoreAgain();
assert.equal(document.render, anotherExtension, 'cleanup must not overwrite another extension');
console.log('transcript adapter check ok (real Container / ScrollView, restore, fail closed)');

// Pi /reload emits session_start while the editor contains a notice container.
editor.clear();
const reloadBox = new Container();
reloadBox.addChild(new Text('Reloading...', 0, 0));
editor.addChild(reloadBox);
const restoreReload = attachTranscript(tui, view);
assert.equal(typeof restoreReload, 'function');
assert.match(document.render(60).join('\n'), /MINIMAL/);
restoreReload();

// Generic native notifications retain their native user-turn position.
class UserMessageComponent extends Text {}
chat.clear();
chat.addChild(new UserMessageComponent('FIRST'));
const info = new Text('INFO Default model', 0, 0);
chat.addChild(info);
chat.addChild(new Text('Cache miss FIRST', 0, 0));
chat.addChild(new UserMessageComponent('SECOND'));
chat.addChild(new Text('Cache miss SECOND', 0, 0));
let time = 0;
let scheduled;
let cancelled = 0;
let redraws = 0;
tui.requestRender = () => redraws++;
const restoreNotices = attachTranscript(tui, {
  invalidate() {},
  render(_width, notices) {
    return ['FIRST', ...(notices.get(0) ?? []), 'SECOND', ...(notices.get(1) ?? [])];
  },
}, {
  now: () => time,
  isTransient: text => text.startsWith('INFO '),
  schedule: (callback, delay) => { scheduled = { callback, delay }; return () => cancelled++; },
});
assert.deepEqual(document.render(80).map(s => s.trim()), ['HEADER', 'FIRST', 'INFO Default model', 'Cache miss FIRST', 'SECOND', 'Cache miss SECOND']);
assert.equal(scheduled.delay, 5000);
time = 4999;
assert.match(document.render(40).join('\n'), /Default model/);
assert.equal(scheduled.delay, 1);
time = 5000;
scheduled.callback();
assert.equal(redraws, 1, "expiry requests a redraw even when idle");
assert.doesNotMatch(document.render(80).join('\n'), /Default model/);
assert.match(document.render(80).map(s => s.trim()).join('\n'), /FIRST\nCache miss FIRST\nSECOND\nCache miss SECOND/);
info.setText('INFO Switched model');
assert.match(document.render(80).join('\n'), /Switched model/);
assert.equal(scheduled.delay, 5000);
restoreNotices();

assert.ok(cancelled > 0);
// Native notices remain intact, and switching sessions clears their placement.
assert.ok(chat.children.includes(info));
chat.clear();
const restoreEmpty = attachTranscript(tui, view);
assert.doesNotMatch(document.render(80).join('\n'), /Cache miss|Switched/);
restoreEmpty();

// A blocking prompt is preserved and never mistaken for a transient notification.
chat.addChild(new UserMessageComponent('PROMPT TURN'));
chat.addChild(new Text('填写 Pull Request 内容  [Enter to launch editor]', 0, 0));
let promptTime = 0;
const restorePrompt = attachTranscript(tui, {
  invalidate() {},
  render(_width, notices) { return ['PROMPT TURN', ...(notices.get(0) ?? [])]; },
}, {
  now: () => promptTime,
  isPrompt: text => text.includes('填写 Pull Request 内容'),
  isTransient: () => true,
});
assert.match(document.render(80).join('\n'), /填写 Pull Request 内容/);
promptTime = 6000;
assert.match(document.render(80).join('\n'), /填写 Pull Request 内容/, 'blocking prompt must not expire');
restorePrompt();
// Visible extension completion receipts are durable, including after resize and remount.
class CustomMessageComponent extends Text {}
chat.addChild(new CustomMessageComponent('CHILD COMPLETION RECEIPT', 0, 0));
const receiptView = { invalidate() {}, render(_width, notices) { return [...notices.values()].flat(); } };
const restoreReceipt = attachTranscript(tui, receiptView, { isTransient: () => true, now: () => promptTime });
assert.match(document.render(80).join('\n'), /CHILD COMPLETION RECEIPT/);
promptTime += 10000;
assert.match(document.render(40).join('\n'), /CHILD COMPLETION RECEIPT/);
restoreReceipt();
const restoreReceiptAgain = attachTranscript(tui, receiptView);
assert.match(document.render(80).join('\n'), /CHILD COMPLETION RECEIPT/);
restoreReceiptAgain();

// Pi rebuilds this native, initially folded component after a successful compaction.
// Minimal mode must retain its success row at the preceding user turn.
class CompactionSummaryMessageComponent extends Text {}
chat.clear();
chat.addChild(new UserMessageComponent('EARLIER TURN'));
chat.addChild(new UserMessageComponent('COMPACTION TURN'));
chat.addChild(new CompactionSummaryMessageComponent('[compaction] Compacted from 1,024 tokens (Ctrl+O to expand)', 0, 0));
const compactionView = { invalidate() {}, render(_width, notices) {
  return ['EARLIER TURN', ...(notices.get(0) ?? []), 'COMPACTION TURN', ...(notices.get(1) ?? [])];
} };
const restoreCompaction = attachTranscript(tui, compactionView);
assert.deepEqual(document.render(80).map(row => row.trim()), ['HEADER', 'EARLIER TURN', 'COMPACTION TURN', '[compaction] Compacted from 1,024 tokens (Ctrl+O to expand)']);
restoreCompaction();
console.log('notification check ok (expiry, update, resize, turn placement, cleanup, session clear)');

const supervisorTheme = { fg: (color, text) => `\x1b[${color === 'error' ? 31 : color === 'warning' ? 33 : 34}m${text}\x1b[0m` };
const supervisor = { customType: 'subagent_supervisor_request', content: 'Subagent progress update.\nRun: RUN_ID\nRequest ID: REQUEST_ID\nReply with: subagent_supervisor(...)',
  details: { agent: 'worker', reason: 'progress_update', requestBody: 'UPDATE: 已完成用户消息折叠', runId: 'RUN_ID', requestId: 'REQUEST_ID', childIndex: 0, childTarget: 'CHILD_TARGET', replyHint: 'subagent_supervisor(...)' } };
const snapshot = JSON.stringify(supervisor);
for (const width of [1, 2, 8, 20, 40, 80, 160]) {
  const rows = compactSupervisorNotice(supervisor, supervisorTheme, width, false);
  assert.ok(rows.length <= 2);
  assert.ok(rows.every(row => visibleWidth(row) <= width));
  assert.doesNotMatch(rows.join('\n'), /RUN_ID|REQUEST_ID|CHILD_TARGET|Child index|Reply with|subagent_supervisor/);
}
assert.equal(compactSupervisorNotice(supervisor, supervisorTheme, 160, false).length, 1, 'normal width uses one compact line');
assert.match(compactSupervisorNotice(supervisor, supervisorTheme, 160, false).join('\n'), /进度.*已完成用户消息折叠/);
for (const reason of ['need_decision', 'interview_request']) {
  const rows = compactSupervisorNotice({ ...supervisor, details: { ...supervisor.details, reason, expectsReply: true, requestBody: reason === 'interview_request' ? '需要结构化输入' : '是否继续执行？' } }, supervisorTheme, 100, false).join('\n');
  assert.match(rows, reason === 'interview_request' ? /需要提问/ : /需要裁决/);
  assert.match(rows, /\x1b\[33m/);
  assert.match(rows, reason === 'interview_request' ? /需要结构化输入/ : /是否继续执行/);
  assert.doesNotMatch(rows, /内部协作|代理间沟通已收纳|RUN_ID|Reply with/);
}
const interviewAsk = { ...supervisor, details: { ...supervisor.details, reason: 'interview_request', expectsReply: true, requestBody: '需要选择实现路径',
  interview: { title: '实现路径', questions: [{ prompt: '用哪条方案？', options: [{ label: '最小改动' }, { label: '重写模块' }] }] } } };
assert.match(compactSupervisorNotice(interviewAsk, supervisorTheme, 160, false).join('\n'), /需要提问.*需要选择实现路径/);
assert.doesNotMatch(compactSupervisorNotice(interviewAsk, supervisorTheme, 160, false).join('\n'), /用哪条方案|最小改动/);
assert.match(compactSupervisorNotice(interviewAsk, supervisorTheme, 160, true).join('\n'), /用哪条方案[\s\S]*最小改动[\s\S]*重写模块/);
assert.equal(compactSupervisorNotice({ ...interviewAsk, details: { ...interviewAsk.details, requestBody: '' } }, supervisorTheme, 160, false).join('\n').includes('实现路径'), true, 'interview title is the collapsed prompt when the body is empty');
for (const body of ['已完成：错误用 error 色，失败用 warning', 'Build failed', '当前阻塞，需要授权', 'No errors; failure handling tested']) {
  const rows = compactSupervisorNotice({ ...supervisor, details: { ...supervisor.details, requestBody: body } }, supervisorTheme, 160, false).join('\n');
  assert.match(rows, /进度/);
  assert.doesNotMatch(rows, /\x1b\[31m|\x1b\[33m|执行失败/);
}
const attention = { customType: 'subagent_control_notice', content: 'Run: RUN_ID\nStatus: subagent(...)', details: { event: { type: 'needs_attention', agent: 'reviewer', message: 'Waiting for supervisor reply' } } };
assert.match(compactSupervisorNotice(attention, supervisorTheme, 120, false).join('\n'), /⚠ 需要关注.*Waiting for supervisor reply/);
assert.match(compactSupervisorNotice({ ...attention, details: { event: { ...attention.details.event, reason: 'completion_guard' } } }, supervisorTheme, 120, false).join('\n'), /\x1b\[31m× 执行失败/);
assert.equal(compactSupervisorNotice({ ...supervisor, customType: 'ordinary_message' }, supervisorTheme, 100, false), undefined);
assert.equal(compactSupervisorNotice({ role: 'user', content: supervisor.content }, supervisorTheme, 100, false), undefined);
assert.equal(compactSupervisorNotice({ ...supervisor, details: { reason: 'unknown' } }, supervisorTheme, 100, false), undefined);
const complete = compactSupervisorNotice(supervisor, supervisorTheme, 100, true).join('\n');
assert.doesNotMatch(complete, /RUN_ID|REQUEST_ID|CHILD_TARGET|Reply with/);
assert.match(complete, /已完成用户消息折叠/);
assert.ok(complete.includes('\x1b[34m[收起]\x1b[0m'), 'expanded control uses accent');
assert.equal(JSON.stringify(supervisor), snapshot);
assert.equal(compactSupervisorNotice(supervisor, supervisorTheme, 160, true).length, 1, 'standalone progress has no expanded body');
const progressHistory = { ...supervisor, details: { ...supervisor.details, requestBody: 'HIDDEN_PROGRESS', expectsReply: true } };
const decisionHistory = ['need_decision', 'interview_request'].map(reason => ({ ...supervisor,
  details: { ...supervisor.details, reason, expectsReply: true, requestBody: `VISIBLE_${reason}` },
}));
const independentDetails = compactSupervisorNotice(attention, supervisorTheme, 160, true, '', [progressHistory, ...decisionHistory, attention, progressHistory]).slice(1).join('\n');
assert.doesNotMatch(independentDetails, /HIDDEN_PROGRESS/);
assert.match(independentDetails, /VISIBLE_need_decision[\s\S]*VISIBLE_interview_request[\s\S]*Waiting for supervisor reply/);

// pi-subagents 0.67.0 incremental child notifications only carry their known
// customType and formatted content. Keep task/result/error visible; fold IDs,
// artifact paths, and fan-out quota into on-demand details.
const incrementalChildFailure = {
  customType: 'subagent-incremental-child-notify',
  content: 'Workflow child failed: **beta-readonly**\nWorkflow run: cf5f2c47-399c-4520-a883-5c0c3f8375b9\nChild run: 98b2852e-2054-4c91-8fa9-bcc1ebf55323\nOutput: /var/folders/sm/b1_d84y51m3276xr4skfk96m0000gn/T/pi-subagents-uid-501/async-subagent-runs/98b2852e-2054-4c91-8fa9-bcc1ebf55323\nError: Run fan-out: 2/64 used, 62 remaining\nConnection error.\nStatus: workflow still running',
};
const incrementalCompact = compactSupervisorNotice(incrementalChildFailure, supervisorTheme, 160, false).join('\n');
assert.match(incrementalCompact, /执行失败.*beta-readonly.*Connection error/);
assert.doesNotMatch(incrementalCompact, /cf5f2c47|98b2852e|\/var\/folders|fan-out/i);
const incrementalDetails = compactSupervisorNotice(incrementalChildFailure, supervisorTheme, 160, true).join('\n');
assert.match(incrementalDetails, /Workflow run: cf5f2c47/);
assert.match(incrementalDetails, /Child run: 98b2852e/);
assert.match(incrementalDetails, /Output: \/var\/folders/);
assert.match(incrementalDetails, /Run fan-out: 2\/64 used, 62 remaining/);
assert.match(incrementalDetails, /Connection error/);
assert.equal(compactSupervisorNotice({ ...incrementalChildFailure, customType: 'unknown-child-notify' }, supervisorTheme, 160, false), undefined);
chat.clear();
chat.addChild(new UserMessageComponent('INCREMENTAL TURN'));
const incrementalCard = new CustomMessageComponent('NATIVE_INCREMENTAL_CARD', 0, 0);
incrementalCard.message = incrementalChildFailure;
chat.addChild(incrementalCard);
let incrementalExpanded = false;
const restoreIncremental = attachTranscript(tui, receiptView, {
  supervisor: { theme: supervisorTheme, expanded: () => incrementalExpanded },
});
const renderedIncremental = document.render(160).join('\n');
assert.match(renderedIncremental, /执行失败.*beta-readonly.*Connection error/);
assert.doesNotMatch(renderedIncremental, /cf5f2c47|98b2852e|\/var\/folders|fan-out/i);
incrementalExpanded = true;
const renderedIncrementalDetails = document.render(160).join('\n');
assert.match(renderedIncrementalDetails, /Workflow run: cf5f2c47/);
assert.match(renderedIncrementalDetails, /Run fan-out: 2\/64 used, 62 remaining/);
restoreIncremental();
const handledChildren = new Set(['98b2852e-2054-4c91-8fa9-bcc1ebf55323']);
let collectedNotice;
const restoreCollected = attachTranscript(tui, receiptView, {
  supervisor: { theme: supervisorTheme, expanded: () => false, handledRunIds: () => handledChildren,
    onNotices: groups => { collectedNotice = [...groups.values()][0]; } },
});
assert.doesNotMatch(document.render(160).join('\n'), /执行失败|Connection error/);
assert.equal(collectedNotice.notice.runId, [...handledChildren][0]);
assert.ok(collectedNotice.notice.runIds.includes('cf5f2c47-399c-4520-a883-5c0c3f8375b9'));
assert.equal(collectedNotice.messages[0], incrementalChildFailure, 'collected errors retain full original details');
handledChildren.clear();
handledChildren.add('cf5f2c47-399c-4520-a883-5c0c3f8375b9');
assert.doesNotMatch(document.render(160).join('\n'), /执行失败|Connection error/, 'owned workflow id also hides an incremental child card');
handledChildren.clear();
assert.match(document.render(160).join('\n'), /执行失败.*Connection error/, 'unowned failures must never be hidden');
restoreCollected();
const spawnFail = {
  customType: 'subagent-incremental-child-notify',
  content: "Workflow child failed: **scout-text-blocks**\nWorkflow run: 01fb2369-60b1-4adb-9dc8-6167673f8975\nError: Unknown subagent model 'fast' in the active Pi model registry.\nStatus: workflow still running",
};
assert.equal(supervisorNotice(spawnFail).runId, '01fb2369-60b1-4adb-9dc8-6167673f8975');
assert.deepEqual(supervisorNotice(spawnFail).runIds, ['01fb2369-60b1-4adb-9dc8-6167673f8975']);
assert.match(compactSupervisorNotice(spawnFail, supervisorTheme, 160, false).join('\n'), /执行失败.*scout-text-blocks.*Unknown subagent model/);
chat.clear();
chat.addChild(new UserMessageComponent('SPAWN FAIL TURN'));
const spawnCard = new CustomMessageComponent('NATIVE_SPAWN_FAIL', 0, 0);
spawnCard.message = spawnFail;
chat.addChild(spawnCard);
const handledSpawn = new Set(['01fb2369-60b1-4adb-9dc8-6167673f8975']);
let collectedSpawn;
const restoreSpawn = attachTranscript(tui, receiptView, {
  supervisor: { theme: supervisorTheme, expanded: () => false, handledRunIds: () => handledSpawn,
    onNotices: groups => { collectedSpawn = [...groups.values()][0]; } },
});
assert.doesNotMatch(document.render(160).join('\n'), /执行失败|Unknown subagent model|NATIVE_SPAWN_FAIL/);
assert.equal(collectedSpawn.notice.runId, [...handledSpawn][0]);
handledSpawn.clear();
assert.match(document.render(160).join('\n'), /执行失败.*scout-text-blocks.*Unknown subagent model/, 'unowned spawn failures stay visible');
restoreSpawn();
const receiptOnly = {
  customType: 'subagent-notify',
  content: 'Background task failed: **workflow**\nWorkflow receipt: /tmp/async-subagent-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflow-receipt.json\n\nRequest timed out.',
};
assert.equal(supervisorNotice(receiptOnly).runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.ok(supervisorNotice(receiptOnly).runIds.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
const workflowNotify = {
  customType: 'subagent-notify',
  content: 'Background task failed: **workflow**\nWorkflow receipt: /tmp/receipt.json\n\n\x1b[31mRequest timed out.\x1b[0m\n\nWorkflow run: 11111111-1111-4111-8111-111111111111\nChild runs: prepare-image=22222222-2222-4222-8222-222222222222 (failed)',
};
assert.equal(supervisorNotice(workflowNotify).summary, 'Request timed out.', 'notify preview is cleaned before it becomes a heading');
const workflowCompact = compactSupervisorNotice(workflowNotify, supervisorTheme, 160, false).join('\n');
assert.match(workflowCompact, /执行失败.*workflow.*Request timed out/);
assert.doesNotMatch(workflowCompact, /11111111|22222222|receipt.json|full notification/i);
assert.equal(compactSupervisorNotice({ ...workflowNotify, customType: 'unknown-notify' }, supervisorTheme, 160, false), undefined);
chat.clear();
chat.addChild(new UserMessageComponent('NOTIFY TURN'));
const workflowCard = new CustomMessageComponent('NATIVE_WORKFLOW_FAILED', 0, 0);
workflowCard.message = workflowNotify;
chat.addChild(workflowCard);
const handledWorkflow = new Set(['22222222-2222-4222-8222-222222222222']);
let collectedWorkflow;
const restoreWorkflow = attachTranscript(tui, receiptView, {
  supervisor: { theme: supervisorTheme, expanded: () => false, handledRunIds: () => handledWorkflow,
    onNotices: groups => { collectedWorkflow = [...groups.values()][0]; } },
});
assert.doesNotMatch(document.render(160).join('\n'), /执行失败|Request timed out|NATIVE_WORKFLOW_FAILED/);
assert.equal(collectedWorkflow.notice.runId, '11111111-1111-4111-8111-111111111111');
assert.ok(collectedWorkflow.notice.runIds.includes('22222222-2222-4222-8222-222222222222'));
handledWorkflow.clear();
handledWorkflow.add('11111111-1111-4111-8111-111111111111');
assert.doesNotMatch(document.render(160).join('\n'), /执行失败|Request timed out|NATIVE_WORKFLOW_FAILED/, 'parent workflow id also hides the native card');
handledWorkflow.clear();
assert.match(document.render(160).join('\n'), /执行失败.*workflow.*Request timed out/);
assert.doesNotMatch(document.render(160).join('\n'), /NATIVE_WORKFLOW_FAILED|full notification/i);
restoreWorkflow();
// Route only recognized native custom messages; retain receipts, prompts, and turn position.
chat.clear();
chat.addChild(new UserMessageComponent('USER'));
const supervisorCard = new CustomMessageComponent('NATIVE_FULL_SUPERVISOR_CARD', 0, 0);
supervisorCard.message = supervisor;
chat.addChild(supervisorCard);
chat.addChild(new CustomMessageComponent('DURABLE_RECEIPT', 0, 0));
let detailsExpanded = false;
const restoreCompact = attachTranscript(tui, receiptView, {
  supervisor: { theme: supervisorTheme, expanded: () => detailsExpanded },
  isTransient: () => true, now: () => 999999999,
});
assert.doesNotMatch(document.render(120).join('\n'), /NATIVE_FULL|RUN_ID/);
assert.match(document.render(120).join('\n'), /DURABLE_RECEIPT/);
detailsExpanded = true;
assert.match(document.render(120).join('\n'), /已完成用户消息折叠/);
assert.doesNotMatch(document.render(120).join('\n'), /RUN_ID/);
restoreCompact();
assert.equal(document.render, anotherExtension, 'cleanup restores the prior renderer');
assert.match(chat.render(120).join('\n'), /NATIVE_FULL_SUPERVISOR_CARD/);
assert.equal(JSON.stringify(supervisor), snapshot);
console.log('Supervisor notices PASS: typed metadata, one/two rows, Chinese states, prose error never escalates, visible asks, true control failures, full details and restore.');

// Stable run+child groups retain their first turn/row and every original detail.
chat.clear();
const addNotice = (message) => { const card = new CustomMessageComponent('NATIVE', 0, 0); card.message = message; chat.addChild(card); return card; };
const update = (body, extra = {}) => ({ ...supervisor, details: { ...supervisor.details, requestBody: body, ...extra } });
chat.addChild(new UserMessageComponent('FIRST'));
addNotice(update('OLD_PROGRESS'));
chat.addChild(new UserMessageComponent('SECOND'));
addNotice(update('NEW_PROGRESS'));
addNotice(update('PRIVATE_QUESTION', { reason: 'need_decision', expectsReply: true }));
addNotice(update('OTHER_CHILD', { childIndex: 1 }));
addNotice(update('OTHER_RUN', { runId: 'OTHER_RUN_ID' }));
addNotice(update('MISSING_IDENTITY_A', { runId: undefined }));
addNotice(update('MISSING_IDENTITY_B', { runId: undefined }));
let captured;
const groupedRestore = attachTranscript(tui, { invalidate() {}, render(_width, notices) {
  captured = notices;
  return ['FIRST', ...(notices.get(0) ?? []), 'SECOND', ...(notices.get(1) ?? [])];
} }, { supervisor: { theme: supervisorTheme, expanded: () => detailsExpanded } });
detailsExpanded = false;
let grouped = document.render(160).join('\n');
assert.equal((grouped.match(/\[详情\]/g) ?? []).length, 5);
assert.doesNotMatch(grouped, /OLD_PROGRESS|NEW_PROGRESS|worker|RUN_ID/);
assert.match(grouped, /FIRST[\s\S]*需要裁决.*PRIVATE_QUESTION[\s\S]*SECOND[\s\S]*OTHER_CHILD/);
assert.match(grouped, /任务 1/);
assert.match(grouped, /OTHER_RUN/);
assert.match(grouped, /MISSING_IDENTITY_A[\s\S]*MISSING_IDENTITY_B/);
const event = { type: 'click', button: 'left', x: 1, y: 0, clickCount: 1 };
const hit = captured.get(0).handleMouse;
for (const change of [{ type: 'drag' }, { type: 'wheel' }, { shift: true }, { ctrl: true }, { alt: true }, { clickCount: 2 }, { y: 2 }]) assert.equal(hit({ ...event, ...change }), undefined);
assert.deepEqual(hit({ ...event, type: 'press' }), { handled: true });
assert.deepEqual(hit(event), { handled: true, render: true });
grouped = document.render(160).join('\n');
assert.match(grouped, /PRIVATE_QUESTION/);
assert.doesNotMatch(grouped, /OLD_PROGRESS|NEW_PROGRESS/, 'click expansion does not revive progress history');
assert.doesNotMatch(grouped, /REQUEST_ID/);
assert.equal((grouped.match(/\[收起\]/g) ?? []).length, 1, 'click opens only this task');
detailsExpanded = true;
assert.equal((document.render(160).join('\n').match(/\[收起\]/g) ?? []).length, 5, 'keyboard opens all');
detailsExpanded = false;
assert.match(document.render(160).join('\n'), /需要裁决.*PRIVATE_QUESTION/, 'pending ask stays in the collapsed prompt');
assert.doesNotMatch(document.render(160).join('\n'), /OLD_PROGRESS/, 'keyboard closes clicked details too');
const failure = { ...attention, details: { event: { ...attention.details.event, runId: 'RUN_ID', index: 0, reason: 'tool_failures', label: '验证', message: 'TEST_COMMAND_FAILED' } } };
addNotice(failure);
addNotice(update('LATER_ORDINARY_PROGRESS'));
grouped = document.render(160).join('\n');
assert.match(grouped, /执行失败 · 验证.*TEST_COMMAND_FAILED/);
assert.doesNotMatch(grouped, /LATER_ORDINARY_PROGRESS/, 'ordinary updates cannot bury failures');
addNotice({ ...failure, details: { event: { ...failure.details.event, reason: 'idle', message: 'Waiting' } } });
assert.match(document.render(160).join('\n'), /执行失败.*TEST_COMMAND_FAILED/, 'generic attention cannot downgrade a real failure');
for (const width of [1, 2, 8, 20, 40, 80, 160]) { document.render(width); assert.ok([...captured.values()].flat().every(row => visibleWidth(row) <= width)); }
groupedRestore();
assert.equal(chat.children.length, 12, 'aggregation never removes native messages');
assert.match(chat.render(160).join('\n'), /NATIVE/);
console.log('Supervisor aggregation PASS: first-turn placement, stable run+child, missing/nested identity isolation, visible asks, sticky failures, click/key independence.');

const internalAttention = { ...attention, details: { event: { ...attention.details.event, reason: 'supervisor_request' } } };
assert.match(compactSupervisorNotice(internalAttention, supervisorTheme, 100, false).join('\n'), /内部协作/);
assert.doesNotMatch(compactSupervisorNotice(internalAttention, supervisorTheme, 100, false).join('\n'), /\x1b\[33m|需要关注|Waiting/);
// Nested controls with identical parent identity must not collapse unrelated nested runs.
chat.clear();
chat.addChild(new UserMessageComponent('NESTED_TURN'));
for (const nestedRunId of ['nested-a', 'nested-b']) addNotice({ ...failure, details: { event: { ...failure.details.event, nestedRunId } } });
const nestedRestore = attachTranscript(tui, receiptView, { supervisor: { theme: supervisorTheme, expanded: () => false } });
assert.equal((document.render(160).join('\n').match(/\[详情\]/g) ?? []).length, 2);
nestedRestore();

// Replies are durable custom entries, not CustomMessageComponent messages.
const reply = { type: 'custom', id: 'reply-entry', parentId: null, timestamp: '2026-09-11T02:00:00Z',
  customType: 'subagent_supervisor_reply', data: { requestId: 'REQUEST_ID', runId: 'RUN_ID', agent: 'worker',
    childIndex: 0, message: 'REPLY_BODY\n\nReply second paragraph: failed/error is prose.', createdAt: 1000 } };
const replySnapshot = JSON.stringify(reply);
const nativeReply = entry => new CustomEntryComponent(entry, () => new Text('Supervisor reply to child\nNATIVE_REPLY_BODY', 0, 0));
for (const reason of [undefined, 'need_decision', 'interview_request', 'progress_update']) {
  const entry = { ...reply, data: { ...reply.data, reason } };
  assert.equal(supervisorNotice(entry).internal, true);
  assert.equal(supervisorNotice(entry).alert, false);
  assert.equal(supervisorNoticeBody(entry), reply.data.message, 'progress_update reply still has detail prose');
  for (const width of [1, 2, 8, 20, 40, 80, 160]) {
    const rows = compactSupervisorNotice(entry, supervisorTheme, width, false);
    assert.ok(rows.length <= 2 && rows.every(row => visibleWidth(row) <= width));
    assert.doesNotMatch(rows.join('\n'), /REPLY_BODY|REQUEST_ID|RUN_ID|failed|error/);
  }
}
const listReply = { ...reply, data: { ...reply.data,
  message: '已读截图并对照：\n\n- **原生模型**支持 `headeredCols`\n- 单元格 textColor / backgroundColor' } };
assert.equal(supervisorNoticeBody(listReply), listReply.data.message, 'a reply body is never flattened into preview prose');
const listExpanded = compactSupervisorNotice(listReply, supervisorTheme, 160, true);
assert.ok(listExpanded.length > 1);
assert.ok(listExpanded.every(row => visibleWidth(row) <= 160));
assert.equal(listExpanded.filter(row => /headeredCols|textColor/.test(row)).length, 2, 'expanded reply keeps one Markdown list item per row');
assert.equal(compactSupervisorNotice(listReply, supervisorTheme, 160, false).length, 1, 'the list stays out of the collapsed heading');
for (const childIndex of [-1, 0.5]) assert.equal(supervisorNotice({ ...reply, data: { ...reply.data, childIndex } }).key, undefined);
for (const extra of [{ nestedRunId: 'nested' }, { nestingPath: [0] }]) {
  assert.equal(supervisorNotice({ ...reply, data: { ...reply.data, ...extra } }).key, undefined);
}
const invalidReplies = [
  ...[undefined, 'custom_message', 'message'].map(type => ({ ...reply, type })),
  { role: 'user', content: 'Supervisor reply to child' },
  { ...reply, customType: 'unknown-reply' },
  { ...reply, customType: 'subagent_supervisor_request', details: supervisor.details },
  ...[undefined, null, [], {}, { ...reply.data, message: 123 }, { ...reply.data, requestId: null },
    { ...reply.data, runId: 1 }, { ...reply.data, agent: false }, { ...reply.data, childIndex: NaN },
    { ...reply.data, createdAt: Infinity }, { ...reply.data, reason: 'unknown' },
    { ...reply.data, reason: { toString: () => 'need_decision' } },
    { ...reply.data, childTarget: 123 }].map(data => ({ ...reply, data })),
];
for (const invalid of invalidReplies) {
  assert.equal(supervisorNotice(invalid), undefined);
  chat.clear(); chat.addChild(nativeReply(invalid));
  const cleanup = attachTranscript(tui, view, { supervisor: { theme: supervisorTheme, expanded: () => false } });
  assert.match(document.render(160).join('\n'), /Supervisor reply to child[\s\S]*NATIVE_REPLY_BODY/, 'invalid/unknown entries retain native rendering even with the same title');
  cleanup();
}
chat.clear();
chat.addChild(nativeReply(reply)); // No user turn or child snapshot: prefix notice remains inspectable.
let replyExpanded = false;
let replyGroups;
const replyOptions = { supervisor: { theme: supervisorTheme, expanded: () => replyExpanded, onNotices: groups => { replyGroups = groups; } } };
let restoreReply = attachTranscript(tui, view, replyOptions);
let replyRows = document.render(160);
assert.match(replyRows.join('\n'), /内部协作.*代理间沟通已收纳/);
assert.doesNotMatch(replyRows.join('\n'), /Supervisor reply to child|NATIVE_REPLY_BODY|REPLY_BODY/);
assert.equal([...replyGroups.values()][0].messages[0], reply);
const replyClick = { ...event, y: 1 }; // HEADER precedes prefix notices.
assert.deepEqual(document.handleMouse({ ...replyClick, type: 'press' }), { handled: true });
assert.deepEqual(document.handleMouse(replyClick), { handled: true, render: true });
assert.match(document.render(160).join('\n'), /REPLY_BODY[\s\S]*Reply second paragraph/);
for (const width of [2, 8, 20, 40, 80, 160]) assert.ok(document.render(width).slice(0, -1).every(row => visibleWidth(row) <= width));
document.handleMouse(replyClick);
assert.doesNotMatch(document.render(160).join('\n'), /REPLY_BODY/);
replyExpanded = true;
assert.match(document.render(160).join('\n'), /REPLY_BODY/);
replyExpanded = false;
assert.doesNotMatch(document.render(160).join('\n'), /REPLY_BODY/);
restoreReply();
assert.match(chat.render(160).join('\n'), /Supervisor reply to child[\s\S]*NATIVE_REPLY_BODY/);
chat.clear(); chat.addChild(nativeReply(JSON.parse(replySnapshot)));
restoreReply = attachTranscript(tui, view, replyOptions); // /reload reconstructs the native component.
assert.doesNotMatch(document.render(160).join('\n'), /REPLY_BODY|NATIVE_REPLY_BODY/);
document.handleMouse(replyClick);
assert.match(document.render(160).join('\n'), /REPLY_BODY/);
restoreReply();

// Request/reply share the first turn; replies never clear an earlier failure.
chat.clear();
chat.addChild(new UserMessageComponent('FIRST'));
addNotice(update('REQUEST_BODY', { reason: 'need_decision' }));
chat.addChild(new UserMessageComponent('SECOND'));
chat.addChild(nativeReply(reply));
const restoreReplyGroup = attachTranscript(tui, { invalidate() {}, render(_width, notices) {
  captured = notices;
  return ['FIRST', ...(notices.get(0) ?? []), 'SECOND', ...(notices.get(1) ?? [])];
} }, replyOptions);
assert.equal((document.render(160).join('\n').match(/\[详情\]/g) ?? []).length, 1);
assert.equal(captured.get(1), undefined);
assert.match(document.render(160).join('\n'), /内部协作.*代理间沟通已收纳/);
assert.doesNotMatch(document.render(160).join('\n'), /需要裁决|REQUEST_BODY/, 'a reply resolves the visible ask');
captured.get(0).handleMouse(event);
assert.match(document.render(160).join('\n'), /FIRST[\s\S]*REQUEST_BODY[\s\S]*REPLY_BODY[\s\S]*SECOND/);
addNotice(failure);
chat.addChild(nativeReply({ ...reply, data: { ...reply.data, message: 'LATER_REPLY' } }));
assert.match(document.render(160).join('\n'), /执行失败.*TEST_COMMAND_FAILED/);
assert.match(document.render(160).join('\n'), /REQUEST_BODY[\s\S]*REPLY_BODY[\s\S]*TEST_COMMAND_FAILED[\s\S]*LATER_REPLY/);
restoreReplyGroup();
assert.equal(JSON.stringify(reply), replySnapshot);
console.log('Supervisor reply PASS: real CustomEntryComponent, strict envelope/data whitelist, standalone, request grouping, sticky failure, reload, click/Ctrl+O, narrow width, native fallback.');

// Exercise the existing notice -> owning child -> persisted snapshot chain with the real view.
const { minimalOutputComponent } = await import('../extensions/footer-status.ts');
const { AGENT_STATUS_ENTRY, agentChildren, agentStatusesByTurn, savedAgentStatuses, retainAgentStatuses } = await import('../lib/agent-view.ts');
const childTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
const dispatchTurns = [{ question: 'DISPATCH_TURN', process: [], agentCalls: [{ id: 'dispatch', name: 'subagent', state: 'done' }] },
  { question: 'FOLLOWUP_TURN', process: [], agentCalls: [] }];
let childStatuses = [{ runId: 'RUN_ID', toolCallId: 'dispatch', mode: 'single', state: 'failed', startedAt: 1000, endedAt: 2000,
  steps: [{ agent: 'worker', status: 'failed', error: 'CHILD_ERROR', finalOutput: 'FINAL_OUTPUT', recentOutput: ['UNSAFE_LOG'] }] }];
const ownedRuns = new Set();
const matchedView = () => minimalOutputComponent(childTheme, () => {
  const assigned = agentStatusesByTurn(childStatuses, dispatchTurns);
  ownedRuns.clear();
  return dispatchTurns.map((turn, i) => {
    const subAgents = agentChildren(assigned.get(i) ?? []);
    subAgents.forEach(child => ownedRuns.add(child.runId));
    return { ...turn, subAgents };
  });
});
chat.clear();
chat.addChild(new UserMessageComponent('DISPATCH_TURN'));
chat.addChild(new UserMessageComponent('FOLLOWUP_TURN'));
const matchedNative = nativeReply(reply);
chat.addChild(matchedNative);
const matchedOptions = { supervisor: { theme: childTheme, expanded: () => false, handledRunIds: () => ownedRuns,
  onNotices: groups => {
    // Same snapshot fields used by footer-status.ts; no new persistence format.
    for (const group of groups.values()) childStatuses = childStatuses.map(status => status.runId === group.notice.runId
      ? { ...status, notice: group.notice, noticeMessages: group.messages } : status);
  },
} };
let childView = matchedView();
let restoreMatched = attachTranscript(tui, childView, matchedOptions);
document.render(160); // Existing handledRunIds is populated by the first view render.
let matchedRows = document.render(160);
assert.equal((matchedRows.join('\n').match(/代理间沟通已收纳/g) ?? []).length, 1);
assert.doesNotMatch(matchedRows.join('\n'), /REPLY_BODY|NATIVE_REPLY_BODY|FINAL_OUTPUT|UNSAFE_LOG/);
let childY = matchedRows.findIndex(row => row.includes('SubAgent'));
assert.ok(childY > 0);
assert.deepEqual(document.handleMouse({ ...event, x: 3, y: childY }), { handled: true, render: true });
matchedRows = document.render(160);
assert.match(matchedRows.join('\n'), /DISPATCH_TURN[\s\S]*REPLY_BODY[\s\S]*FINAL_OUTPUT[\s\S]*CHILD_ERROR[\s\S]*FOLLOWUP_TURN/);
assert.doesNotMatch(matchedRows.join('\n'), /UNSAFE_LOG|NATIVE_REPLY_BODY/);
for (const width of [8, 20, 40, 80, 160]) assert.ok(document.render(width).every(row => visibleWidth(row) <= width));
const savedReplyStatuses = JSON.parse(JSON.stringify(childStatuses.map(data => ({ type: 'custom', customType: AGENT_STATUS_ENTRY, data }))));
restoreMatched();
assert.ok(chat.children.includes(matchedNative), 'collection does not remove the native entry');
// A compacted/reloaded suffix can omit the original reply; the stored child remains inspectable.
chat.clear(); chat.addChild(new UserMessageComponent('FOLLOWUP_TURN'));
childStatuses = retainAgentStatuses(savedAgentStatuses(savedReplyStatuses), []);
childView = matchedView();
restoreMatched = attachTranscript(tui, childView, { ...matchedOptions, turnCount: () => dispatchTurns.length });
matchedRows = document.render(160);
assert.doesNotMatch(matchedRows.join('\n'), /REPLY_BODY|FINAL_OUTPUT/);
childY = matchedRows.findIndex(row => row.includes('SubAgent'));
document.handleMouse({ ...event, x: 3, y: childY });
matchedRows = document.render(160);
assert.match(matchedRows.join('\n'), /DISPATCH_TURN[\s\S]*REPLY_BODY[\s\S]*FINAL_OUTPUT[\s\S]*CHILD_ERROR[\s\S]*FOLLOWUP_TURN/);
restoreMatched();
assert.equal(JSON.stringify(reply), replySnapshot);
console.log('Supervisor reply ownership PASS: real minimal child click, delayed reply stays at dispatch turn, no duplicate card, finalOutput/error whitelist retained, JSON snapshot + empty live status + compacted suffix reload.');
