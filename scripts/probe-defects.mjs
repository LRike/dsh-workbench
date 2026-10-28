// Adversarial defect sweep: things the acceptance gates do not cover on purpose.
// Runs against an isolated host (destructive actions are fine there).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const found = [];
const note = (id, ok, detail) => { if (!ok) found.push({ id, detail: String(detail === undefined ? '' : detail) }); console.log((ok ? 'OK    ' : 'BUG   ') + id + (ok ? '' : ' :: ' + detail)); };
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'chrome-df-')), '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(String(m.params.args.map((a) => a.value ?? '').join(' ')).slice(0, 160)); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + String(m.params.exceptionDetails.exception?.description ?? '').slice(0, 160)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 200); return r.result.value; };
const call = async (fn, ...args) => ev('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setWidth = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const setScheme = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
const hash = (v) => ev('window.location.hash = ' + JSON.stringify(v));
const clickText = (text) => call((label) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === label); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; }, text);
const overflow = () => call(() => { const root = document.scrollingElement || document.documentElement; const panel = document.querySelector('[data-wb-panel]'); const bad = []; if (panel) { for (const el of panel.querySelectorAll('*')) { if (el.clientWidth === 0) continue; if (el.scrollWidth > el.clientWidth + 1) { const cs = getComputedStyle(el); if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') bad.push((el.textContent || '').trim().slice(0, 18)); } if (bad.length >= 3) break; } } return { doc: root.scrollWidth - window.innerWidth, bad }; });
await send('Page.enable'); await send('Runtime.enable');
await setWidth(1440, 900);
await send('Page.navigate', { url: urlArg });
await sleep(3200);
for (let i = 0; i < 8; i++) { const a = await clickText('继续'); if (a !== 'clicked') break; await sleep(300); }
await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
await sleep(2200);
// 1) double submit on the new-project form
await hash('#/progress');
await sleep(1000);
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('新建项目')); if (b) b.click(); return true; });
await sleep(600);
const named = '双提交检查' + Date.now().toString(36).slice(-4);
await call((name) => { const el = document.querySelector('[data-wb-new-project="name"]'); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, name); el.dispatchEvent(new Event('input', { bubbles: true })); return true; }, named);
await sleep(300);
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('创建项目')); if (!b) return false; b.click(); b.click(); b.click(); return true; });
await sleep(2200);
const dup = await call((name) => { const b = document.body.textContent || ''; const count = (b.match(new RegExp(name, 'g')) || []).length; return count; }, named);
note('D1 双提交（创建项目连点三次只应产生 1 条）', dup === 1, '出现次数=' + dup);
// 2) duplicate dialog guard
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('新建议题')); if (b) { b.click(); b.click(); } return true; });
await sleep(800);
const dialogs = await call(() => document.querySelectorAll('[data-wb-dialog-card]').length);
note('D2 连点「新建议题」只应出现 1 个弹窗', dialogs === 1, 'dialog 数=' + dialogs);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);
// 3) archived issue must be read-only
const archived = await call(async () => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const snapshot = await fetch('/workbench/api/snapshot').then((r) => r.json());
  const issues = (snapshot.data.projects || []).flatMap((p) => p.issues || []);
  const cand = issues.find((i) => i.status !== 'done' && i.status !== 'cancelled');
  if (!cand) return null;
  await post('issue.cancel', { issueId: cand.issueId });
  await post('issue.setArchived', { issueId: cand.issueId, archived: true });
  return cand.issueId;
});
if (archived) {
  await hash('#/issue/' + archived);
  await sleep(1600);
  const ro = await call(() => {
    const root = document.querySelector('[data-wb-panel]');
    const text = (root && root.textContent) || '';
    const buttons = [...(root ? root.querySelectorAll('button') : [])].map((b) => ({ t: (b.textContent || '').trim(), d: b.disabled }));
    const writeButtons = buttons.filter((b) => /保存|通过|打回|开始|验收|归档|取消议题|认领/.test(b.t));
    return { hasReadOnlyBadge: text.indexOf('已归档') >= 0, writeButtons };
  });
  note('D3 归档议题应显示只读标记', ro.hasReadOnlyBadge, JSON.stringify(ro).slice(0, 200));
  note('D4 归档议题不应有可用的写操作按钮', ro.writeButtons.filter((b) => b.d === false).length === 0, JSON.stringify(ro.writeButtons).slice(0, 240));
}
// 4) long list scroll (25 TODOs) + overflow
await call(async () => { const post = async (t, p) => { await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: t, payload: p }) }); }; for (let i = 1; i <= 25; i += 1) await post('todo.create', { title: '压力测试 TODO #' + i }); return true; });
await sleep(2500);
await hash('#/inbox');
await sleep(1500);
const longList = await call(() => { const panel = document.querySelector('[data-wb-panel]'); const todos = [...panel.querySelectorAll('*')].filter((el) => (el.textContent || '').includes('压力测试 TODO')); const scroller = panel.querySelector('[data-wb-scroll]') || panel; return { todoTexts: todos.length, scrollable: scroller.scrollHeight > scroller.clientHeight + 2, sh: scroller.scrollHeight, ch: scroller.clientHeight }; });
note('D5 25 条 TODO 时列表应可滚动', longList.scrollable, JSON.stringify(longList));
const ovInbox = await overflow();
note('D6 长列表下无横向溢出', ovInbox.doc <= 1 && ovInbox.bad.length === 0, JSON.stringify(ovInbox));
// 5) width x theme sweep across views
const views = ['#/progress', '#/board', '#/inbox', '#/search?q=WB'];
for (const scheme of ['light', 'dark']) {
  await setScheme(scheme);
  for (const width of [760, 900, 1100, 1440]) {
    await setWidth(width, 820);
    for (const view of views) {
      await hash(view);
      await sleep(700);
      const o = await overflow();
      note('D7 溢出 ' + scheme + ' ' + width + ' ' + view, o.doc <= 1 && o.bad.length === 0, JSON.stringify(o));
    }
  }
}
await setScheme('light'); await setWidth(1440, 900);
// 6) every button has an accessible name
const a11y = await call(() => { const panel = document.querySelector('[data-wb-panel]'); if (!panel) return null; return [...panel.querySelectorAll('button')].filter((b) => !((b.textContent || '').trim() || b.getAttribute('aria-label') || b.getAttribute('title'))).length; });
note('D8 所有按钮都有可读名称', a11y === 0, '无名按钮=' + a11y);
note('D9 全程无控制台异常', logs.length === 0, JSON.stringify(logs.slice(0, 3)));
console.log('---');
console.log('DEFECTS FOUND: ' + found.length);
writeFileSync(join(outDir, 'defect-sweep.json'), JSON.stringify({ at: new Date().toISOString(), found }, null, 2));
ws.close(); chrome.kill('SIGKILL'); process.exit(found.length === 0 ? 0 : 1);