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
  assert.match(html, /flex-wrap:wrap/);
  assert.match(html, /tone-warning/);
  assert.match(html, /data\.options\|\|\[\]/);
  assert.match(html, /button.draggable=true/);
  assert.match(html, /Drag preview items to reorder/);
  assert.match(html, /拖拽预览中的字段可调整顺序/);
  assert.match(html, /id="features"/);
  assert.match(html, /feature-body/);
  assert.match(html, /极简输出/);
  assert.ok(!html.includes('Status bar metrics'), 'status metrics are covered by the preview above');
  assert.match(html, /Could not save — the connection closed/);
  assert.ok(!html.includes("t('saveFailed')+'"), 'status never appends the raw error');
  assert.ok(html.indexOf('id="fieldsHeading"') < html.indexOf('id="featuresHeading"'), 'status bar fields come before feature docs');
  assert.match(html, /function mergeOrder\(/);
  assert.match(html, /data\.options/);
  assert.ok(!html.includes('previewHeading'), 'preview is grouped with the status bar fields');
  assert.match(html, /id="notice"/);
  assert.match(html, /id="copyPrompt"/);
  assert.match(html, /把 Pi 全局设置中的 tuiMode 改为 fullscreen'/);

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

// Idle expiry, touch renewal, and reopen with a fresh token.
const idle = await startSettingsWeb(() => settings, async () => {}, { idleTimeoutMs: 150 });
assert.equal(idle.closed, false);
await new Promise(resolve => setTimeout(resolve, 100));
idle.touch();
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(idle.closed, false, 'touch keeps the lease alive');
await new Promise(resolve => setTimeout(resolve, 200));
assert.equal(idle.closed, true, 'idle server closes itself');
const reopened = await startSettingsWeb(() => settings, async () => {}, { idleTimeoutMs: 5000 });
assert.notEqual(reopened.url, idle.url, 'reopen yields a fresh token');
assert.equal(reopened.closed, false);
reopened.close();
assert.equal(reopened.closed, true, 'close is idempotent');
console.log('settings web checks passed');
