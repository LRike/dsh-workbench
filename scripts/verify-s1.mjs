// S1 verification: drive headless Chrome over CDP and prove the workbench panel
// renders inside the real DSH Web UI, with live counters from the host route.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outSidebar, outPanel] = process.argv;
if (!urlArg || !outSidebar || !outPanel) { console.error('usage: node verify-s1.mjs <url> <sidebar.png> <panel.png>'); process.exit(2); }
const fail = (message) => { console.error('FAIL: ' + message); try { chrome.kill('SIGKILL'); } catch {} process.exit(1); };

const profileDir = mkdtempSync(join(tmpdir(), 'chrome-wb-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  while (Date.now() < deadline) { if (await evaluate(expression)) return true; await sleep(250); }
  console.error('timeout waiting for ' + label);
  return false;
};

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: urlArg });
  if (!await waitFor("document.readyState === 'complete'", 30000, 'document')) fail('document did not complete');
  if (!await waitFor("document.querySelector('button[aria-label=\"工作台\"]') !== null", 30000, 'sidebar 工作台')) fail('sidebar entry 工作台 not rendered');
  for (let i = 0; i < 8; i++) {
    const action = await evaluate("(() => { const next = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '继续'); if (next) { next.click(); return 'continue'; } const close = document.querySelector('[role=dialog] button[aria-label=\"关闭\"]'); if (close) { close.click(); return 'close'; } return null; })()");
    if (action === null) break;
    await sleep(700);
  }
  await waitFor("document.querySelectorAll('[role=dialog]').length === 0", 10000, 'dialogs');
  await sleep(400);
  writeFileSync(outSidebar, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await evaluate("document.querySelector('button[aria-label=\"工作台\"]').click()");
  if (!await waitFor("document.querySelector('[data-wb-panel]') !== null", 15000, 'workbench panel')) fail('main keyed panel not rendered');
  if (!await waitFor("(document.querySelector('[data-wb-counters]')?.textContent ?? '').includes('待验收单元')", 15000, 'live counters')) fail('counters did not render');
  await sleep(500);
  writeFileSync(outPanel, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  const facts = await evaluate("JSON.stringify({ panel: !!document.querySelector('[data-wb-panel]'), counters: document.querySelector('[data-wb-counters]').textContent, empty: document.querySelector('[data-wb-empty]')?.textContent ?? null, error: document.querySelector('[data-wb-error]')?.textContent ?? null, activeRow: document.querySelector('button[aria-label=\"工作台\"]')?.getAttribute('aria-current') ?? null })");
  console.log('FACTS: ' + facts);
  const parsed = JSON.parse(facts);
  if (parsed.error) fail('panel shows a data error: ' + parsed.error);
  const hasProjects = await evaluate("document.querySelector('[data-wb-projects]') !== null");
  if (!hasProjects && (!parsed.empty || !parsed.empty.includes('还没有项目'))) fail('expected either project rows or an empty state');
  console.log('projects rendered: ' + hasProjects);
  console.log('CONSOLE:\n' + (consoleLines.length ? consoleLines.join('\n') : '(no console output)'));
  console.log('S1 VERIFY: OK');
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
} catch (error) {
  console.error('CONSOLE:\n' + consoleLines.join('\n'));
  fail(String(error));
}
