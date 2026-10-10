import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const directory of ['scripts', 'test']) {
  for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url)).sort()) {
    if (!name.endsWith('.mjs')) continue;
    execFileSync(process.execPath, ['--check', `${directory}/${name}`], { cwd: root, stdio: 'inherit' });
    count++;
  }
}
const page = readFileSync(new URL('../lib/settings.html', import.meta.url), 'utf8');
for (const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  new Script(match[1], { filename: 'lib/settings.html' });
  count++;
}
console.log(`Syntax checked ${count} scripts; no checks were executed.`);
