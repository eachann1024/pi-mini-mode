import assert from 'node:assert/strict';
import { startSettingsWeb } from '../lib/settings-web.ts';
let settings = { enabled: true };
let writes = 0;
const web = await startSettingsWeb(() => settings, async value => {
  if (typeof value.enabled !== 'boolean') throw new TypeError('invalid');
  if (value.fail) throw new Error('disk failure');
  settings = value;
  writes++;
});
const url = new URL(web.url);
const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
const endpoint = `${url.origin}/settings`;
try {
  const page = await fetch(url.origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /button.draggable=true/);
  assert.match(html, /Drag items in the preview to reorder/);
  assert.match(html, /拖拽预览中的字段可调整顺序/);

  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: '{' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: '{"enabled":"yes"}' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ enabled: false, fail: true }) })).status, 500);
  assert.equal(settings.enabled, true);
  const saved = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
  assert.deepEqual(await saved.json(), { enabled: false });
  assert.equal(writes, 1);
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), settings);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: ' '.repeat(17000) })).status, 413);
} finally { web.close(); }
console.log('settings web checks passed');
