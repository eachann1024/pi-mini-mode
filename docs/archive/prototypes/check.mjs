import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

const root = new URL('./thinking/', import.meta.url);
const pages = ['01-tree.html', '02-focus.html', '03-board.html'];
for (const name of pages) {
  const html = readFileSync(new URL(name, root), 'utf8');
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /id="replay"/);
  assert.match(html, /演示|模拟/);
  for (const other of pages) assert.ok(html.includes(`href="${other}"`), `${name} → ${other}`);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, `${name} has an interactive demo`);
  new Script(script, { filename: name });
}
console.log('Three self-contained interactive thinking prototypes: OK');

const revised = new URL('./thinking-v2/', import.meta.url);
const variants = ['01-inline.html', '02-under-row.html', '03-status-rail.html'];
const styles = readFileSync(new URL('styles.css', revised), 'utf8');
const logic = readFileSync(new URL('demo.js', revised), 'utf8');
new Script(logic, { filename: 'thinking-v2/demo.js' });
assert.match(styles, /prefers-reduced-motion:reduce/);
assert.match(logic, /slice\(-6\)/);
assert.match(logic, /state\.expanded = false/);
for (const name of variants) {
  const html = readFileSync(new URL(name, revised), 'utf8');
  assert.match(html, /class="sparkle"/);
  assert.match(html, /id="thinking-body"/);
  assert.match(html, /id="agent-toggle"/);
  for (const other of variants) assert.ok(html.includes(`href="${other}"`), `${name} → ${other}`);
}
console.log('Three incremental thinking variants: OK');
