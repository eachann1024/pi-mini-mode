// ponytail: fixture-only timings/content; replace this timer with existing Pi message_update,
// tool_execution_* and turn completion events after the user chooses a presentation.
const $ = selector => document.querySelector(selector);
const events = [...document.querySelectorAll('.event')];
const thoughtLines = [
  '定位现有过程树的渲染入口。',
  '检查 Thinking 时钟：需要持续更新，同时保留已经收到的正文。',
  '核对工具事件与 Agent 过程行的顺序，不改原来的执行链。',
  '确认折叠只影响显示；工具结果和思考正文仍可回看。',
];
const checkpoints = [
  [900, () => { state.thought = 1; render(); }],
  [2200, () => { state.thought = 2; render(); }],
  [3800, () => { state.thought = 3; render(); }],
  [5400, () => { state.tool = 1; render(); }],
  [6100, () => { state.tool = 2; render(); }],
  [6800, () => { state.tool = 3; render(); }],
  [7500, () => { state.tool = 4; render(); }],
  [8200, () => { state.tool = 5; render(); }],
  [8900, () => { state.tool = 6; render(); }],
  [9700, () => complete()],
];
let state, timers = [], clock, iconTimer;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function stopTimers() {
  timers.forEach(clearTimeout);
  timers = [];
  clearInterval(clock);
  clearInterval(iconTimer);
}

function render() {
  const thinking = !state.done && state.tool === 0;
  document.body.classList.toggle('is-working', !state.done);
  document.body.classList.toggle('is-thinking', thinking);
  $('#count').textContent = `${state.tool}/6`;
  $('#usage-s').textContent = state.done ? '47.4K' : state.tool ? `${(46 + state.tool * .2).toFixed(1)}K` : '46K';
  const duration = thinking ? Math.min((Date.now() - state.started) / 1000, 5.4).toFixed(1) : '5.4';
  for (const id of ['#thinking-time', '#summary-time', '#rail-time']) $(id).textContent = `${duration}s`;
  const last = thoughtLines[state.thought];
  $('#inline-preview').textContent = last;
  $('#thought-preview').textContent = last;
  $('#rail-text').textContent = last;
  $('#summary-preview').textContent = last;
  $('#thinking-body').textContent = thoughtLines.slice(0, state.thought + 1).join('\n');
  $('.thinking-event .row-icon').textContent = thinking ? '◌' : '●';
  const visible = new Set(events.slice(0, state.tool + 1).slice(-6));
  for (const event of events) {
    if (event.querySelector('details')?.open && events.indexOf(event) <= state.tool) visible.add(event);
    const show = state.expanded && (state.full || visible.has(event));
    const wasHidden = event.hidden;
    event.hidden = !show;
    if (wasHidden && show) {
      event.classList.remove('appearing');
      void event.offsetWidth;
      event.classList.add('appearing');
    }
  }
  $('#process-list').hidden = !state.expanded;
  $('#collapsed-summary').hidden = state.expanded || document.body.dataset.variant === 'inline';
  $('#agent-toggle').setAttribute('aria-expanded', String(state.expanded));
  $('#agent-toggle').setAttribute('aria-label', `${state.expanded ? '收起' : '展开最近 6 条'} Agent 过程`);
  $('#answer').hidden = !state.done;
  $('#mode-label').textContent = state.done
    ? '完成后自动收起 · 点击 Agent 看最近 6 条 · Ctrl+O 看全部'
    : '运行中：最多显示最近 6 条；每条详情默认折叠';
}

function complete() {
  stopTimers();
  state.done = true;
  state.thought = thoughtLines.length - 1;
  state.tool = 6;
  state.expanded = false;
  state.full = false;
  events.forEach(event => { event.querySelector('details').open = false; });
  $('.sparkle').textContent = '✦';
  render();
}

function restart() {
  stopTimers();
  events.forEach(event => { event.querySelector('details').open = false; event.classList.remove('appearing'); });
  state = { started: Date.now(), thought: 0, tool: 0, done: false, expanded: true, full: false };
  $('.sparkle').textContent = '✦';
  render();
  clock = setInterval(() => { if (state.tool === 0 && !state.done) render(); }, 100);
  if (!reduced.matches) iconTimer = setInterval(() => { $('.sparkle').textContent = $('.sparkle').textContent === '✦' ? '✧' : '✦'; }, 360);
  timers = checkpoints.map(([delay, update]) => setTimeout(update, delay));
}

$('#agent-toggle').addEventListener('click', () => { state.expanded = !state.expanded; state.full = false; render(); });
$('#collapsed-summary').addEventListener('click', () => { state.expanded = true; render(); $('#agent-toggle').focus(); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    state.full = !state.full;
    state.expanded = state.full;
    render();
  }
});
$('#replay').addEventListener('click', restart);
$('#finish').addEventListener('click', complete);
$('.thinking-event details').addEventListener('toggle', () => { if (state && !state.done) render(); });
reduced.addEventListener?.('change', () => {
  clearInterval(iconTimer);
  $('.sparkle').textContent = '✦';
  if (!reduced.matches && !state.done) iconTimer = setInterval(() => { $('.sparkle').textContent = $('.sparkle').textContent === '✦' ? '✧' : '✦'; }, 360);
});
restart();
