// Diagnostic walk over CDP against a real DSH web client:
// typing into the new-issue dialog, dark-theme rendering, and layout bounds.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-probe-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''; const t = setTimeout(() => reject(new Error('no devtools: ' + buf)), 20000);
  const on = (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } };
  chrome.stderr.on('data', on); chrome.stdout.on('data', on);
});
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(200); } throw new Error('timeout: ' + label); };
const shot = async (name) => { const d = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, name), Buffer.from(d, 'base64')); };

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

  console.log('FACT panel text length: ' + await ev("document.querySelector('[data-wb-panel]').textContent.length"));
  console.log('FACT open dialog buttons: ' + await ev("JSON.stringify([...document.querySelectorAll('[data-wb-panel] button')].map(b=>b.textContent.trim()).slice(0,14))"));

  // Open the new-issue dialog from the project row (「＋新建议题」).
  const opened = await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));if(!b)return false;b.click();return true})()");
  console.log('FACT clicked 新建议题: ' + opened);
  await sleep(600);
  const dialogInfo = await ev("JSON.stringify({dialogs: document.querySelectorAll('[data-wb-triage]').length, inputs: [...document.querySelectorAll('[data-wb-triage] input')].map(i=>({attr:i.getAttribute('data-wb-triage'),type:i.type,readonly:i.readOnly,disabled:i.disabled,value:i.value}))})");
  console.log('FACT dialog: ' + dialogInfo);

  // Focus the title input by real mouse click, then type with real key events.
  const rect = await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"title\"]');if(!i)return null;const r=i.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height})})()");
  console.log('FACT title rect: ' + rect);
  if (rect) {
    const { x, y } = JSON.parse(rect);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(200);
    console.log('FACT activeElement after click: ' + await ev("document.activeElement && document.activeElement.tagName + '/' + (document.activeElement.getAttribute && document.activeElement.getAttribute('data-wb-triage'))"));
    await send('Input.insertText', { text: '真实输入测试' });
    await sleep(300);
    console.log('FACT value after insertText: ' + JSON.stringify(await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value")));
    // Also try per-character key events (what a user actually does).
    for (const ch of ['A', 'B']) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Key' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
      await sleep(120);
    }
    console.log('FACT value after keydown chars: ' + JSON.stringify(await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value")));
    console.log('FACT activeElement after typing: ' + await ev("document.activeElement && document.activeElement.tagName + '/' + (document.activeElement.getAttribute && document.activeElement.getAttribute('data-wb-triage'))"));
    await shot('PROBE-dialog-light.png');
  }

  // Layout bounds: horizontal overflow + dialog rect vs viewport.
  console.log('FACT bounds: ' + await ev("JSON.stringify({docScroll: document.documentElement.scrollWidth, innerW: innerWidth, bodyScroll: document.body.scrollWidth, panelRect: (()=>{const r=document.querySelector('[data-wb-panel]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})(), dialogRect: (()=>{const d=document.querySelector('[data-wb-triage]');if(!d)return null;const r=d.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}})()})"));

  // Dark theme.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(900);
  console.log('FACT dark: ' + await ev("(()=>{const p=document.querySelector('[data-wb-panel]');const cs=getComputedStyle(p);const b=getComputedStyle(document.body);return JSON.stringify({scheme:matchMedia('(prefers-color-scheme: dark)').matches,panelBg:cs.backgroundColor,panelColor:cs.color,bodyBg:b.backgroundColor,bodyColor:b.color,htmlClass:document.documentElement.className,htmlDataTheme:document.documentElement.getAttribute('data-theme')})})()"));
  await shot('PROBE-dialog-dark.png');

  // Narrow viewport bounds.
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  console.log('FACT narrow: ' + await ev("JSON.stringify({innerW: innerWidth, docScroll: document.documentElement.scrollWidth, dialog: (()=>{const d=document.querySelector('[data-wb-triage]');if(!d)return null;const r=d.getBoundingClientRect();return {w:r.width,h:r.height,right:r.right,bottom:r.bottom}})()})"));
  await shot('PROBE-narrow.png');

  console.log('CONSOLE: ' + JSON.stringify(logs.slice(0, 10)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
} catch (e) { console.error('PROBE FAILED: ' + String(e)); console.error('CONSOLE: ' + JSON.stringify(logs.slice(0, 10))); try { chrome.kill('SIGKILL'); } catch {} process.exit(1); }
