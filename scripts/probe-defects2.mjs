// Round-2 adversarial sweep: project-level read-only, long text, rapid view switching, empty states.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const found = [];
const note = (id, ok, detail) => { if (!ok) found.push({ id, detail: String(detail || '') }); console.log((ok ? 'OK    ' : 'BUG   ') + id + (ok ? '' : ' :: ' + detail)); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-df2-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
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
const overflow=()=>call(()=>{const root=document.scrollingElement||document.documentElement;const panel=document.querySelector('[data-wb-panel]');const bad=[]; if(panel){for(const el of panel.querySelectorAll('*')){if(el.clientWidth===0)continue; if(el.scrollWidth>el.clientWidth+1){const cs=getComputedStyle(el); if(cs.overflowX!=='auto'&&cs.overflowX!=='scroll'){bad.push((el.textContent||'').trim().slice(0,16));} } if(bad.length>=3)break;}} return {doc: root.scrollWidth-window.innerWidth, bad};});
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:urlArg});
await sleep(3200);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
await call(()=>{const b=document.querySelector('button[aria-label="工作台"]'); if(b)b.click(); return true;});
await sleep(2200);
const api = async (type, payload) => ev('fetch("/workbench/api/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(' + JSON.stringify({ type, payload }) + ')}).then(r=>r.json())');
// N1 archived project -> its issues must be read-only
const proj = await call(async () => { const s = await fetch('/workbench/api/snapshot').then(r=>r.json()); const p = (s.data.projects||[]).find(x => (x.issues||[]).some(i => i.status !== 'done' && i.status !== 'cancelled')); return p ? { id: p.projectId, name: p.name, issue: (p.issues.find(i => i.status !== 'done' && i.status !== 'cancelled')||{}).issueId } : null; });
if (proj) {
  await api('project.setArchived', { projectId: proj.id, archived: true });
  await hash('#/issue/' + proj.issue);
  await sleep(1600);
  const ro = await call(() => { const root = document.querySelector('[data-wb-panel]'); const text = (root && root.textContent) || ''; const enabled = [...(root ? root.querySelectorAll('button') : [])].filter(b => !b.disabled).map(b => (b.textContent||'').trim()).filter(t => /保存|通过|打回|开始|验收|归档|取消议题|认领|改回|重试|完成/.test(t)); return { text: text.slice(0, 200), enabled }; });
  note('N1 归档项目下的议题应只读', ro.enabled.length === 0, JSON.stringify(ro.enabled).slice(0, 200));
  await api('project.setArchived', { projectId: proj.id, archived: false });
}
// N2 very long title + long description must not break layout
const longTitle = '长标题' + '甲'.repeat(230);
const longDesc = '长描述' + '乙'.repeat(1500);
const target2 = await call(async () => { const s = await fetch('/workbench/api/snapshot').then(r=>r.json()); const p = (s.data.projects||[]).find(x => !x.archivedAt && (x.issues||[]).length); const i = p.issues.find(x => x.status !== 'done'); return i ? i.issueId : null; });
if (target2) {
  await api('issue.update', { issueId: target2, title: longTitle, description: longDesc });
  await hash('#/issue/' + target2);
  await sleep(1600);
  const ov = await overflow();
  const clipped = await call(() => { const root = document.querySelector('[data-wb-panel]'); const h = root && root.querySelector('h1, h2, strong'); return h ? { sw: h.scrollWidth, cw: h.clientWidth } : null; });
  note('N2 超长标题/描述不产生横向溢出', ov.doc <= 1 && ov.bad.length === 0, JSON.stringify(ov));
  note('N2 标题不被裁切（容器可见文字区域）', !clipped || clipped.sw <= clipped.cw + 1, JSON.stringify(clipped));
}
// N3 rapid view switching must settle on a working view
for (const v of ['#/progress','#/board','#/inbox','#/search?q=WB','#/progress','#/board','#/inbox','#/progress']) { await hash(v); await sleep(120); }
await sleep(1600);
const settled = await call(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, nav: [...document.querySelectorAll('[data-wb-panel] [data-wb-nav-tab], [data-wb-panel] button')].filter(b => b.getAttribute('aria-current') === 'page').length, text: (document.querySelector('[data-wb-panel]') || {}).textContent ? 'ok' : 'empty' }));
note('N3 快速切换视图后仍正常渲染', settled.panel === 1 && settled.text === 'ok', JSON.stringify(settled));
// N4 empty project shows an empty state
const newProj = await api('project.create', { name: '空态检查' + Date.now().toString(36).slice(-4) });
await sleep(1200);
await hash('#/progress');
await sleep(1500);
const empty = await call(() => { const root = document.querySelector('[data-wb-panel]'); const t = (root && root.textContent) || ''; return { hasEmpty: /还没有议题|暂无议题|空|先建一个|建议题/.test(t), snippet: t.slice(0, 120) }; });
note('N4 空项目在进度页有空态提示', empty.hasEmpty, JSON.stringify(empty.snippet));
note('N5 全程无未捕获异常', errors.length === 0, JSON.stringify(errors.slice(0,2)));
console.log('---');
console.log('ROUND2 DEFECTS: ' + found.length);
if (outDir) { try { writeFileSync(join(outDir, 'defect-sweep-2.json'), JSON.stringify({ at: new Date().toISOString(), found }, null, 2)); } catch (e) {} }
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
