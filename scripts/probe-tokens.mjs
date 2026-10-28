import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg] = process.argv;
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-tok-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: urlArg });
for (let i = 0; i < 60; i++) { if (await ev("document.readyState === 'complete'")) break; await sleep(300); }
await sleep(1500);
const dump = `(() => {
  const root = getComputedStyle(document.documentElement);
  const names = new Set();
  for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules } catch { continue } for (const rule of rules || []) { if (!rule.style) continue; for (const key of rule.style) if (key.startsWith('--')) names.add(key); } }
  const interesting = [...names].filter(n => /(text|label|bg|background|surface|fill|border|stroke|link|danger|error|warn|success|hover|selected|muted|subtle|primary|secondary|tertiary|panel|card|base)/i.test(n) && !n.includes('static'));
  const values = {};
  for (const n of interesting) { const v = root.getPropertyValue(n).trim(); if (v) values[n] = v; }
  return JSON.stringify({ count: interesting.length, values }, null, 0);
})()`;
console.log(await ev(dump));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
