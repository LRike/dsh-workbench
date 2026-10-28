// Board stress: many issues across statuses must render, scroll and not overflow.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const urlArg = process.argv[2];
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-bd-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
const wsUrl = await new Promise((res, rej) => { let b=''; const t=setTimeout(()=>rej(new Error('no devtools')),20000); const on=(d)=>{b+=d;const m=b.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}}; chrome.stderr.on('data',on); chrome.stdout.on('data',on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=1; const pending=new Map(); const errors=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id!==undefined){const p=pending.get(m.id); if(p){pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} return;} if(m.method==='Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception||{}).description||'').slice(0,120));};
const send=(method,params={})=>new Promise((res,rej)=>{const i=id++;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) return 'ERR '+String((r.exceptionDetails.exception||{}).description||r.exceptionDetails.text).slice(0,160); return r.result.value;};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:urlArg});
await sleep(3000);
for (let i=0;i<8;i++){const a=await ev("(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0; })()"); if(!a)break; await sleep(300);}
await ev("(() => { const b=document.querySelector('button[aria-label=\"工作台\"]'); if(b)b.click(); return true; })()");
await sleep(2000);
const created = await ev(`(async () => {
  const cmd = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: type, payload: payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : (res && res.data ? res.data : {});
  const s = await fetch('/workbench/api/snapshot').then(r => r.json());
  const p = (s.data.projects || [])[0];
  if (!p) return 'no-project';
  let made = 0;
  for (let i = 1; i <= 30; i += 1) {
    const todo = unwrap(await cmd('todo.create', { title: '看板压力 #' + i }));
    const tr = await cmd('issue.triage', { issueId: todo.issueId, projectId: p.projectId, workspacePath: '/tmp', acceptance: [{ text: '标准' + i }] });
    if (!tr.ok) continue;
    if (i % 3 === 0) await cmd('issue.setStatus', { issueId: todo.issueId, status: 'in_progress' });
    if (i % 3 === 1) await cmd('issue.setStatus', { issueId: todo.issueId, status: 'blocked' });
    made += 1;
  }
  return made;
})()`);
console.log('issues created: ' + created);
const t0 = Date.now();
await ev("window.location.hash = '#/board'");
await sleep(400);
const rendered = await ev(`(() => {
  const panel = document.querySelector('[data-wb-panel]');
  if (!panel) return { panel: 0 };
  const root = document.scrollingElement || document.documentElement;
  const cards = panel.querySelectorAll('[data-wb-issue], [data-wb-card], button');
  const bad = [];
  for (const el of panel.querySelectorAll('*')) {
    if (el.clientWidth === 0) continue;
    if (el.scrollWidth > el.clientWidth + 1) { const cs = getComputedStyle(el); if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') bad.push((el.textContent || '').trim().slice(0, 14)); }
    if (bad.length >= 3) break;
  }
  const scrollers = [...panel.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 40).length;
  return { panel: 1, doc: root.scrollWidth - window.innerWidth, bad: bad, scrollers: scrollers, nodes: panel.querySelectorAll('*').length };
})()`);
await sleep(1200);
const elapsed = Date.now() - t0;
const after = await ev("(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, text: ((document.querySelector('[data-wb-panel]')||{}).textContent||'').length }))()");
console.log('render facts: ' + JSON.stringify(rendered));
console.log('settled: ' + JSON.stringify(after) + ' elapsed=' + elapsed + 'ms');
console.log('exceptions: ' + JSON.stringify(errors.slice(0,2)));
const ok = rendered.panel === 1 && rendered.doc <= 1 && rendered.bad.length === 0 && after.panel === 1 && after.text > 200 && errors.length === 0 && elapsed < 6000;
console.log(ok ? 'BOARD-STRESS: OK' : 'BOARD-STRESS: PROBLEM');
ws.close(); chrome.kill('SIGKILL'); process.exit(ok ? 0 : 1);
