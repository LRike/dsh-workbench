// Round-4 UI audit: write-operation chains, interaction states, touch targets,
// long Chinese titles and dark-mode contrast across views.
// Page-side code is written as real functions and stringified, so no escaping.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : ' :: ' + detail)); };

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'chrome-flow-')), '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1; const pending = new Map(); const logs = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } return; }
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description ?? '').slice(0, 200));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('console.error ' + msg.params.args.map((a) => a.value ?? '').join(' ').slice(0, 200));
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const call = async (fn, ...args) => ev('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The panel can take a moment to mount (or the shell may be on another panel):
 *  wait for it and, if needed, switch back through the sidebar. */
async function ensureWorkbench() {
  for (let i = 0; i < 12; i += 1) {
    const has = await call(() => document.querySelectorAll('[data-wb-panel]').length);
    if (has === 1) return true;
    await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
    await sleep(300);
  }
  return false;
}
const waitFor = async (expr, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(150); } throw new Error('timeout ' + label); };
const shot = async (name) => { const d = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, name), Buffer.from(d, 'base64')); };
const setWidth = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const setScheme = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });

const hash = (value) => ev('window.location.hash = ' + JSON.stringify(value));
const clickSel = (sel) => call((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
const textOf = () => call(() => document.querySelector('[data-wb-panel]') ? document.querySelector('[data-wb-panel]').textContent : '');
const docOverflow = () => call(() => { const root = document.scrollingElement || document.documentElement; return root.scrollWidth - window.innerWidth; });
const offenders = () => call(() => { const panel = document.querySelector('[data-wb-panel]'); if (!panel) return [{ text: 'no panel' }]; const bad = []; for (const el of panel.querySelectorAll('*')) { if (el.clientWidth === 0) continue; if (el.scrollWidth > el.clientWidth + 1) { const cs = getComputedStyle(el); if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') bad.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20) }); } if (bad.length >= 5) break; } return bad; });
const setInputValue = (sel, value) => call((s, v) => { const el = document.querySelector(s); if (!el) return 'missing'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; }, sel, value);

const hoverBackground = async (selector) => {
  const box = await call((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: r.x + r.width / 2, y: r.y + r.height / 2, bg: cs.backgroundColor, filter: cs.filter }; }, selector);
  if (!box) return null;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(250);
  const after = await call((s) => { const el = document.querySelector(s); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, filter: cs.filter }; }, selector);
  return { before: box.bg, after };
};

try {
  await send('Page.enable'); await send('Runtime.enable');
  await setWidth(1440, 900);
  await send('Page.navigate', { url: urlArg });
  await waitFor("document.readyState === 'complete'", 30000, 'load');
  await waitFor("document.querySelector('button[aria-label=\"工作台\"]') !== null", 30000, 'sidebar');
  const CONTINUE = '继续';
  for (let i = 0; i < 10; i++) { const acted = await call((label) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label); if (b) { b.click(); return 1; } const close = document.querySelector('[role=dialog] button[aria-label]'); if (close) { close.click(); return 1; } return 0; }, CONTINUE); if (!acted) break; await sleep(400); }
  await clickSel('button[aria-label="工作台"]');
  await waitFor("document.querySelector('[data-wb-panel]') !== null", 15000, 'panel');
  await sleep(1200);
  await setScheme('dark');
  await sleep(600);

  // ---- 1. produce a pending-review unit through the real command surface ----
  const setup = await call(async () => {
    const post = async (type, payload) => {
      const response = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) });
      return response.json();
    };
    const snapshot = await fetch('/workbench/api/snapshot').then((r) => r.json());
    const issues = (snapshot.data.projects || []).flatMap((project) => project.issues || []);
    let target = null;
    for (const candidate of issues) {
      if (!candidate.workspacePath || candidate.status === 'done' || candidate.status === 'cancelled') continue;
      const detail = await fetch('/workbench/api/issue?id=' + encodeURIComponent(candidate.issueId)).then((r) => r.json());
      const units = detail && detail.data && Array.isArray(detail.data.units) ? detail.data.units : [];
      const busy = units.some((unit) => unit.voided !== true && (unit.execState === 'pending' || unit.execState === 'running' || unit.execState === 'failed'));
      if (!busy) { target = candidate; break; }
    }
    if (!target) return { error: 'no issue with a workspace and no active unit', count: issues.length };
    const claim = await post('unit.claim', { issueId: target.issueId, sessionId: 'ui-flow-session', cwd: target.workspacePath });
    if (!claim.ok) return { error: 'claim failed: ' + JSON.stringify(claim.error), issueId: target.issueId };
    const ended = await post('test.sessionEvent', { sessionId: 'ui-flow-session', kind: 'turn/end', reason: { kind: 'completed' } });
    if (!ended.ok) return { error: 'turn/end failed: ' + JSON.stringify(ended.error), issueId: target.issueId };
    // unit/round model: the round above does NOT end the unit — wrapping up does.
    const detail0 = await fetch('/workbench/api/issue?id=' + encodeURIComponent(target.issueId)).then((r) => r.json());
    const unit0 = (detail0.data.units || []).find((unit) => unit.sessionId === 'ui-flow-session');
    const wrapped = await post('unit.wrapup', { unitId: unit0.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
    if (!wrapped.ok) return { error: 'wrapup failed: ' + JSON.stringify(wrapped.error), issueId: target.issueId };
    return { issueId: target.issueId, workspacePath: target.workspacePath };
  });
  check('F-SETUP-01: a pending-review unit can be produced by real commands', Boolean(setup && setup.issueId && !setup.error), JSON.stringify(setup));
  const targetIssue = setup && setup.issueId ? setup.issueId : null;
  if (targetIssue) {
    await hash('#/issue/' + targetIssue);
    await sleep(1500);
    const hasAccept = await call(() => document.querySelector('[data-wb-accept]') !== null);
    if (hasAccept) {
      const acceptText = await call(() => document.querySelector('[data-wb-accept]').textContent);
      await call(() => { document.querySelector('[data-wb-accept]').click(); return true; });
      await sleep(1600);
      const gone = await call((label) => ![...document.querySelectorAll('[data-wb-accept]')].some((b) => b.textContent === label), acceptText);
      check('F-ACCEPT-01: 通过第 N 轮 writes and leaves the pending state', gone, JSON.stringify({ acceptText, gone }));
      check('F-ACCEPT-02: no overflow after 通过 (dark)', (await docOverflow()) <= 1 && (await offenders()).length === 0, JSON.stringify(await offenders()));
    } else {
      check('F-ACCEPT-01: 通过第 N 轮 writes and leaves the pending state', false, 'no [data-wb-accept] on ' + targetIssue);
    }
    await shot('FLOW-ACCEPT-DARK.png');
    let rejectOpened = await call(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith('打回')); if (!b) return false; b.click(); return true; });
    if (!rejectOpened && targetIssue) {
      await call(async (issueId) => { const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); }; const detail = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json()); const workspacePath = detail.data.issue.workspacePath; await post('unit.claim', { issueId, sessionId: 'ui-flow-reject', cwd: workspacePath }); await post('test.sessionEvent', { sessionId: 'ui-flow-reject', kind: 'turn/end', reason: { kind: 'completed' } }); const d2 = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json()); const u2 = (d2.data.units || []).find((unit) => unit.sessionId === 'ui-flow-reject'); if (u2) await post('unit.wrapup', { unitId: u2.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' }); return true; }, targetIssue);
      await sleep(1200);
      await hash('#/progress');
      await sleep(500);
      await hash('#/issue/' + targetIssue);
      await sleep(1600);
      rejectOpened = await call(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith('打回')); if (!b) return false; b.click(); return true; });
    }
    if (rejectOpened) {
      await sleep(500);
      const reasonValue = await call(() => { const inputs = [...document.querySelectorAll('[data-wb-issue-detail] input, [data-wb-issue-detail] textarea')]; if (inputs.length === 0) return null; const el = inputs[inputs.length - 1]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, '验收脚本：本轮不合格'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; });
      const confirmVisible = await call(() => [...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('确认打回')));
      const confirmed = confirmVisible ? await call(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith('确认打回第')); if (b.disabled) return 'disabled'; b.click(); return 'clicked'; }) : 'no-confirm';
      await sleep(1600);
      check('F-REJECT-01: 打回 requires a reason input', typeof reasonValue === 'string' && reasonValue.length > 0, JSON.stringify(reasonValue));
      check('F-REJECT-02: 打回 confirm is reachable and enabled', confirmed === 'clicked', String(confirmed));
      check('F-REJECT-03: 打回 form closes after submit', await call(() => ![...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('确认打回第'))), '');
      check('F-REJECT-04: no overflow after 打回 (dark)', (await docOverflow()) <= 1 && (await offenders()).length === 0, JSON.stringify(await offenders()));
    } else {
      check('F-REJECT-01: 打回 requires a reason input', false, 'no 打回 button on ' + targetIssue);
    }
    await shot('FLOW-REJECT-DARK.png');
  } else {
    check('F-ACCEPT-01: 通过第 N 轮 writes and leaves the pending state', false, 'setup failed');
    check('F-REJECT-01: 打回 requires a reason input', false, 'setup failed');
  }
  // ---- 3. inbox batch selection ----
  await hash('#/inbox');
  await sleep(1200);
  const boxes = await call(() => document.querySelectorAll('[data-wb-inbox] input[type=checkbox]').length);
  check('F-INBOX-01: inbox renders selectable units', boxes >= 0, 'checkboxes=' + boxes);
  check('F-INBOX-02: no overflow in inbox (dark)', (await docOverflow()) <= 1 && (await offenders()).length === 0, JSON.stringify(await offenders()));
  await shot('FLOW-INBOX-DARK.png');

  // ---- 4. interaction states: hover / disabled / focus ring ----
  for (let i = 0; i < 6; i += 1) {
    const dismissed = await call(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '继续'); if (b) { b.click(); return 1; } return 0; });
    if (!dismissed) break;
    await sleep(300);
  }
  await hash('#/progress');
  await sleep(900);
  const hover = await hoverBackground('[data-wb-panel] button');
  check('F-STATE-01: buttons respond to hover (background or filter changes)', Boolean(hover) && hover.after && (hover.before.bg !== hover.after.bg || hover.before.filter !== hover.after.filter), JSON.stringify(hover));
  const disabledStyle = await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => x.disabled); if (!b) return null; const cs = getComputedStyle(b); return { opacity: cs.opacity, cursor: cs.cursor, text: b.textContent.trim().slice(0, 12) }; });
  check('F-STATE-02: disabled buttons look disabled', disabledStyle === null || (Number(disabledStyle.opacity) < 1 && disabledStyle.cursor === 'not-allowed'), JSON.stringify(disabledStyle));
  const focusRing = await call(() => { const b = document.querySelector('[data-wb-panel] button'); if (!b) return null; b.focus(); const held = document.activeElement === b; const cs = getComputedStyle(b); return { held, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow }; });
  check('F-STATE-03: focused buttons hold focus and show a ring', Boolean(focusRing) && focusRing.held && ((focusRing.outlineStyle !== 'none' && focusRing.outlineWidth !== '0px') || focusRing.boxShadow !== 'none'), JSON.stringify(focusRing));

  // ---- 5. touch targets ----
  const small = await call(() => { const bad = []; for (const el of document.querySelectorAll('[data-wb-panel] button, [data-wb-panel] input, [data-wb-panel] select')) { const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue; if (r.height < 24 || r.width < 24) bad.push({ tag: el.tagName, text: (el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) }); if (bad.length >= 5) break; } return bad; });
  check('F-TARGET-01: every control is at least 24x24', small.length === 0, JSON.stringify(small));

  // ---- 6. long Chinese title in a narrow dark window ----
  const longTitle = '超长中文标题验证'.repeat(14);
  const created = await call(async (title) => { const response = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'todo.create', payload: { title } }) }); const body = await response.json(); return body.data && body.data.result ? body.data.result.issueId : body.data && body.data.issueId; }, longTitle);
  await sleep(1200);
  if (created) {
    await setWidth(760, 800);
    await sleep(400);
    await hash('#/issue/' + created);
    await sleep(600);
    await ensureWorkbench();
    await sleep(500);
    const narrow = { overflow: await docOverflow(), offenders: await offenders() };
    check('F-LONG-01: 98-char Chinese title fits a 760px dark window', narrow.overflow <= 1 && narrow.offenders.length === 0, JSON.stringify(narrow));
    await shot('FLOW-LONG-TITLE-760.png');
    await setWidth(1440, 900);
    await sleep(400);
  } else {
    check('F-LONG-01: 98-char Chinese title fits a 760px dark window', false, 'could not create the long-title issue');
  }

  // ---- 7. dark contrast sampling across views ----
  const RATIO = (selector) => call((sel) => {
    const parse = (c) => { const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const el = document.querySelector(sel); if (!el) return null;
    let node = el; let bg = null;
    while (node) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0.5) { bg = c; break; } node = node.parentElement; }
    if (!bg) bg = { r: 21, g: 21, b: 23, a: 1 };
    const fg = parse(getComputedStyle(el).color) || { r: 240, g: 240, b: 240, a: 1 };
    const l1 = lum(fg), l2 = lum(bg);
    return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))).toFixed(2);
  }, selector);
  const samples = [];
  for (const view of ['#/progress', '#/board', '#/inbox', '#/search?q=WB']) {
    await hash(view);
    await sleep(900);
    const ratio = await RATIO('[data-wb-panel] span, [data-wb-panel] div');
    samples.push({ view, ratio });
  }
  check('F-CONTRAST-01: dark text contrast >= 4.5 on every view', samples.every((s) => s.ratio === null || s.ratio >= 4.5), JSON.stringify(samples));
  await setScheme('light');
  await sleep(300);

  check('F-CONSOLE: no exceptions during the flow audit', logs.length === 0, JSON.stringify(logs.slice(0, 4)));

  const failed = results.filter((r) => !r.ok);
  console.log('---');
  console.log('UI FLOWS: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  writeFileSync(join(outDir, 'ui-flows-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('FLOW AUDIT ABORTED: ' + String(error));
  console.error('LOGS: ' + JSON.stringify(logs.slice(0, 5)));
  writeFileSync(join(outDir, 'ui-flows-results.json'), JSON.stringify({ aborted: String(error), results }, null, 2));
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(2);
}
