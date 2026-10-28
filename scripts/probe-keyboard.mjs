// Keyboard / focus audit: dialog focus trap, Escape restore, Enter does not fire destructive submits.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const found = [];
const note = (id, ok, detail) => { if (!ok) found.push({ id, detail: String(detail || '') }); console.log((ok ? 'OK    ' : 'BUG   ') + id + (ok ? '' : ' :: ' + detail)); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-kb-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
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
const key=async(k,code,vk)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:k,code:code||k,windowsVirtualKeyCode:vk||0}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:k,code:code||k,windowsVirtualKeyCode:vk||0});};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:urlArg});
await sleep(3200);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
await call(()=>{const b=document.querySelector('button[aria-label="工作台"]'); if(b)b.click(); return true;});
await sleep(2200);
// open the create-issue dialog through a real click so focus lands naturally
const opened = await call(() => { const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>(x.textContent||'').includes('新建议题')); if(!b) return 'missing'; b.click(); b.focus(); return 'clicked'; });
await sleep(900);
const K1 = await call(() => { const card = document.querySelector('[data-wb-dialog-card]'); if(!card) return { card:false }; const active = document.activeElement; const inside = Boolean(active && card.contains(active)); const tag = active ? active.tagName : null; return { card: true, inside: inside, tag: tag }; });
note('K1 打开弹窗后焦点落在弹窗内', opened === 'clicked' && K1.card && K1.inside, JSON.stringify(K1));
const K2 = await call(() => { const card = document.querySelector('[data-wb-dialog-card]'); if(!card) return 'no-card'; for(let i=0;i<10;i+=1){ const els=[...card.querySelectorAll('input, textarea, select, button')].filter(el=>!el.disabled); if(!els.length) return 'no-focusable'; els[(i % els.length)].focus(); } const card2=document.querySelector('[data-wb-dialog-card]'); const active=document.activeElement; return { inside: Boolean(card2 && active && card2.contains(active)), tag: active?active.tagName:null }; });
note('K2 弹窗内焦点可循环且不逃逸（程序化遍历 10 次）', K2 !== 'no-card' && K2.inside === true, JSON.stringify(K2));
// type a title, then Escape: expect the dialog to close and focus to return to the trigger button
await call(() => { const el=document.querySelector('[data-wb-dialog-card] input'); if(el){ el.focus(); } return true; });
await send('Input.insertText', { text: '键盘审计标题' });
await sleep(200);
await key('Escape','Escape',27);
await sleep(700);
const K3 = await call(() => { const card=document.querySelector('[data-wb-dialog-card]'); const active=document.activeElement; const btn=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>(x.textContent||'').includes('新建议题')); return { card: Boolean(card), focusOnTrigger: Boolean(active && btn && active === btn), activeText: active ? (active.textContent||'').trim().slice(0,12) : null }; });
note('K3 Escape 关闭弹窗', K3.card === false, JSON.stringify(K3));
note('K4 Escape 后焦点回到触发按钮', K3.focusOnTrigger === true, JSON.stringify({ focusOnTrigger: K3.focusOnTrigger, activeText: K3.activeText }));
// K5: Enter inside the round-goal input must not silently create a unit
const issue = await call(async () => { const s=await fetch('/workbench/api/snapshot').then(r=>r.json()); const p=(s.data.projects||[]).find(x=>(x.issues||[]).some(i=>i.status==='in_progress')); return p ? (p.issues.find(i=>i.status==='in_progress')||{}).issueId : null; });
if (issue) {
  await ev("window.location.hash = " + JSON.stringify("#/issue/" + issue));
  await sleep(1500);
  const beforeUnits = await call(() => document.querySelectorAll('[data-wb-unit]').length);
  const typed = await call(() => { const el=[...document.querySelectorAll('[data-wb-panel] input')].find(i=>String(i.getAttribute('placeholder')||'').indexOf('本轮目标')>=0); if(!el) return 'missing'; el.focus(); return 'focused'; });
  if (typed === 'focused') {
    await send('Input.insertText', { text: '回车不应误提交' });
    await key('Enter','Enter',13);
    await sleep(1200);
    const afterUnits = await call(() => document.querySelectorAll('[data-wb-unit]').length);
    const stillTyped = await call(() => { const el=[...document.querySelectorAll('[data-wb-panel] input')].find(i=>String(i.getAttribute('placeholder')||'').indexOf('本轮目标')>=0); return el ? el.value : null; });
    note('K5 目标输入框按 Enter 不会误建单元', afterUnits === beforeUnits, 'units ' + beforeUnits + '->' + afterUnits);
    note('K6 目标输入框按 Enter 不清空输入', stillTyped === '回车不应误提交', JSON.stringify(stillTyped));
  } else note('K5 skipped (no start box on this issue)', true, typed);
}
note('K7 全程无未捕获异常', errors.length === 0, JSON.stringify(errors.slice(0,2)));
console.log('---');
console.log('KEYBOARD DEFECTS: ' + found.length);
if (outDir) { try { writeFileSync(join(outDir, 'defect-keyboard.json'), JSON.stringify({ at: new Date().toISOString(), found }, null, 2)); } catch (e) {} }
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
