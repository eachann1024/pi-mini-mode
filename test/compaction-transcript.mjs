import assert from 'node:assert/strict';
import { Container, Text } from '@earendil-works/pi-tui';
import { attachTranscript } from '../lib/transcript-adapter.ts';

// Use Pi's real Container path: session compaction rebuilds this native component.
class UserMessageComponent extends Text {}
class CompactionSummaryMessageComponent extends Text {}

const document = new Container();
const header = new Container();
const resources = new Container();
const chat = new Container();
header.addChild(new Text('HEADER', 0, 0));
chat.addChild(new UserMessageComponent('EARLIER TURN', 0, 0));
chat.addChild(new UserMessageComponent('COMPACTION TURN', 0, 0));
chat.addChild(new CompactionSummaryMessageComponent('[compaction] Compacted from 1,024 tokens (Ctrl+O to expand)', 0, 0));
for (const child of [header, resources, chat]) document.addChild(child);
const editor = new Container();
editor.addChild({ render: () => [], invalidate() {}, getText: () => '' });
const tui = { children: [document, new Container(), new Container(), new Container(), editor, new Container(), new Container()] };
const view = { invalidate() {}, render(_width, notices) {
  return ['EARLIER TURN', ...(notices.get(0) ?? []), 'COMPACTION TURN', ...(notices.get(1) ?? [])];
} };

const restore = attachTranscript(tui, view);
assert.equal(typeof restore, 'function');
assert.deepEqual(document.render(80).map(row => row.trim()), ['HEADER', 'EARLIER TURN', 'COMPACTION TURN', '[compaction] Compacted from 1,024 tokens (Ctrl+O to expand)']);
restore();
// Real rebuild order: summary first, then only the retained user suffix.
const fullTurns = ['OLD', 'REPEATED', 'REPEATED'];
const restoreCompacted = attachTranscript(tui, {
  invalidate() {},
  render(_width, notices) {
    return fullTurns.flatMap((text, index) => [text, ...(notices.get(index) ?? [])]);
  },
}, { turnCount: () => fullTurns.length });
for (const retained of [1, 0]) {
  chat.clear();
  chat.addChild(new CompactionSummaryMessageComponent('COMPACTED', 0, 0));
  if (retained) chat.addChild(new UserMessageComponent('REPEATED', 0, 0));
  chat.addChild(new Text('Execution aborted', 0, 0));
  chat.addChild(new Text('Cache miss: 117k tokens re-billed', 0, 0));
  chat.addChild(new Text('Session Info\nMessages: 3', 0, 0));
  for (const width of [80, 40]) {
    assert.deepEqual(document.render(width).map(row => row.trim()), [
      'HEADER', 'OLD', 'REPEATED', ...(retained ? ['COMPACTED'] : []),
      'REPEATED', ...(!retained ? ['COMPACTED'] : []),
      'Execution aborted', 'Cache miss: 117k tokens re-billed', 'Session Info', 'Messages: 3',
    ]);
  }
}
// A later user turn must not pull earlier command output back to the top.
fullTurns.push('NEXT');
chat.addChild(new UserMessageComponent('NEXT', 0, 0));
chat.addChild(new Text('Session Info NEXT', 0, 0));
assert.equal(document.render(80).map(row => row.trim()).slice(-2).join('\n'), 'NEXT\nSession Info NEXT');
restoreCompacted();
assert.match(document.render(80).join('\n'), /Session Info/);
console.log('compaction transcript regression ok');
