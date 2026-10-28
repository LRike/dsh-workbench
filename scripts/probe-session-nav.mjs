import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg] = process.argv;
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-pr-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
const wsUrl = await new Promise((res, rej) => { let b=''; const t=setTimeout(()=>rej(new Error('no devtools')),20000); const on=(d)=>{b+=d;const m=b.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}}; chrome.stderr.on('data',on); chrome.stdout.on('data',on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=1; const pending=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id!==undefined){const p=pending.get(m.id); if(p){pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}};
const send=(method,params={})=>new Promise((res,rej)=>{const i=id++;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) return 'ERR '+String((r.exceptionDetails.exception||{}).description||r.exceptionDetails.text).slice(0,200); return r.result.value;};
const call=async(fn,...args)=>ev('('+fn.toString()+')('+args.map(a=>JSON.stringify(a)).join(',')+')');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:urlArg});
await sleep(3400);
// dismiss onboarding if present
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}
// create two real sessions through the official UI path is heavy; instead inspect structure of sidebar as-is
const info = await call(() => {
  const all = [...document.querySelectorAll('*')];
  const withSessionAttr = all.filter((el) => [...el.attributes || []].some((a) => /session/i.test(a.name)));
  const sample = withSessionAttr.slice(0, 6).map((el) => ({ tag: el.tagName, attrs: [...el.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 40)) }));
  const navs = [...document.querySelectorAll('[role="tab"],[role="tablist"] button,nav a,nav button')].map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 30), attrs: [...el.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 30)) })).slice(0, 12);
  return { sessionAttrCount: withSessionAttr.length, sample, navCount: navs.length, navs, bodySample: (document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 300) };
});
console.log(JSON.stringify(info, null, 2));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
