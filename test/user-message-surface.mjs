import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { minimalSurface } from '../lib/minimal-theme.ts';

for (const [name, expected] of [['cc-light', '#edf2fc'], ['cc-dark', '#1c273b']]) {
  const { vars, colors } = JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), 'utf8'));
  const resolved = Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, vars[value] ?? value]));
  assert.equal(vars.userMessageBg, expected, `${name} matches approved A prototype`);
  for (const mode of ['truecolor', '256color']) {
    const theme = new Theme(resolved, resolved, mode);
    const bg = theme.getBgAnsi('userMessageBg');
    const text = '路径.png 处理好\x1b[0m继续\x1b[49m正文\x1b[m结束';
    assert.equal(minimalSurface(theme, text, true), bg + text.replace(/\x1b\[(?:0|49)?m/g, reset => reset + bg) + '\x1b[49m');
    assert.equal(minimalSurface(theme, '消息', true), theme.bg('userMessageBg', '消息'), 'no extra accent blend');
  }
}
assert.equal(minimalSurface({ bg: (_, text) => `fallback:${text}` }, '消息', true), 'fallback:消息');
console.log('User message A: light/dark tokens, truecolor/256color, reset restoration and fallback PASS');
