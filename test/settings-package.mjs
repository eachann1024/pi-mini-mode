import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'pi-mini-mode-package-'));
let web;
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(temp, pack.filename), '-C', temp]);
  const pagePath = join(temp, 'package/lib/settings.html');
  const source = await readFile(join(root, 'lib/settings.html'), 'utf8');
  assert.equal(await readFile(pagePath, 'utf8'), source, 'npm must ship the development settings page');
  assert.ok(!pack.files.some(({ path }) => path.endsWith('.npmrc')), 'never package npm credentials');
  const manifest = JSON.parse(await readFile(join(temp, 'package/package.json'), 'utf8'));
  assert.equal(manifest.pi.image, 'https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/package-cover.png', 'gallery cover must be declared separately from README media');
  const cover = await readFile(join(root, 'assets/package-cover.png'));
  assert.equal(cover.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'gallery cover must use a supported raster format, not SVG');
  assert.ok(cover.readUInt32BE(16) >= 1200 && cover.readUInt32BE(20) >= 440, 'cover export must retain its readable dimensions');
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const readme = await readFile(join(temp, 'package', name), 'utf8');
    assert.equal(readme, await readFile(join(root, name), 'utf8'));
    assert.doesNotMatch(readme, /<img\b/i, 'gallery README rendering drops raw HTML images; use Markdown images');
    assert.ok([...readme.matchAll(/!\[[^\]]*\]\(https:\/\/[^)]+\)/g)].length >= 6, 'cover and feature screenshots must survive Markdown-only rendering');
  }
  const { startSettingsWeb } = await import(pathToFileURL(join(temp, 'package/lib/settings-web.ts')));
  let settings = { enabled: true };
  web = await startSettingsWeb(() => settings, async value => { settings = value; });
  const url = new URL(web.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const page = await fetch(url.origin);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(await page.text(), source, 'installed package serves its own HTML');
  const saved = await fetch(`${url.origin}/settings`, { method: 'PUT', headers, body: '{"enabled":false}' });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { enabled: false });
  const updated = source + '\n<!-- updated package -->';
  await writeFile(pagePath, updated);
  assert.equal(await (await fetch(url.origin)).text(), updated, 'existing server must not retain the old HTML after an update');
  await rm(pagePath);
  assert.equal((await fetch(url.origin)).status, 503, 'an interrupted install fails safely');
  await writeFile(pagePath, source);
  assert.equal(await (await fetch(url.origin)).text(), source, 'service recovers when installation completes');
} finally {
  web?.close();
  await rm(temp, { recursive: true, force: true });
}
console.log('Packaged settings checks passed.');
