import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg] = process.argv;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + (detail ? ' :: ' + detail : '')); };
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + mkdtempSync(join(tmpdir(),'chrome-open-')),'--window-size=1440,900','about:blank'], { stdio: ['ignore','pipe','pipe'] });
const wsUrl = await new Promise((res, rej) => { let b=''; const t=setTimeout(()=>rej(new Error('no devtools')),20000); const on=(d)=>{b+=d;const m=b.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}}; chrome.stderr.on('data',on); chrome.stdout.on('data',on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=1; const pending=new Map(); const errors=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id!==undefined){const p=pending.get(m.id); if(p){pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} return;} if(m.method==='Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception||{}).description||'').slice(0,140));};
const send=(method,params={})=>new Promise((res,rej)=>{const i=id++;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) return 'ERR '+String((r.exceptionDetails.exception||{}).description||r.exceptionDetails.text).slice(0,200); return r.result.value;};
const call=async(fn,...args)=>ev('('+fn.toString()+')('+args.map(a=>JSON.stringify(a)).join(',')+')');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__WB_DEBUG__ = true;' });
await send('Page.navigate',{url:urlArg + (urlArg.indexOf('?') >= 0 ? '&' : '?') + 'wbDebug=1'});
await sleep(3400);
for (let i=0;i<8;i++){const a=await call(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='继续'); if(b){b.click();return 1;} return 0;}); if(!a)break; await sleep(300);}

// 1) build a unit bound to a REAL session id (the shell always has at least one)
const sessionId = await call(() => {
  const el = document.querySelector('[data-conversation-session]');
  return el ? el.getAttribute('data-conversation-session') : null;
});
const built = await call(async (session) => {
  const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : {};
  const proj = unwrap(await post('project.create', { name: '打开对话验收' + Date.now().toString(36).slice(-4) }));
  const todo = unwrap(await post('todo.create', { title: '打开对话议题' }));
  const tr = await post('issue.triage', { issueId: todo.issueId, projectId: proj.projectId, workspacePath: '/tmp', acceptance: [{ text: 'c' }] });
  const claim = await post('unit.claim', { issueId: todo.issueId, sessionId: session, cwd: '/tmp' });
  return { issueId: todo.issueId, claim: claim.ok, error: claim.ok ? null : JSON.stringify(claim.error), tri: tr.ok };
}, sessionId);
check('OPEN-01 a real shell session is available and bound to a unit', Boolean(sessionId) && built.claim === true, JSON.stringify({ sessionId, built }));

// 2) spy on the official switch to learn exactly what the panel asks for
const spy = await ev("(function(){ var c=window.__WB_CTX__; if(!c) return 'no-ctx'; var uw=c.get('uiWorkspace'); if(!uw) return 'no-uiWorkspace'; window.__WB_OPEN_CALLS__=[]; var original=uw.openSession.bind(uw); uw.openSession=function(sid){ window.__WB_OPEN_CALLS__.push(String(sid)); try { return original(sid); } catch(e) { return undefined; } }; return 'spied'; })()");
check('OPEN-02 the shell exposes uiWorkspace.openSession', spy === 'spied', spy);
// the plugin panel must be mounted before its buttons exist
await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
await sleep(2000);
await ev("window.location.hash = '#/issue/" + built.issueId + "'");
await sleep(2000);
const clicked = await call(() => {
  const btn = [...document.querySelectorAll('[data-wb-panel] button')].find((b) => (b.textContent || '').trim() === '打开对话');
  if (!btn) return 'missing';
  btn.click();
  return 'clicked';
});
await sleep(1200);
const calls = await ev("window.__WB_OPEN_CALLS__ || []");
check('OPEN-03 打开对话 targets THIS unit session id', clicked === 'clicked' && Array.isArray(calls) && calls.length === 1 && calls[0] === sessionId, JSON.stringify({ clicked, calls, sessionId }));
const shown = await call(() => { const el = document.querySelector('[data-conversation-session]'); return el ? el.getAttribute('data-conversation-session') : null; });
check('OPEN-04 the conversation panel shows that same session', shown === sessionId, JSON.stringify({ shown, sessionId }));
check('OPEN-05 no uncaught exceptions while opening', errors.length === 0, JSON.stringify(errors.slice(0,2)));
console.log('---');
console.log('OPEN CONVERSATION: ' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
ws.close(); chrome.kill('SIGKILL'); process.exit(results.every((r) => r.ok) ? 0 : 1);
