import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registryMetadata, selectVersion, assertPublishableVersion } from '../scripts/publish.mjs';

const metadata = (latest, gitHead = 'previous') => ({
  'dist-tags': { latest },
  versions: { [latest]: { gitHead } },
});

const missing = await registryMetadata(new Response('{"error":"Not found"}', { status: 404 }));
assert.equal(missing, null);
assert.equal(selectVersion('1.3.1', missing, 'current'), '1.3.1');
assert.equal(selectVersion('1.3.1', metadata('1.3.9'), 'current'), '1.3.10');
assert.equal(selectVersion('2.0.0', metadata('1.3.9'), 'current'), '2.0.0');
assert.equal(selectVersion('1.3.1', metadata('1.3.0'), 'current'), '1.3.1');
assert.equal(selectVersion('1.3.1', metadata('1.3.1', 'current'), 'current'), null);
const history = metadata('1.3.9');
history.versions['1.3.2'] = { gitHead: 'current' };
assert.equal(selectVersion('2.0.0', history, 'current'), null);

// latest is a mutable tag, not the highest version users may already have.
const rollback = metadata('1.0.4');
rollback.versions['1.3.8'] = {};
rollback.versions['1.3.15'] = {};
assert.equal(selectVersion('1.0.4', rollback, 'current'), '1.3.16');
assert.equal(selectVersion('1.3.15', rollback, 'current'), '1.3.16');
assert.equal(selectVersion('1.3.16', rollback, 'current'), '1.3.16');
assert.equal(selectVersion('2.0.0', rollback, 'current'), '2.0.0');
rollback.versions['2.0.0-beta.1'] = {};
assert.equal(selectVersion('1.0.4', rollback, 'current'), '1.3.16', 'prereleases do not raise the stable baseline');
assert.equal(selectVersion('1.0.4', rollback, undefined), '1.3.16', 'missing npm gitHead is not an already-published commit');
for (const version of ['0.9.2', '1.0.4', '1.0.5', '1.3.8', '1.3.15']) {
  assert.throws(() => assertPublishableVersion(version, rollback), /highest published stable 1\.3\.15/);
}
assert.doesNotThrow(() => assertPublishableVersion('1.3.16', rollback));
assert.doesNotThrow(() => assertPublishableVersion('2.0.0', rollback));
assert.doesNotThrow(() => assertPublishableVersion('0.1.0', null));
assert.throws(() => assertPublishableVersion('1.3.16', {}));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.ok(manifest.scripts.prepublishOnly.startsWith('node scripts/publish.mjs --check && '), 'manual npm publish must run the version guard too');

for (const version of ['1.3', '01.3.0', '1.3.0-beta.1', '1.3.0+build', 'v1.3.0', '1.3.9007199254740992', null]) {
  assert.throws(() => selectVersion(version, null, 'current'), /version|range/i);
  assert.throws(() => selectVersion('1.3.1', metadata(version), 'current'), /version|range/i);
}
assert.throws(() => selectVersion('1.3.1', metadata('1.3.9007199254740991'), 'current'), /range/i);
assert.throws(() => selectVersion('1.3.1', {}, 'current'));
assert.throws(() => selectVersion('1.3.1', { 'dist-tags': { latest: '1.3.1' }, versions: [] }, 'current'));
assert.throws(() => selectVersion('1.3.1', { ...metadata('1.3.1'), versions: { '1.3.1': null } }, 'current'));
for (const status of [401, 403, 429, 500]) {
  await assert.rejects(registryMetadata(new Response('{}', { status })), /HTTP/);
}
for (const body of ['not json', 'null', '[]']) {
  await assert.rejects(registryMetadata(new Response(body)));
}
console.log('Publish self-check passed.');
