// Detail-page acceptance: sidebar order, terminal read-only, 10s auto-refresh (typing-safe).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + (detail ? ' :: ' + detail : '')); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-dtl-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
const wsUrl = await new Promise((res, rej) => { let b=''; const t=setTimeout(()=>rej(new Error('no devtools')),20000); const on=(d)=>{b+=d;const m=b.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}}; chrome.stderr.on('data',on); chrome.stdout.on('data',on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=1; const pending=new Map(); const errors=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id!==undefined){const p=pending.get(m.id); if(p){pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} return;} if(m.method==='Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception||{}).description||'').slice(0,120));};
const send=(method,params={})=>new Promise((res,rej)=>{const i=id++;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) return 'ERR '+String((r.exceptionDetails.exception||{}).description||r.exceptionDetails.text).slice(0,160); return r.result.value;};
const call=async(fn,...args)=>ev('('+fn.toString()+')('+args.map(a=>JSON.stringify(a)).join(',')+')');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:urlArg});
await sleep(3200);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
const labels = await call(() => [...document.querySelectorAll('button,[role=tab]')].map((b) => (b.getAttribute('aria-label') || (b.textContent || '').trim()).slice(0, 8)).filter(Boolean));
const wbPos = labels.indexOf('工作台');
const pluginsPos = labels.indexOf('插件');
check('DT-01: 工作台 is listed before 插件 in the sidebar', wbPos >= 0 && pluginsPos >= 0 && wbPos < pluginsPos, JSON.stringify({ wbPos, pluginsPos }));
await call(()=>{const b=document.querySelector('button[aria-label="工作台"]'); if(b)b.click(); return true;});
await sleep(1800);
const hostRefusal = await call(async () => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'unit.startRound', payload: { issueId: 'WB-1', mode: 'ai', goal: '终态回归' } }) }); const b = await r.json().catch(() => ({})); return { ok: b.ok, code: b.error ? b.error.code : null }; });
check('DT-02: the host refuses a new round on a completed issue', hostRefusal.ok === false, JSON.stringify(hostRefusal));
await ev("window.location.hash = '#/issue/WB-1'");
await sleep(1700);
const terminalPage = await call(() => {
  const root = document.querySelector('[data-wb-panel]');
  const hasStart = Boolean(root.querySelector('[data-wb-start="box"]'));
  const hasFinal = Boolean(root.querySelector('[data-wb-final="box"]'));
  const writes = [...root.querySelectorAll('button, input:not([disabled]), select, textarea')]
    .filter((el) => !el.disabled)
    .map((el) => (el.textContent || el.getAttribute('placeholder') || el.type || '').trim().slice(0, 14))
    .filter((tx) => /保存|通过|打回|开始|验收|归档|认领|改回|重试|删除|加一条|撤销|完成/.test(tx));
  return { hasStart: hasStart, hasFinal: hasFinal, writes: writes };
});
check('DT-03: a completed issue shows no 开工入口 and no 终验收 block', terminalPage.hasStart === false && terminalPage.hasFinal === false, JSON.stringify(terminalPage).slice(0, 150));
check('DT-04: a completed issue exposes no enabled write control', terminalPage.writes.length === 0, JSON.stringify(terminalPage.writes));
await ev("window.location.hash = '#/issue/WB-2'");
await sleep(1700);
const marker = '自动刷新断言 ' + Date.now();
await call(async (text) => { await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'issue.comment', payload: { issueId: 'WB-2', text: text } }) }); return true; }, marker);
const seenNow = await call((text) => ((document.querySelector('[data-wb-panel]') || {}).textContent || '').indexOf(text) >= 0, marker);
await sleep(11500);
const seenLater = await call((text) => ((document.querySelector('[data-wb-panel]') || {}).textContent || '').indexOf(text) >= 0, marker);
check('DT-05: the detail page picks up host changes within one 10s tick', seenNow === false && seenLater === true, JSON.stringify({ seenNow, seenLater }));
const typed = await call(() => {
  const el = [...document.querySelectorAll('[data-wb-panel] input')].find((i) => !i.disabled && i.type !== 'checkbox');
  if (!el) return 'no-input';
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '未输完的草稿');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
});
await sleep(11500);
const kept = await call(() => {
  const el = [...document.querySelectorAll('[data-wb-panel] input')].find((i) => !i.disabled && i.type !== 'checkbox');
  const active = document.activeElement;
  return { value: el ? el.value : null, focusInPanel: Boolean(active && active.closest && active.closest('[data-wb-panel]') && active.tagName === 'INPUT') };
});
check('DT-06: a refresh tick keeps the typed draft and the focus', typed === 'no-input' || (kept.value === '未输完的草稿' && kept.focusInPanel), JSON.stringify(kept));
// DT-08: a unit whose session died must show up in the inbox until somebody wraps it up.
const wrapScenario = await call(async () => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : {};
  const proj = unwrap(await post('project.create', { name: '收件箱待收尾' + Date.now().toString(36).slice(-4) }));
  const todo = unwrap(await post('todo.create', { title: '待收尾议题' }));
  const tr = await post('issue.triage', { issueId: todo.issueId, projectId: proj.projectId, workspacePath: '/tmp', acceptance: [{ text: '标准' }] });
  if (!tr.ok) return { error: 'triage failed' };
  const claim = await post('unit.claim', { issueId: todo.issueId, sessionId: 'dt-wrap-session', cwd: '/tmp' });
  if (!claim.ok) return { error: 'claim failed: ' + JSON.stringify(claim.error), issueId: todo.issueId };
  await post('test.sessionEvent', { sessionId: 'dt-wrap-session', kind: 'turn/start' });
  await post('test.sessionEvent', { sessionId: 'dt-wrap-session', kind: 'session/disposed' });
  const snap = await fetch('/workbench/api/snapshot').then((r) => r.json());
  return { issueId: todo.issueId, counter: snap.data.counters.pendingWrapupUnits };
});
check('DT-08: a disposed session leaves the unit in 待收尾 (host counter)', wrapScenario.counter >= 1, JSON.stringify(wrapScenario));
await ev("window.location.hash = '#/inbox'");
await sleep(1800);
const inboxWrap = await call((issueId) => {
  const section = document.querySelector('[data-wb-inbox-wrapup]');
  const rows = [...document.querySelectorAll('[data-wb-wrapup-unit]')];
  const text = section ? (section.textContent || '') : '';
  const mine = rows.find((row) => (row.textContent || '').indexOf(String(issueId)) >= 0);
  return { hasSection: Boolean(section), rowCount: rows.length, hasMine: Boolean(mine), title: text.slice(0, 40), hasGo: mine ? Boolean([...mine.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf('去收尾') >= 0)) : false };
}, wrapScenario.issueId);
check('DT-08: the inbox shows a 待收尾 section listing the unit', inboxWrap.hasSection && inboxWrap.hasMine && inboxWrap.hasGo, JSON.stringify(inboxWrap));
const wrapCounter = await call(() => { const el = document.querySelector('[data-wb-counter-wrapup]'); return { shown: Boolean(el), text: el ? (el.textContent || '').trim() : null }; });
check('DT-10: the inbox counter includes the wrap-up backlog', wrapCounter.shown === true && /[1-9]/.test(wrapCounter.text || ''), JSON.stringify(wrapCounter));
// DT-09: once a unit exists the workspace is displayed read-only (no editable picker).
const frozenIssue = await call(async () => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : {};
  const proj = unwrap(await post('project.create', { name: '工作区冻结' + Date.now().toString(36).slice(-4) }));
  const todo = unwrap(await post('todo.create', { title: '工作区冻结议题' }));
  await post('issue.triage', { issueId: todo.issueId, projectId: proj.projectId, workspacePath: '/tmp', acceptance: [{ text: 'c' }] });
  const claim = await post('unit.claim', { issueId: todo.issueId, sessionId: 'dt-freeze-session', cwd: '/tmp' });
  const rejected = await post('issue.setWorkspace', { issueId: todo.issueId, workspacePath: '/tmp/other' });
  return { issueId: todo.issueId, claimed: claim.ok, rejected: !rejected.ok, code: rejected.ok ? null : (rejected.error && rejected.error.code) };
});
check('DT-09: the host refuses a workspace change after the first unit', frozenIssue.claimed === true && frozenIssue.rejected === true && frozenIssue.code === 'E_CONFLICT', JSON.stringify(frozenIssue));
await ev("window.location.hash = '#/issue/" + frozenIssue.issueId + "'");
await sleep(1700);
const frozenUi = await call(() => { const panel = document.querySelector('[data-wb-panel]'); const locked = document.querySelector('[data-wb-workspace-locked]'); const inputs = panel ? [...panel.querySelectorAll('input')].filter((el) => String(el.getAttribute('placeholder') || '').indexOf('工作区') >= 0) : []; return { locked: Boolean(locked), lockedKind: locked ? locked.getAttribute('data-wb-workspace-locked') : null, workspaceInputs: inputs.length, text: locked ? (locked.textContent || '').slice(0, 60) : null }; });
check('DT-09: the detail page shows the workspace read-only after starting', frozenUi.locked === true && frozenUi.workspaceInputs === 0, JSON.stringify(frozenUi));
check('DT-07: no uncaught exceptions during the detail audit', errors.length === 0, JSON.stringify(errors.slice(0,2)));
const passed = results.filter((r) => r.ok).length;
console.log('---');
console.log('UI DETAIL: ' + passed + '/' + results.length + ' passed');
if (outDir) { try { const { writeFileSync } = await import('node:fs'); writeFileSync(join(outDir, 'ui-detail-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2)); } catch (e) {} }
ws.close(); chrome.kill('SIGKILL'); process.exit(results.every((r) => r.ok) ? 0 : 1);