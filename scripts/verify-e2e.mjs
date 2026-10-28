// End-to-end UI smoke over CDP: boot a seeded host, then walk the five views
// in a real browser and assert the DOM hooks the TEST-PLAN pins.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
if (!urlArg || !outDir) { console.error('usage: node verify-e2e.mjs <url> <out-dir>'); process.exit(2); }
let chrome;
const fail = (message) => { console.error('FAIL: ' + message); try { chrome && chrome.kill('SIGKILL'); } catch {} process.exit(1); };

const profileDir = mkdtempSync(join(tmpdir(), 'chrome-wb-e2e-'));
chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('no devtools endpoint: ' + buf)), 20000);
  const onData = (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } };
  chrome.stderr.on('data', onData); chrome.stdout.on('data', onData);
  chrome.on('exit', (code) => reject(new Error('chrome exited ' + code + ': ' + buf)));
});
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1; const pending = new Map(); const consoleLines = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } return; }
  if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  if (msg.method === 'Log.entryAdded') consoleLines.push('log[' + msg.params.entry.level + ']: ' + msg.params.entry.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expression, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(expression)) return true; await sleep(200); }
  console.error('timeout waiting for ' + label);
  return false;
};
const shot = async (name) => { const data = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, name), Buffer.from(data, 'base64')); console.log('STEP shot: ' + name); };
const go = async (hash, selector, label) => {
  await evaluate('window.location.hash = ' + JSON.stringify(hash));
  if (!await waitFor('document.querySelector(' + JSON.stringify(selector) + ') !== null', 12000, label)) fail(label + ' not rendered (' + hash + ')');
  await sleep(300);
  console.log('STEP ok: ' + label);
};

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: urlArg });
  if (!await waitFor("document.readyState === 'complete'", 30000, 'document')) fail('document did not complete');
  if (!await waitFor("document.querySelector('button[aria-label=\"工作台\"]') !== null", 30000, 'sidebar')) fail('sidebar entry missing');
  for (let i = 0; i < 8; i++) {
    const action = await evaluate("(() => { const next = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '继续'); if (next) { next.click(); return 'continue'; } const close = document.querySelector('[role=dialog] button[aria-label=\"关闭\"]'); if (close) { close.click(); return 'close'; } return null; })()");
    if (action === null) break;
    await sleep(600);
  }
  await evaluate("document.querySelector('button[aria-label=\"工作台\"]').click()");
  if (!await waitFor("document.querySelector('[data-wb-panel]') !== null", 15000, 'panel')) fail('workbench panel missing');

  if (!await waitFor("document.querySelector('[data-wb-projects]') !== null", 15000, 'progress rows')) fail('seeded projects did not render');
  const projectText = await evaluate("document.querySelector('[data-wb-projects]').textContent");
  if (!projectText.includes('WB-1')) fail('progress rows missing seeded issue');
  await shot('E2E-progress.png');

  await go('#/issue/WB-1', '[data-wb-issue-detail]', 'issue detail');
  const statusText = await evaluate("document.querySelector('[data-wb-status]')?.textContent ?? ''");
  if (!statusText) fail('status control missing in detail');
  await shot('E2E-issue.png');

  await go('#/inbox', '[data-wb-inbox]', 'inbox');
  if (!await waitFor("document.querySelectorAll('[data-wb-inbox-review], [data-wb-inbox-decisions], [data-wb-todos]').length >= 1", 8000, 'inbox sections')) fail('inbox sections missing');
  await shot('E2E-inbox.png');

  await go('#/board', '[data-wb-board]', 'board');
  const columns = await evaluate("document.querySelectorAll('[data-wb-board-column]').length");
  if (columns < 1) fail('board has no columns');
  await shot('E2E-board.png');

  await go('#/search?q=WB', '[data-wb-search]', 'search');
  await sleep(1500);
  const searchFacts = await evaluate("JSON.stringify({ groups: document.querySelectorAll('[data-wb-search-results] section').length, empty: (document.querySelector('[data-wb-search-results]')?.textContent ?? '').includes('没有匹配项') })");
  const parsedSearch = JSON.parse(searchFacts);
  console.log('search groups: ' + parsedSearch.groups);
  if (parsedSearch.groups < 1 || parsedSearch.empty) fail('search returned no seeded hits');
  await shot('E2E-search.png');

  const badConsole = consoleLines.filter((line) => line.startsWith('EXCEPTION') || line.startsWith('error:') || line.includes('[error]'));
  if (badConsole.length > 0) fail('console errors: ' + badConsole.join(' | '));
  console.log('CONSOLE: (clean)');
  console.log('E2E VERIFY: OK');
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
} catch (error) { console.error('CONSOLE:\n' + consoleLines.join('\n')); fail(String(error)); }
