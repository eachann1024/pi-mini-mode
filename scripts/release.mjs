import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { registryMetadata, selectVersion } from './publish.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org';
const run = (command, args, capture = false) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
const git = (...args) => run('git', args, true).trim();
const clean = () => { if (git('status', '--porcelain')) throw new Error('Commit the completed task first; release requires a clean checkout.'); };
async function metadata(name) {
  return registryMetadata(await fetch(`${registry}/${encodeURIComponent(name)}?release=${Date.now()}`, {
    redirect: 'error', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
  }));
}

async function verifyRelease({name, version, head, shasum}) {
    const tag = `v${version}`;
    let published;
    for (let attempt = 0; attempt < 4; attempt++) {
      published = await metadata(name);
      if (published?.['dist-tags']?.latest === version && published.versions?.[version]) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 20_000));
    }
    const record = published?.versions?.[version];
    if (published?.['dist-tags']?.latest !== version || !record || (record.gitHead !== undefined && record.gitHead !== head)) throw new Error('Published version/latest/gitHead not verified; do not republish.');
    const remote = git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
    git('fetch', 'origin', 'main');
    git('merge-base', '--is-ancestor', head, remote);
    if (record.dist.shasum !== shasum) throw new Error('Published package differs from the prepared package.');
    const response = await fetch(record.dist.tarball, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Published tarball HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== record.dist.integrity) throw new Error('Published tarball integrity mismatch.');
    if (git('tag', '--list', tag)) {
      if (git('rev-parse', `${tag}^{commit}`) !== head) throw new Error('Existing release tag points to another commit.');
    } else run('git', ['tag', '-a', tag, head, '-m', `pi-mini-mode ${version}`]);
    run('git', ['push', 'origin', `refs/tags/${tag}`]);
    rmSync(receiptPath);
    console.log(`Verified ${name}@${version}: main ${head}, npm latest, tarball integrity and ${tag}. Pi uses this npm package.`);
}

const verifyOnly = process.argv.length === 3 && process.argv[2] === '--verify';
if (process.argv.length !== 2 && !verifyOnly) throw new Error('Usage: npm run release [-- --verify]');
const lock = join(resolve(cwd, git('rev-parse', '--git-common-dir')), 'pi-mini-mode-release.lock');
const receiptPath = join(resolve(cwd, git('rev-parse', '--git-common-dir')), 'pi-mini-mode-release-pending.json');
mkdirSync(lock); // One release at a time, including other worktrees.
try {
  if (verifyOnly) {
    await verifyRelease(JSON.parse(readFileSync(receiptPath, 'utf8')));
  } else {
  if (existsSync(receiptPath)) throw new Error('A release awaits verification. Run npm run release -- --verify; do not republish.');
  clean();
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    throw new Error('Push the completed task and synchronize with origin/main before releasing.');
  }
  const manifestPath = join(cwd, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const before = await metadata(manifest.name);
  const version = selectVersion(manifest.version, before, git('rev-parse', 'HEAD'));
  if (version === null) {
    console.log('This commit is already published; no new release.');
  } else {
    const tag = `v${version}`;
    if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
      throw new Error(`Release tag ${tag} already exists.`);
    }
    run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts']);
    const changelogPath = join(cwd, 'CHANGELOG.md');
    const changelog = readFileSync(changelogPath, 'utf8');
    if (!changelog.includes(`\n## ${version}\n`)) {
      const newline = changelog.indexOf('\n');
      writeFileSync(changelogPath, changelog.slice(0, newline + 1) + `\n## ${version}\n\n- 发布本轮已提交的改动。\n` + changelog.slice(newline + 1));
    }
    run('npm', ['run', 'check']);
    run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
    run('git', ['diff', '--cached', '--check']);
    run('git', ['commit', '-m', `chore: release pi-mini-mode ${version}`]);
    clean();
    const head = git('rev-parse', 'HEAD');
    run('git', ['push', 'origin', 'HEAD:refs/heads/main']);
    if (!git('ls-remote', 'origin', 'refs/heads/main').startsWith(head + '\t')) throw new Error('Remote commit mismatch.');
    const expected = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], true))[0];
    const receipt = { name: manifest.name, version, head, shasum: expected.shasum };
    writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx' });
    run('npm', ['publish', '--access', 'public', `--registry=${registry}`]); // Never retry a publish.
    await verifyRelease(receipt);
  }
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}
