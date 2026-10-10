import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.mjs'))
  .map(name => name.slice(0, -4))
  .sort();
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  console.log(checks.join('\n'));
} else if (args.length === 1 && checks.includes(args[0])) {
  execFileSync(process.execPath, [`test/${args[0]}.mjs`], { cwd: root, stdio: 'inherit' });
} else {
  console.error('Select exactly one existing check: npm run check:focused -- <name>');
  console.error('List available checks: npm run check:focused -- --list');
  process.exitCode = 1;
}
