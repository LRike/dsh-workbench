// Probe 2: does polling reset typed text? what are the real DSH theme vars?
// where does content overflow? how do long strings behave?
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-p2-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (x, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(x)) return true; await sleep(200); } throw new Error('timeout ' + label); };
const shot = async (n) => { const d = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, n), Buffer.from(d, 'base64')); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: urlArg });
  await waitFor("document.readyState === 'complete'", 30000, 'load');
  await waitFor("document.querySelector('button[aria-label=\"工作台\"]') !== null", 30000, 'sidebar');
  for (let i = 0; i < 6; i++) { const a = await ev("(()=>{const n=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='继续');if(n){n.click();return 1}const c=document.querySelector('[role=dialog] button[aria-label=\"关闭\"]');if(c){c.click();return 1}return 0})()"); if (!a) break; await sleep(500); }
  await ev("document.querySelector('button[aria-label=\"工作台\"]').click()");
  await waitFor("document.querySelector('[data-wb-panel]') !== null", 15000, 'panel');
  await sleep(1200);

  // --- A. real theme variables shipped by DSH ---
  console.log('A. root css vars sample: ' + await ev(`(()=>{const names=new Set();for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules}catch{continue}for(const rule of rules||[]){if(!rule.style)continue;for(const key of rule.style){if(key.startsWith('--'))names.add(key)}}}const arr=[...names];return JSON.stringify({total:arr.length, dsw:arr.filter(n=>n.includes('dsw')).slice(0,40), sample:arr.slice(0,25)})})()`));
  console.log('B. computed on panel parent chain: ' + await ev(`(()=>{const out=[];let el=document.querySelector('[data-wb-panel]');for(let i=0;i<5&&el;i++){const cs=getComputedStyle(el);out.push({tag:el.tagName,cls:(el.className||'').toString().slice(0,40),bg:cs.backgroundColor,color:cs.color,overflow:cs.overflow,transform:cs.transform,position:cs.position});el=el.parentElement}return JSON.stringify(out)})()`));

  // --- C. polling resets typed text? ---
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.trim()==='＋新建议题');b.click()})()");
  await sleep(500);
  const r = await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"title\"]');const b=i.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()");
  const { x, y } = JSON.parse(r);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await send('Input.insertText', { text: '轮询测试' });
  const t0 = await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value");
  await sleep(2600);
  const t1 = await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value");
  await sleep(2600);
  const t2 = await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value");
  console.log('C. typed text persistence: ' + JSON.stringify({ after: t0, after2_6s: t1, after5_2s: t2 }));

  // --- D. overflow audit inside the panel (light + dark) ---
  const audit = `(()=>{const root=document.querySelector('[data-wb-panel]');if(!root)return '[]';const bad=[];for(const el of root.querySelectorAll('*')){if(el.scrollWidth>el.clientWidth+1&&el.clientWidth>0){bad.push({tag:el.tagName,attr:el.getAttribute&&el.getAttribute('data-wb-'+'x'),cls:(el.className||'').toString().slice(0,24),sw:el.scrollWidth,cw:el.clientWidth,text:(el.textContent||'').trim().slice(0,24)})}if(bad.length>8)break}return JSON.stringify({count:bad.length,items:bad})})()`;
  console.log('D. overflow audit (dialog open): ' + await ev(audit));
  await shot('PROBE2-light-dialog.png');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(800);
  console.log('E. dark colors: ' + await ev(`(()=>{const p=document.querySelector('[data-wb-panel]');const t=document.querySelector('[data-wb-counters]');const cs=getComputedStyle(p);const cs2=t?getComputedStyle(t):null;return JSON.stringify({panelBg:cs.backgroundColor,panelColor:cs.color,counterBg:cs2&&cs2.backgroundColor,counterColor:cs2&&cs2.color,varText:getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-text-primary')||'(empty)',varBg:getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base')||'(empty)'})})()`));
  await shot('PROBE2-dark-dialog.png');
  console.log('CONSOLE: ' + JSON.stringify(logs.slice(0, 5)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
} catch (e) { console.error('FAILED: ' + String(e)); try { chrome.kill('SIGKILL'); } catch {} process.exit(1); }
