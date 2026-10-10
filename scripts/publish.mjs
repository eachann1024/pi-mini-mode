import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const registry = 'https://registry.npmjs.org';

function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected stable major.minor.patch version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Version exceeds safe integer range: ${version}`);
  return parts;
}

export async function registryMetadata(response) {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry request failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid registry metadata');
  }
  return metadata;
}

export function compareVersions(a, b) {
  const left = stableVersion(a);
  const right = stableVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function highestPublishedStable(metadata) {
  const latest = metadata['dist-tags']?.latest;
  stableVersion(latest);
  const versions = metadata.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions) || !Object.hasOwn(versions, latest)) {
    throw new Error('Invalid registry versions');
  }
  for (const version of Object.values(versions)) {
    if (!version || typeof version !== 'object' || Array.isArray(version) ||
        (version.gitHead !== undefined && typeof version.gitHead !== 'string')) {
      throw new Error('Invalid registry version metadata');
    }
  }
  let highest = latest;
  for (const version of Object.keys(versions)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (compareVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/** Direct npm publishes must not strand users on a numerically higher old release. */
export function assertPublishableVersion(localVersion, metadata) {
  stableVersion(localVersion);
  if (metadata === null) return;
  const highest = highestPublishedStable(metadata);
  if (compareVersions(localVersion, highest) <= 0) {
    throw new Error(`Refusing to publish ${localVersion}: version must exceed highest published stable ${highest}, not just dist-tags.latest. Pi skips updates and notifications when the target is not newer.`);
  }
}

export function selectVersion(localVersion, metadata, gitHead) {
  stableVersion(localVersion);
  if (metadata === null) return localVersion;
  const highest = highestPublishedStable(metadata);
  if (typeof gitHead === 'string' && gitHead.length > 0 &&
      Object.values(metadata.versions).some(version => version.gitHead === gitHead)) return null;
  const baseline = compareVersions(localVersion, highest) > 0 ? localVersion : highest;
  const [major, minor] = stableVersion(baseline);
  const counters = Object.keys(metadata.versions)
    .filter(version => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    .map(stableVersion).filter(parts => parts[0] === major).map(parts => parts[2]);
  const counter = Math.max(stableVersion(localVersion)[0] === major ? stableVersion(localVersion)[2] : 0,
    ...counters) + 1;
  // A deliberately prepared version can be used as-is if its counter is newer.
  const prepared = compareVersions(localVersion, highest) > 0 && stableVersion(localVersion)[2] > Math.max(-1, ...counters);
  const next = prepared ? localVersion : `${major}.${minor}.${counter}`;
  stableVersion(next);
  return next;
}

if (import.meta.main) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('Missing package name');
  const checkOnly = process.argv.length === 3 && process.argv[2] === '--check';
  if (process.argv.length > 2 && !checkOnly) throw new Error('Usage: node scripts/publish.mjs [--check]');
  const response = await fetch(`${registry}/${encodeURIComponent(manifest.name)}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const metadata = await registryMetadata(response);
  if (checkOnly) {
    assertPublishableVersion(manifest.version, metadata);
    console.log(`Release version ${manifest.version} exceeds all published stable versions.`);
  } else {
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    if (Object.values(metadata?.versions ?? {}).some(version => version.gitHead === gitHead)) {
      console.log(`Commit ${gitHead} is already published; skipping.`);
    } else {
      assertPublishableVersion(manifest.version, metadata);
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
      if (dirty) throw new Error('Publish requires a clean checkout. Run npm run release after committing the completed task.');
      execFileSync('npm', ['publish', '--access', 'public', '--provenance', `--registry=${registry}`], { cwd, stdio: 'inherit' });
    }
  }
}
