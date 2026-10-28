// Round-3 adversarial sweep: error surfacing, archived-project presentation, narrow widths, long activity lists.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const found = [];
const note = (id, ok, detail) => { if (!ok) found.push({ id, detail: String(detail || '') }); console.log((ok ? 'OK    ' : 'BUG   ') + id + (ok ? '' : ' :: ' + detail)); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-df3-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
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
const hash=(v)=>ev('window.location.hash = ' + JSON.stringify(v));
const setWidth=(w,h)=>send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
const overflow=()=>call(()=>{const root=document.scrollingElement||document.documentElement;const panel=document.querySelector('[data-wb-panel]');const bad=[]; if(panel){for(const el of panel.querySelectorAll('*')){if(el.clientWidth===0)continue; if(el.scrollWidth>el.clientWidth+1){const cs=getComputedStyle(el); if(cs.overflowX!=='auto'&&cs.overflowX!=='scroll'){bad.push((el.textContent||'').trim().slice(0,16));} } if(bad.length>=3)break;}} return {doc: root.scrollWidth-window.innerWidth, bad};});
await send('Page.enable'); await send('Runtime.enable');
await setWidth(1440,900);
await send('Page.navigate',{url:urlArg});
await sleep(3200);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
await call(()=>{const b=document.querySelector('button[aria-label="工作台"]'); if(b)b.click(); return true;});
await sleep(2200);
const api = async (type, payload) => call(async (body) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); }, { type: type, payload: payload });
// N6 error surfacing: blank title on the claim-dock create form must show a readable message, not a raw code or silence
await hash('#/progress');
await sleep(1200);
const dock = await call(() => { const box = document.querySelector('[data-wb-claim]'); return box ? true : false; });
note('N6a 认领浮层存在（composer 区）', dock, 'dock=' + dock);
// N7 archived project must not look actionable in the progress view
const proj = await call(async () => { const s = await fetch('/workbench/api/snapshot').then(r=>r.json()); const p=(s.data.projects||[]).find(x=>(x.issues||[]).length>0 && !x.archivedAt); return p ? { id: p.projectId, name: p.name } : null; });
if (proj) {
  await api('project.setArchived', { projectId: proj.id, archived: true });
  await hash('#/progress'); await sleep(700);
  await hash('#/progress'); await sleep(1500);
  const shown = await call((name) => { const root = document.querySelector('[data-wb-panel]'); const t=(root&&root.textContent)||''; const row = [...(root?root.querySelectorAll('[data-wb-project]'):[])].map(el=>({ id: el.getAttribute('data-wb-project'), archived: el.getAttribute('data-wb-project-archived'), text: (el.textContent||'').slice(0,40) })); return { hasName: t.indexOf(name) >= 0, rows: row }; }, proj.name);
  const archivedRow = (shown.rows || []).find(r => r.id === proj.id);
  note('N7 归档项目在进度页有明确标记（或不再列出）', !archivedRow || archivedRow.archived === 'true' || archivedRow.archived === '1', JSON.stringify({ hasName: shown.hasName, archivedRow }).slice(0, 240));
  await api('project.setArchived', { projectId: proj.id, archived: false });
}
// N8 narrow widths (620 / 680) must not overflow in the four views
const views = ['#/progress', '#/board', '#/inbox', '#/search?q=WB'];
for (const width of [620, 680]) {
  await setWidth(width, 820);
  for (const view of views) {
    await hash(view); await sleep(750);
    const o = await overflow();
    note('N8 溢出 ' + width + ' ' + view, o.doc <= 1 && o.bad.length === 0, JSON.stringify(o));
  }
}
await setWidth(1440,900);
// N9 long activity list (60 comments) stays scrollable and does not overflow
const targetIssue = await call(async () => { const s = await fetch('/workbench/api/snapshot').then(r=>r.json()); const p=(s.data.projects||[]).find(x=>(x.issues||[]).length); const i=p.issues.find(x=>x.status!=='done'); return i?i.issueId:null; });
if (targetIssue) {
  await call(async (issueId) => { for (let i=1;i<=60;i+=1) { await fetch('/workbench/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'issue.comment',payload:{issueId:issueId,text:'活动压力 #'+i}})}); } return true; }, targetIssue);
  await hash('#/issue/' + targetIssue); await sleep(2000);
  const ov = await overflow();
  const scroll = await call(() => { const root = document.querySelector('[data-wb-panel]'); const inner = [...root.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 40); return { count: inner.length }; });
  note('N9 60 条活动时无横向溢出', ov.doc <= 1 && ov.bad.length === 0, JSON.stringify(ov));
  note('N9 长活动流存在可滚动容器', scroll.count >= 1, JSON.stringify(scroll));
}
note('N10 全程无未捕获异常', errors.length === 0, JSON.stringify(errors.slice(0,2)));
console.log('---');
console.log('ROUND3 DEFECTS: ' + found.length);
if (outDir) { try { writeFileSync(join(outDir, 'defect-sweep-3.json'), JSON.stringify({ at: new Date().toISOString(), found }, null, 2)); } catch (e) {} }
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
