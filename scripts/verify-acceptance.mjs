import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + (detail ? ' :: ' + detail : '')); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-acc-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
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
await sleep(3400);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
await call(()=>{const b=document.querySelector('button[aria-label="工作台"]'); if(b)b.click(); return true;});
await sleep(2000);
// 1) 建「测试议题」：项目 + 立项（走 UI 之外用 API 造数据，UI 负责验收展示与交互）
const setup = await call(async () => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : {};
  const proj = unwrap(await post('project.create', { name: '真机验收项目' }));
  const todo = unwrap(await post('todo.create', { title: '测试议题' }));
  const tri = await post('issue.triage', { issueId: todo.issueId, projectId: proj.projectId, workspacePath: '/tmp', acceptance: [{ text: '可验收标准' }] });
  const claim = await post('unit.claim', { issueId: todo.issueId, sessionId: 'accept-session-1', cwd: '/tmp' });
  return { issueId: todo.issueId, unitId: unwrap(claim).unitId, tri: tri.ok, claim: claim.ok };
});
check('ACC-01 默认工作区建「测试议题」并认领会话', Boolean(setup.issueId && setup.unitId), JSON.stringify(setup));
// 2) 多轮：3 次 turn/end → 单元仍运行、轮数累加、议题仍处理中
const rounds = await call(async (payload) => {
  const post = async (type, p) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload: p }) }); return r.json(); };
  for (let i = 0; i < 3; i += 1) { await post('test.sessionEvent', { sessionId: 'accept-session-1', kind: 'turn/start' }); await post('test.sessionEvent', { sessionId: 'accept-session-1', kind: 'turn/end', reason: { kind: 'completed' } }); }
  const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(payload.issueId)).then((r) => r.json());
  const unit = (d.data.units || [])[0];
  return { execState: unit.execState, turnCount: unit.turnCount, status: d.data.issue.status };
}, setup);
check('ACC-02 三轮对话后单元仍在执行、轮数=3、议题仍处理中', rounds.execState === 'running' && rounds.turnCount === 3 && rounds.status === 'in_progress', JSON.stringify(rounds));
// 3) UI 上看到「单元 #1 · 3 轮」与「结束本单元」
await ev("window.location.hash = '#/issue/" + setup.issueId + "'");
await sleep(1800);
const ui = await call(() => { const root = document.querySelector('[data-wb-panel]'); const t = (root.textContent || ''); return { hasUnit: t.indexOf('单元 #') >= 0, hasTurns: t.indexOf('3 轮') >= 0, hasWrap: Boolean(root.querySelector('[data-wb-wrapup]')), hasOldRoundLabel: /第\\s*\\d+\\s*轮/.test(t) }; });
check('ACC-03 UI 显示「单元 #n / 3 轮 / 结束本单元」且不再出现「第 N 轮」', ui.hasUnit && ui.hasTurns && ui.hasWrap && !ui.hasOldRoundLabel, JSON.stringify(ui));
// 4) 点「结束本单元」→ 填四段交接 → 确认收尾 → 待验收
// Step 1: with no handover the first click only ASKS this unit's AI to summarize.
await call(() => { const b = document.querySelector('[data-wb-wrapup]'); if (b) b.click(); return true; });
await sleep(1200);
const asked = await call(async (issueId) => { const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json()); const u = (d.data.units || [])[0]; return { execState: u.execState, waiting: Boolean(u.wrapRequest), hasHandover: Boolean(u.handover) }; }, setup.issueId);
check('ACC-04a 结束本单元先请该单元的 AI 写交接（单元不结束）', asked.execState === 'running' && asked.waiting === true, JSON.stringify(asked));
// Step 2: the human can still fill it by hand (or wait for the AI).
await call(() => { const b = document.querySelector('[data-wb-wrapmanual]'); if (b) b.click(); return true; });
await sleep(800);
const formOk = await call(() => Boolean(document.querySelector('[data-wb-wrapform]')));
const filled = await call(() => {
  const fields = { change: '真机验收：改了 A', verify: '跑了一遍流程', result: '通过', risk: '无' };
  for (const [field, value] of Object.entries(fields)) {
    const el = document.querySelector('[data-wb-wrapfield="' + field + '"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
});
await sleep(300);
const confirmed = await call(() => { const b = document.querySelector('[data-wb-wrapconfirm]'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; });
await sleep(1800);
const afterWrap = await call(async (issueId) => { const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json()); const u = (d.data.units || [])[0]; return { execState: u.execState, acceptState: u.acceptState, status: d.data.issue.status }; }, setup.issueId);
check('ACC-04 收尾表单可用且确认后进「待验收」', formOk && filled && confirmed === 'clicked' && afterWrap.execState === 'ended' && afterWrap.status === 'in_review', JSON.stringify({ formOk, filled, confirmed, afterWrap }));
// 5) 打回 → 回执行中继续（同一单元）
await ev("window.location.hash = '#/progress'"); await sleep(400);
await ev("window.location.hash = '#/issue/" + setup.issueId + "'"); await sleep(1600);
const rejectOpened = await call(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').startsWith('打回')); if (!b) return 'missing'; b.click(); return 'clicked'; });
await sleep(600);
const rejected = await call(() => {
  const inputs = [...document.querySelectorAll('[data-wb-panel] input')];
  const el = inputs[inputs.length - 1];
  if (!el) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '真机验收：不达标，继续做');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const confirm = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').startsWith('确认打回'));
  if (!confirm) return 'no-confirm';
  if (confirm.disabled) return 'disabled';
  confirm.click();
  return 'clicked';
});
await sleep(1800);
const afterReject = await call(async (issueId) => { const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json()); const units = d.data.units || []; return { count: units.length, execState: units[0].execState, voided: units[0].voided, status: d.data.issue.status }; }, setup.issueId);
check('ACC-05 打回后同一单元回到执行中（不新建单元、议题回处理中）', rejectOpened === 'clicked' && rejected === 'clicked' && afterReject.count === 1 && afterReject.execState === 'running' && afterReject.voided !== true && afterReject.status === 'in_progress', JSON.stringify({ rejectOpened, rejected, afterReject }));
// 5b) AI 建议收尾：只是信号，人确认才收尾
const suggest = await call(async (issueId) => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json());
  const unit = (d.data.units || []).find((u) => u.voided !== true && u.execState === 'ended' && u.acceptState === 'pending') || (d.data.units || [])[0];
  const res = await post('unit.suggestWrapup', { unitId: unit.unitId, note: '真机验收：目标已达成，建议收尾' });
  const after = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json());
  const u2 = (after.data.units || [])[0];
  return { ok: res.ok, execState: u2.execState, status: after.data.issue.status, hasSuggestion: Boolean(u2.wrapUpSuggestion) };
}, setup.issueId);
check('ACC-08 AI 建议收尾只写信号、不结束单元', suggest.ok === true && suggest.hasSuggestion === true && suggest.execState === 'running' && suggest.status === 'in_progress', JSON.stringify(suggest));
await ev("window.location.hash = '#/progress'");
await sleep(400);
await ev("window.location.hash = '#/issue/" + setup.issueId + "'");
await sleep(1700);
const suggestUi = await call(() => { const el = document.querySelector('[data-wb-wrapup-suggested]'); return { shown: Boolean(el), text: el ? (el.textContent || '').slice(0, 60) : null }; });
check('ACC-09 详情页显示「AI 建议收尾」由人决定', suggestUi.shown === true, JSON.stringify(suggestUi));
// 6) 再收尾 → 待验收（第二轮打磨后）
const again = await call(async (issueId) => {
  const post = async (type, p) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload: p }) }); return r.json(); };
  await post('test.sessionEvent', { sessionId: 'accept-session-1', kind: 'turn/start' });
  await post('test.sessionEvent', { sessionId: 'accept-session-1', kind: 'turn/end', reason: { kind: 'completed' } });
  const d = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json());
  const unit = (d.data.units || [])[0];
  const wrapped = await post('unit.wrapup', { unitId: unit.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
  const after = await fetch('/workbench/api/issue?id=' + encodeURIComponent(issueId)).then((r) => r.json());
  return { turnCount: unit.turnCount, wrapped: wrapped.ok, status: after.data.issue.status, execState: (after.data.units || [])[0].execState };
}, setup.issueId);
check('ACC-06 打磨一轮后再次收尾 → 回到待验收', again.wrapped === true && again.status === 'in_review' && again.turnCount === 4, JSON.stringify(again));

check('ACC-07 全程无未捕获异常', errors.length === 0, JSON.stringify(errors.slice(0,2)));
console.log('---');
console.log('ACCEPTANCE: ' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
if (outDir) { try { writeFileSync(join(outDir, 'acceptance-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2)); } catch (e) {} }
ws.close(); chrome.kill('SIGKILL'); process.exit(results.every((r) => r.ok) ? 0 : 1);