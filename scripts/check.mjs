#!/usr/bin/env node
/**
 * Dev gate: syntax-check every runtime file, type-check with tsc when available
 * (Z6: tsc is the only allowed dev tool), then build the client half.
 * Usage: node scripts/check.mjs [--no-tsc]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
};
const files = walk(root).filter((f) => !f.endsWith('client.js') && !f.includes('/client-src/')); // generated + browser fragments
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (error) { failed++; console.error('SYNTAX FAIL ' + f + '\n' + String(error.stderr ?? error)); }
}
console.log('syntax: ' + (files.length - failed) + '/' + files.length + ' ok');

if (!process.argv.includes('--no-tsc')) {
  try {
    execFileSync('tsc', ['--version'], { stdio: 'pipe' });
    try {
      execFileSync('tsc', ['-p', join(root, 'tsconfig.check.json')], { stdio: 'inherit', cwd: root });
      console.log('tsc: ok');
    } catch { failed++; console.error('tsc: type errors'); }
  } catch { console.warn('tsc: not found, skipped'); }
}

try { execFileSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], { stdio: 'inherit' }); }
catch { failed++; console.error('client build failed'); }

process.exit(failed ? 1 : 0);
