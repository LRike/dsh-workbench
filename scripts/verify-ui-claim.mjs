// Claim dock acceptance (FR-30): the button lives in the CURRENT conversation's
// composer, so it must claim that session instead of asking to pick one.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : ' :: ' + detail)); };
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'chrome-cl-')), '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(String(m.params.args.map((a) => a.value ?? '').join(' ')).slice(0, 160)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value; };
const call = async (fn, ...args) => ev('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { const d = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, n), Buffer.from(d, 'base64')); };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: urlArg });
  await sleep(3500);
  for (let i = 0; i < 6; i++) { const acted = await call((label) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === label); if (b) { b.click(); return 1; } return 0; }, '继续'); if (!acted) break; await sleep(400); }
  await sleep(600);
  // the composer dock only exists inside a conversation: start one
  const focusOk = await call(() => { const el = document.querySelector('[contenteditable=true]'); if (!el) return false; el.focus(); return true; });
  await sleep(250);
  await send('Input.insertText', { text: '认领验收会话' });
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(4000);
  check('C-01: the claim button appears in the current conversation composer', focusOk && (await ev("document.querySelectorAll('[data-wb-claim=\"button\"]').length")) === 1, String(await ev("document.querySelectorAll('[data-wb-claim=\"button\"]').length")));
  await call(() => { const b = document.querySelector('[data-wb-claim="button"]'); if (b) b.click(); return true; });
  await sleep(700);
  const dock = await ev("JSON.stringify({dialog: document.querySelectorAll('[data-wb-claim-dialog]').length, fixed: document.querySelectorAll('[data-wb-claim-session-fixed]').length, picker: document.querySelectorAll('[data-wb-claim-session]').length})");
  const dockFacts = JSON.parse(dock);
  check('C-02: the dialog locks onto the current session (no session list)', dockFacts.dialog === 1 && dockFacts.fixed === 1 && dockFacts.picker === 0, dock);
  const styleFacts = async (selector) => call((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const parse = (value) => { const m = String(value).match(/rgba?\(([^)]+)\)/); if (!m) return null; const parts = m[1].split(',').map((x) => parseFloat(x)); return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }; };
    const bg = parse(cs.backgroundColor);
    const fg = parse(cs.color);
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = bg && fg ? +(((Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05))).toFixed(2) : null;
    return { background: cs.backgroundColor, color: cs.color, alpha: bg ? bg.a : null, ratio };
  }, selector);
  const buttonLight = await styleFacts('[data-wb-claim="button"]');
  check('C-08: claim button is opaque in light mode', Boolean(buttonLight) && buttonLight.alpha === 1, JSON.stringify(buttonLight));
  const dialogLight = await styleFacts('[data-wb-claim-dialog]');
  check('C-09: claim popover is opaque (not see-through)', Boolean(dialogLight) && dialogLight.alpha === 1, JSON.stringify(dialogLight));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(500);
  const buttonDark = await styleFacts('[data-wb-claim="button"]');
  check('C-10: claim button stays opaque in dark mode with readable text', Boolean(buttonDark) && buttonDark.alpha === 1 && buttonDark.ratio >= 4.5, JSON.stringify(buttonDark));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(300);
  await shot('CLAIM-OPAQUE.png');
  await call(() => { const b = document.querySelector('[data-wb-claim="create-toggle"]'); if (b) b.click(); return true; });
  await sleep(500);
  const createFacts = JSON.parse(await ev("JSON.stringify({form: document.querySelectorAll('[data-wb-claim-create]').length, title: document.querySelectorAll('[data-wb-claim=\"create-title\"]').length, project: document.querySelectorAll('[data-wb-claim=\"create-project\"]').length, criterion: document.querySelectorAll('[data-wb-claim=\"create-criterion\"]').length, workspace: document.querySelectorAll('[data-wb-workspace-select]').length})"));
  check('C-03: "new issue and claim" form is complete (title/project/criterion/workspace picker)', createFacts.form === 1 && createFacts.title === 1 && createFacts.project >= 1 && createFacts.criterion === 1 && createFacts.workspace >= 1, JSON.stringify(createFacts));
  await shot('CLAIM-DIALOG.png');
  // end-to-end: create an issue and claim this session in one action
  await call((title) => { const el = document.querySelector('[data-wb-claim="create-title"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, title); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; }, '认领入口自动用例');
  await call((text) => { const el = document.querySelector('[data-wb-claim="create-criterion"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; }, '能在议题列表里看到它');
  await sleep(300);
  const submitted = await call(() => { const b = document.querySelector('[data-wb-claim="create-submit"]'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; });
  await sleep(2500);
  const after = JSON.parse(await ev("JSON.stringify({label: (document.querySelector('[data-wb-claim=\"button\"]')||{}).textContent || '', claimed: document.querySelectorAll('[data-wb-claim=\"claimed\"]').length, dialog: document.querySelectorAll('[data-wb-claim-dialog]').length})"));
  check('C-04: create-and-claim submits', submitted === 'clicked', String(submitted));
  check('C-05: the button turns into "已认领 <编号>" and the dialog closes', /已认领/.test(after.label) && after.dialog === 0, JSON.stringify(after));
  const found = await ev("fetch('/workbench/api/search?q=' + encodeURIComponent('认领入口自动用例')).then((r) => r.json()).then((b) => JSON.stringify((b.data && b.data.issues || []).length))");
  check('C-06: the created issue is in the workbench (round-trip)', Number(found) >= 1, String(found));
  const unitOk = await ev("fetch('/workbench/api/inbox').then((r) => r.json()).then((b) => JSON.stringify({running: (b.data && b.data.counts) ? 'ok' : 'none'}))");
  check('C-07: inbox still answers after the claim', String(unitOk).indexOf('ok') >= 0, String(unitOk));
  await shot('CLAIM-AFTER.png');
  check('C-CONSOLE: no console errors', logs.length === 0, JSON.stringify(logs.slice(0, 3)));
  const failed = results.filter((r) => !r.ok);
  console.log('---');
  console.log('UI CLAIM: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  writeFileSync(join(outDir, 'ui-claim-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('CLAIM AUDIT ABORTED: ' + String(error));
  writeFileSync(join(outDir, 'ui-claim-results.json'), JSON.stringify({ aborted: String(error), results }, null, 2));
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(2);
}