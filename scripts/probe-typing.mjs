import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg] = process.argv;
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-typ-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 200)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: urlArg });
for (let i = 0; i < 60; i++) { if (await ev("document.readyState === 'complete'")) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev("document.querySelector('button[aria-label=\"工作台\"]') !== null")) break; await sleep(300); }
for (let i = 0; i < 6; i++) { const a = await ev("(()=>{const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='继续');if(n){n.click();return 1}const c=document.querySelector('[role=dialog] button[aria-label=\"关闭\"]');if(c){c.click();return 1}return 0})()"); if (!a) break; await sleep(500); }
await ev("document.querySelector('button[aria-label=\"工作台\"]').click()");
for (let i = 0; i < 60; i++) { if (await ev("document.querySelector('[data-wb-panel]') !== null")) break; await sleep(300); }
await sleep(1500);
await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));b.click()})()");
await sleep(900);
// click precisely via element rect + hit test
const info = await ev(`(()=>{const i=document.querySelector('[data-wb-triage="title"]');if(!i)return JSON.stringify({error:'no input'});const r=i.getBoundingClientRect();const cx=r.x+r.width/2,cy=r.y+r.height/2;const hit=document.elementFromPoint(cx,cy);return JSON.stringify({rect:{x:r.x,y:r.y,w:r.width,h:r.height},cx,cy,hitTag:hit&&hit.tagName,hitAttr:hit&&hit.getAttribute&&hit.getAttribute('data-wb-triage'),same:hit===i})})()`);
console.log('HITTEST ' + info);
const { cx, cy } = JSON.parse(info);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
await sleep(250);
console.log('FOCUS after click: ' + await ev("document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute('data-wb-triage')||'')"));
const trace = [];
for (const ch of 'abcdefghij') {
  await send('Input.insertText', { text: ch });
  await sleep(320);
  const v = await ev("JSON.stringify({v: document.querySelector('[data-wb-triage=\"title\"]')?.value, focus: document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute('data-wb-triage')||'')})");
  trace.push(ch + '->' + v);
}
console.log('TRACE ' + JSON.stringify(trace));
console.log('CONSOLE ' + JSON.stringify(logs));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
