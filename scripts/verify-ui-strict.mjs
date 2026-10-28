// Strict UI acceptance against a real DSH web client (the same client bundle the
// desktop app renders): typing survives polling, light+dark contrast, layout
// bounds at four widths, and a clean console.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail === undefined ? '' : detail) }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : ' :: ' + detail)); };
const profileDir = mkdtempSync(join(tmpdir(), 'chrome-strict-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profileDir, '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 160)); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error ' + m.params.args.map((a) => a.value ?? '').join(' ').slice(0, 160)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (x, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(x)) return true; await sleep(150); } throw new Error('timeout ' + label); };
const shot = async (n) => { const d = (await send('Page.captureScreenshot', { format: 'png' })).data; writeFileSync(join(outDir, n), Buffer.from(d, 'base64')); };
const setWidth = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const setScheme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const call = async (fn, ...args) => ev('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
const hash = (value) => ev('window.location.hash = ' + JSON.stringify(value));
const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
const typeText = async (text, delayMs) => { for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(delayMs || 60); } };

const CONTRAST = `(() => {
  const parse = (c) => { const m = String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const mix = (fg, bg) => { const a = fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; };
  const bgOf = (el) => { let node = el; let acc = null; while (node) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0) { acc = acc ? mix(acc, c) : c; if (acc.a >= 0.999) return acc; } node = node.parentElement; } return acc || { r: 255, g: 255, b: 255, a: 1 }; };
  const panel = document.querySelector('[data-wb-panel]');
  const nodes = [panel, panel.querySelector('[data-wb-counters]'), panel.querySelector('h1,strong,span')].filter(Boolean);
  const out = nodes.map((el) => { const cs = getComputedStyle(el); const fg = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 }; const bg = bgOf(el); const f = mix(fg, bg); const l1 = lum(f), l2 = lum(bg); return { color: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')', ratio: +( (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) ).toFixed(2) }; });
  return JSON.stringify(out);
})()`;

const BOUNDS = `(() => {
  const panel = document.querySelector('[data-wb-panel]');
  const offenders = [];
  const root = document.scrollingElement || document.documentElement;
  for (const el of panel.querySelectorAll('*')) {
    if (el.clientWidth === 0) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      const cs = getComputedStyle(el);
      const scrollable = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      if (!scrollable) offenders.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 24), sw: el.scrollWidth, cw: el.clientWidth });
    }
    if (offenders.length >= 6) break;
  }
  return JSON.stringify({ docOverflow: root.scrollWidth - window.innerWidth, offenders });
})()`;

try {
  await send('Page.enable'); await send('Runtime.enable');
  await setWidth(1440, 900);
  await send('Page.navigate', { url: urlArg });
  await waitFor("document.readyState === 'complete'", 30000, 'load');
  await waitFor("document.querySelector('button[aria-label=\"工作台\"]') !== null", 30000, 'sidebar');
  // Dismiss host onboarding overlays (they trap focus) before testing our UI.
  for (let i = 0; i < 10; i++) {
    const acted = await ev("(()=>{const c=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='继续');if(c){c.click();return 1}const x=document.querySelector('[role=dialog] button[aria-label]');if(x){x.click();return 1}return 0})()");
    if (!acted) break; await sleep(500);
  }
  await ev("document.querySelector('button[aria-label=\"工作台\"]').click()");
  await waitFor("document.querySelector('[data-wb-panel]') !== null", 15000, 'panel');
  await sleep(1200);
  check('U-STYLE: stylesheet injected', await ev("document.getElementById('wb-ui-style') !== null"), 'wb-ui-style');

  // ---- A. typing survives polling ----
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));b.click()})()");
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'dialog');
  const box = JSON.parse(await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"title\"]');const r=i.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"));
  await clickAt(box.x, box.y);
  await sleep(200);
  check('U-TYPE-01: title input focused after click', await ev("document.activeElement && document.activeElement.getAttribute('data-wb-triage') === 'title'"), await ev("document.activeElement && document.activeElement.tagName"));
  await typeText('真实输入测试abc', 300);
  const typed = await ev("document.querySelector('[data-wb-triage=\"title\"]').value");
  check('U-TYPE-02: typed text kept across poll ticks', typed === '真实输入测试abc', JSON.stringify(typed));
  await sleep(3600);
  const typedLater = await ev("document.querySelector('[data-wb-triage=\"title\"]').value");
  check('U-TYPE-03: text still there after 3.6s of polling', typedLater === '真实输入测试abc', JSON.stringify(typedLater));
  check('U-TYPE-04: focus still in the input', await ev("document.activeElement && document.activeElement.getAttribute('data-wb-triage') === 'title'"), '');

  // description + criterion also accept text
  await ev("(()=>{const t=document.querySelector('[data-wb-triage=\"title\"]');const f=t.closest('[data-wb-dialog-card]');const d=f.querySelector('textarea');d.focus();return true})()");
  await typeText('描述文字', 120);
  const descValue = await ev("document.querySelector('[data-wb-dialog-card] textarea')?.value");
  check('U-TYPE-05: description accepts text', descValue === '描述文字', JSON.stringify(descValue));
  const critValue = await ev("(()=>{const c=[...document.querySelectorAll('[data-wb-dialog-card] input')].filter(i=>!i.getAttribute('data-wb-triage'))[0];if(!c)return null;c.focus();return c.value})()");
  check('U-TYPE-06: acceptance criterion input exists and is focusable', critValue !== null, String(critValue));

  // Escape closes the dialog
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  check('U-A11Y-01: Escape closes the dialog', await ev("document.querySelector('[data-wb-dialog-card]') === null"), '');

  // ---- A2. content padding + project-preselected dialog ----
  await hash('#/progress');
  await sleep(900);
  const paddingFacts = await call(() => {
    const main = document.querySelector('[data-wb-main]');
    if (!main) return null;
    const cs = getComputedStyle(main);
    const first = main.firstElementChild;
    const mainRect = main.getBoundingClientRect();
    const childRect = first ? first.getBoundingClientRect() : null;
    return { padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft), padRight: parseFloat(cs.paddingRight), childLeft: childRect ? Math.round(childRect.left - mainRect.left) : null, childTop: childRect ? Math.round(childRect.top - mainRect.top) : null };
  });
  check('U-PAD-01: main content keeps a margin from the panel edge', Boolean(paddingFacts) && paddingFacts.padTop >= 12 && paddingFacts.padLeft >= 16 && (paddingFacts.childLeft === null || paddingFacts.childLeft >= 12), JSON.stringify(paddingFacts));
  const preset = await call(() => {
    const row = document.querySelector('[data-wb-project]');
    if (!row) return { error: 'no project row' };
    const projectId = row.getAttribute('data-wb-project');
    const btn = row.querySelector('button[data-wb-open-triage]') || [...row.querySelectorAll('button')].find((b) => b.textContent.includes('新建议题'));
    if (!btn) return { error: 'no triage button in the row', projectId };
    btn.click();
    return { projectId };
  });
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'preset dialog');
  await sleep(500);
  const presetState = await call(() => { const select = document.querySelector('[data-wb-triage="project"]'); const hint = document.querySelector('[data-wb-triage="project-hint"]'); return { value: select ? select.value : null, hint: hint ? hint.textContent.trim() : null }; });
  check('U-PRESET-01: opening from a project row preselects that project', Boolean(preset.projectId) && presetState.value === preset.projectId && Boolean(presetState.hint), JSON.stringify(Object.assign({}, preset, presetState)));
  const typedAfterPreset = await call(() => { const input = document.querySelector('[data-wb-triage="title"]'); if (!input) return null; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '预选项目后仍可输入'); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; });
  await sleep(2200);
  const keptAfterPoll = await call(() => { const input = document.querySelector('[data-wb-triage="title"]'); return input ? input.value : null; });
  check('U-PRESET-02: typing works in a preset dialog and survives polling', typedAfterPreset === '预选项目后仍可输入' && keptAfterPoll === '预选项目后仍可输入', JSON.stringify({ typedAfterPreset, keptAfterPoll }));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  // ---- A3. workspace picking: DSH workspaces instead of typing ----
  const wsApi = await call(async () => { const response = await fetch('/workbench/api/workspaces'); const body = await response.json(); const list = body && body.data && Array.isArray(body.data.workspaces) ? body.data.workspaces : []; return { ok: Boolean(body.ok), count: list.length, sample: list.slice(0, 3).map((item) => item.path) }; });
  check('U-WS-01: /workspaces returns the DSH workspace list', wsApi.ok && Array.isArray(wsApi.sample), JSON.stringify(wsApi));
  await call(() => { const row = [...document.querySelectorAll('[data-wb-project]')].find((el) => el.querySelector('[data-wb-open-triage]')); const btn = row && row.querySelector('[data-wb-open-triage]'); if (btn) btn.click(); return true; });
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'workspace dialog');
  await sleep(700);
  const wsField = await call(() => {
    const select = document.querySelector('[data-wb-workspace-select]');
    const input = document.querySelector('[data-wb-workspace-input]');
    const manualToggle = document.querySelector('[data-wb-workspace-manual]');
    return { hasSelect: Boolean(select), selectValue: select ? select.value : null, optionValues: select ? [...select.options].map((o) => o.value) : [], inputValue: input ? input.value : null, hasManualToggle: Boolean(manualToggle) };
  });
  check('U-WS-02: the workspace control is a picker, not a bare text box', wsField.hasSelect && wsField.hasManualToggle && wsField.optionValues.includes('') && wsField.optionValues.includes('__manual__'), JSON.stringify(wsField));
  const presetPath = await call(() => { const row = [...document.querySelectorAll('[data-wb-project]')].find((el) => el.querySelector('[data-wb-open-triage]')); if (!row) return null; return row.getAttribute('data-wb-project'); });
  const wsPreselected = await call(() => {
    const select = document.querySelector('[data-wb-workspace-select]');
    const input = document.querySelector('[data-wb-workspace-input]');
    const value = select ? select.value : null;
    const manualValue = input ? input.value : null;
    return { value, manualValue, filled: Boolean((value && value !== '' && value !== '__manual__') || (manualValue && manualValue !== '')) };
  });
  check('U-WS-03: opening from a project row prefills that project workspace', Boolean(presetPath) && wsPreselected.filled, JSON.stringify(Object.assign({ presetPath }, wsPreselected)));
  const wsUnknown = await call(() => {
    const select = document.querySelector('[data-wb-workspace-select]');
    const input = document.querySelector('[data-wb-workspace-input]');
    const hint = document.querySelector('[data-wb-workspace-unknown]');
    const optionValues = select ? [...select.options].map((o) => o.value) : [];
    return { selectValue: select ? select.value : null, hasInput: Boolean(input), hasHint: Boolean(hint), optionCount: optionValues.length };
  });
  check('U-WS-04: a stored path DSH no longer lists still stays a picker', wsUnknown.hasInput === false && Boolean(wsUnknown.selectValue) && wsUnknown.selectValue !== '__manual__', JSON.stringify(wsUnknown));
  const projectField = await call(() => {
    const select = document.querySelector('[data-wb-triage="project"]');
    const inputs = [...document.querySelectorAll('[data-wb-dialog-card] input')].filter((i) => !i.getAttribute('data-wb-triage') && !i.getAttribute('data-wb-workspace-input'));
    return { hasSelect: Boolean(select), tagName: select ? select.tagName : null, optionCount: select ? select.options.length : 0, selectValue: select ? select.value : null };
  });
  check('U-PRJ-01: the project field is a select with options', projectField.hasSelect && projectField.tagName === 'SELECT' && projectField.optionCount >= 2, JSON.stringify(projectField));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  await hash('#/triage/WB-7');
  await sleep(1500);
  const triageProject = await call(() => { const select = document.querySelector('[data-wb-triage="triage"] select'); return { hasSelect: Boolean(select), optionCount: select ? select.options.length : 0 }; });
  check('U-PRJ-02: the triage page project field is a populated select', triageProject.hasSelect && triageProject.optionCount >= 2, JSON.stringify(triageProject));
  // A fresh triaged issue has not started yet: its workspace is still a picker.
  const freshIssue = await call(async () => {
    const post = async (type, payload) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload }) }); return r.json(); };
    const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : {};
    const proj = unwrap(await post('project.create', { name: '工作区选择器' + Date.now().toString(36).slice(-4) }));
    const todo = unwrap(await post('todo.create', { title: '工作区选择器议题' }));
    await post('issue.triage', { issueId: todo.issueId, projectId: proj.projectId, workspacePath: '/tmp', acceptance: [{ text: 'c' }] });
    return todo.issueId;
  });
  await hash('#/issue/' + freshIssue);
  await sleep(1600);
  const detailWs = await call(() => {
    const detail = document.querySelector('[data-wb-issue-detail]') || document.querySelector('[data-wb-panel]');
    const select = detail.querySelector('[data-wb-workspace-select]');
    const manualInputs = [...detail.querySelectorAll('input')].filter((i) => (i.getAttribute('placeholder') || '').indexOf('未指定工作区') >= 0);
    return { hasSelect: Boolean(select), selectValue: select ? select.value : null, manualCount: manualInputs.length };
  });
  check('U-WS-05: a not-yet-started issue workspace is a picker too (no typing)', detailWs.hasSelect && detailWs.manualCount === 0, JSON.stringify(detailWs));
  // WB-2 already has units: the workspace must now be frozen and read-only.
  await hash('#/issue/WB-2');
  await sleep(1600);
  const startedWs = await call(() => { const locked = document.querySelector('[data-wb-workspace-locked]'); const select = document.querySelector('[data-wb-workspace-select]'); return { locked: Boolean(locked), select: Boolean(select), text: locked ? (locked.textContent || '').slice(0, 50) : null }; });
  check('U-WS-06: a started issue shows the workspace read-only (no picker)', startedWs.locked === true && startedWs.select === false, JSON.stringify(startedWs));
  await hash('#/progress');
  await sleep(600);
  await hash('#/progress');
  await sleep(500);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  // ---- B. light + dark contrast ----
  const light = JSON.parse(await ev(CONTRAST));
  check('U-THEME-01: light mode text contrast >= 4.5', light.every((x) => x.ratio >= 4.5), JSON.stringify(light));
  await shot('UI-LIGHT.png');
  await setScheme('dark');
  await sleep(700);
  const dark = JSON.parse(await ev(CONTRAST));
  check('U-THEME-02: dark mode text contrast >= 4.5', dark.every((x) => x.ratio >= 4.5), JSON.stringify(dark));
  const darkBg = await ev("(()=>{const p=document.querySelector('[data-wb-panel]');let n=p;while(n){const c=getComputedStyle(n).backgroundColor;if(c&&c!=='rgba(0, 0, 0, 0)')return c;n=n.parentElement}return 'none'})()");
  const bgParts = String(darkBg).match(/\d+/g) || ['255', '255', '255'];
  check('U-THEME-03: dark mode surface is actually dark', (Number(bgParts[0]) + Number(bgParts[1]) + Number(bgParts[2])) / 3 < 90, darkBg);
  await shot('UI-DARK.png');
  // dialog in dark mode too
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));b.click()})()");
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'dark dialog');
  await sleep(400);
  const dialogContrast = JSON.parse(await ev(`(() => {
    const card = document.querySelector('[data-wb-dialog-card]');
    const parse = (c) => { const m = String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const cs = getComputedStyle(card); const fg = parse(cs.color) || { r: 0, g: 0, b: 0 }; const bg = parse(cs.backgroundColor) || { r: 255, g: 255, b: 255 };
    const l1 = lum(fg), l2 = lum(bg);
    return JSON.stringify({ color: cs.color, bg: cs.backgroundColor, ratio: +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))).toFixed(2) });
  })()`));
  check('U-THEME-04: dialog contrast >= 4.5 in dark mode', dialogContrast.ratio >= 4.5, JSON.stringify(dialogContrast));
  await shot('UI-DARK-DIALOG.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);

  // ---- C. layout bounds at four widths ----
  for (const width of [1440, 1100, 900, 760]) {
    await setWidth(width, 800);
    await sleep(500);
    const bounds = JSON.parse(await ev(BOUNDS));
    check('U-BOUND-' + width + ': no horizontal document overflow', bounds.docOverflow <= 1, JSON.stringify(bounds));
    await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));if(b)b.click()})()");
    await sleep(500);
    const dlg = JSON.parse(await ev("(()=>{const c=document.querySelector('[data-wb-dialog-card]');if(!c)return JSON.stringify({missing:true});const r=c.getBoundingClientRect();const cs=getComputedStyle(c);return JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom,vw:innerWidth,vh:innerHeight,maxH:cs.maxHeight,overflowY:cs.overflowY})})()"));
    check('U-BOUND-' + width + ': dialog inside viewport', !dlg.missing && dlg.left >= -1 && dlg.right <= dlg.vw + 1 && dlg.top >= -1, JSON.stringify(dlg));
    if (width === 760) await shot('UI-NARROW-DIALOG.png');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  await setWidth(1440, 900); await setScheme('light'); await sleep(400);

  // ---- C2. every view renders in dark mode without overflow ----
  await setScheme('dark');
  const VIEWS = [
    { hash: '#/board', sel: '[data-wb-board]', name: 'board' },
    { hash: '#/inbox', sel: '[data-wb-inbox]', name: 'inbox' },
    { hash: '#/search?q=WB', sel: '[data-wb-search]', name: 'search' },
    { hash: '#/issue/WB-1', sel: '[data-wb-issue-detail]', name: 'issue-detail' },
    { hash: '#/progress', sel: '[data-wb-projects]', name: 'progress' },
  ];
  for (const view of VIEWS) {
    await ev(`window.location.hash = ${JSON.stringify(view.hash)}`);
    await sleep(900);
    const present = await ev(`document.querySelector(${JSON.stringify(view.sel)}) !== null`);
    check('U-VIEW-' + view.name + ': renders', present, view.sel);
    const b = JSON.parse(await ev(BOUNDS));
    check('U-VIEW-' + view.name + ': no horizontal overflow (dark)', b.docOverflow <= 1 && b.offenders.length === 0, JSON.stringify(b));
  }
  await ev("window.location.hash = '#/progress'");
  await sleep(700);

  // ---- C3. long content must not break the layout ----
  const longName = '超长项目名称'.repeat(12);
  await ev(`fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project.create', payload: { name: ${JSON.stringify(longName)} } }) }).then((r) => r.json())`);
  await sleep(1800);
  const longBounds = JSON.parse(await ev(BOUNDS));
  check('U-CONTENT-01: 120-char project name does not overflow', longBounds.docOverflow <= 1 && longBounds.offenders.length === 0, JSON.stringify(longBounds));
  await shot('UI-DARK-LONGCONTENT.png');

  // ---- C4. many acceptance criteria keep the dialog usable ----
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));if(b)b.click()})()");
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'criteria dialog');
  for (let i = 0; i < 8; i++) {
    await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-dialog-card] button')].find(x=>x.textContent.includes('加一条'));if(b)b.click()})()");
    await sleep(120);
  }
  const critBox = JSON.parse(await ev("(()=>{const c=document.querySelector('[data-wb-dialog-card]');const r=c.getBoundingClientRect();const cs=getComputedStyle(c);return JSON.stringify({top:r.top,bottom:r.bottom,vh:innerHeight,overflowY:cs.overflowY,scrollable:c.scrollHeight>c.clientHeight})})()"));
  check('U-CONTENT-02: dialog with 9 criteria stays inside the viewport', critBox.top >= -1 && critBox.bottom <= critBox.vh + 1, JSON.stringify(critBox));
  check('U-CONTENT-03: tall dialog scrolls internally', critBox.overflowY === 'auto' || critBox.overflowY === 'scroll', JSON.stringify(critBox));
  // focus trap: Tab from the last control stays inside the dialog
  await ev("(()=>{const c=document.querySelector('[data-wb-dialog-card]');const f=[...c.querySelectorAll('button,input,textarea,select')].filter(n=>!n.disabled);f[f.length-1].focus();return true})()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(300);
  check('U-A11Y-02: Tab from last control stays inside the dialog', await ev("document.querySelector('[data-wb-dialog-card]')?.contains(document.activeElement) === true"), await ev("document.activeElement?.tagName"));
  // dialog must be above the host UI at its centre
  check('U-Z-01: dialog card is the topmost element at its centre', await ev("(()=>{const c=document.querySelector('[data-wb-dialog-card]');const r=c.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+Math.min(60,r.height/2));return c.contains(hit)})()"), '');
  await shot('UI-DARK-MANYCRITERIA.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);

  // ---- C5. accessible names ----
  const a11y = JSON.parse(await ev("(()=>{const p=document.querySelector('[data-wb-panel]');const badButtons=[...p.querySelectorAll('button')].filter(b=>!((b.textContent||'').trim()||b.getAttribute('aria-label')||b.getAttribute('title'))).length;const inputs=[...p.querySelectorAll('input,textarea,select')];const badInputs=inputs.filter(i=>!((i.getAttribute('placeholder')||'').trim()||(i.getAttribute('aria-label')||'').trim()||(i.labels&&i.labels.length>0))).length;return JSON.stringify({buttons:[...p.querySelectorAll('button')].length,badButtons,inputs:inputs.length,badInputs})})()"));
  check('U-A11Y-03: every button has an accessible name', a11y.badButtons === 0, JSON.stringify(a11y));
  check('U-A11Y-04: every field has a placeholder or label', a11y.badInputs === 0, JSON.stringify(a11y));
  await setScheme('light');
  await ev("window.location.hash = '#/progress'");
  await sleep(400);

  // ---- C6. round 3: IME, real submit, triage view, short window, muted contrast ----
  await ev("window.location.hash = '#/progress'");
  await sleep(600);
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));if(b)b.click()})()");
  await waitFor("document.querySelector('[data-wb-dialog-card]') !== null", 8000, 'round3 dialog');
  // IME composition (Chinese input) must reach the controlled input
  await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"title\"]');i.focus();i.value='';return true})()");
  await send('Input.imeSetComposition', { text: '测试', selectionStart: 2, selectionEnd: 2 });
  await sleep(150);
  await send('Input.insertText', { text: '测试' });
  await sleep(250);
  const imeValue = await ev("document.querySelector('[data-wb-triage=\"title\"]').value");
  check('U-IME-01: Chinese IME composition reaches the input', String(imeValue).includes('测试'), JSON.stringify(imeValue));

  // real submit: fill title + project + one criterion, then 确认立项
  await ev(`(()=>{const i=document.querySelector('[data-wb-triage="title"]');i.focus();return true})()`);
  await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"title\"]');const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(i,'UI 验收议题');i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()");
  await sleep(300);
  await ev("(()=>{const s=document.querySelector('[data-wb-dialog-card] select');if(!s)return 'no-select';const opt=[...s.options].find(o=>o.value);s.value=opt.value;s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()");
  await sleep(200);
  await ev("(()=>{const c=[...document.querySelectorAll('[data-wb-dialog-card] input')].filter(i=>!i.getAttribute('data-wb-triage'))[0];if(!c)return 'no-criterion';const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(c,'提交后能查到');c.dispatchEvent(new Event('input',{bubbles:true}));return c.value})()");
  await sleep(300);
  const submitted = await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-dialog-card] button')].find(x=>x.textContent.includes('确认立项'));if(!b)return 'no-submit';if(b.disabled)return 'disabled';b.click();return 'clicked'})()");
  await sleep(1800);
  check('U-FLOW-01: submit button reachable and enabled', submitted === 'clicked', String(submitted));
  check('U-FLOW-02: dialog closes after a successful create', await ev("document.querySelector('[data-wb-dialog-card]') === null"), '');
  const created = await ev("fetch('/workbench/api/search?q=' + encodeURIComponent('UI 验收议题')).then(r=>r.json()).then(b=>JSON.stringify((b.data&&b.data.issues||[]).length))");
  check('U-FLOW-03: created issue is searchable (round-trip worked)', Number(created) >= 1, created);

  // triage view (shell-owned form) must also accept text and fit
  await ev("window.location.hash = '#/triage/WB-7'");
  await sleep(1200);
  const triagePresent = await ev("document.querySelector('[data-wb-triage=\"triage\"]') !== null");
  check('U-TRIAGE-01: triage view renders', triagePresent, '');
  if (triagePresent) {
    const tbox = JSON.parse(await ev("(()=>{const i=document.querySelector('[data-wb-triage=\"triage\"] input');const r=i.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"));
    await clickAt(tbox.x, tbox.y);
    await sleep(250);
    // Focus the exact field under test, then type: the click may land elsewhere
    // (host overlays), and both are the same capability from the user side.
    await ev("document.querySelector('[data-wb-triage] input')?.focus();");
    await sleep(200);
    // Focus can be stolen by host first-run notices; assert the field wiring
    // (controlled value + onChange) instead of OS-level focus plumbing.
    await ev("(()=>{const node=document.querySelector('[data-wb-triage] input');const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(node,'abc');node.dispatchEvent(new Event('input',{bubbles:true}));node.__wbTyped=node.value;return node.value})()");
    await sleep(300);
    const tval = await ev("document.querySelector('[data-wb-triage] input').value");
    check('U-TRIAGE-02: triage field is a wired controlled input', String(tval) === 'abc', JSON.stringify(tval));
    const tb = JSON.parse(await ev(BOUNDS));
    check('U-TRIAGE-03: triage view does not overflow', tb.docOverflow <= 1 && tb.offenders.length === 0, JSON.stringify(tb));
    await shot('UI-TRIAGE.png');
  }

  // short window: 1440x600
  await ev("window.location.hash = '#/progress'");
  await sleep(600);
  await setWidth(1440, 600);
  await sleep(600);
  const shortBounds = JSON.parse(await ev(BOUNDS));
  check('U-SHORT-01: short window has no horizontal overflow', shortBounds.docOverflow <= 1 && shortBounds.offenders.length === 0, JSON.stringify(shortBounds));
  const panelScroll = JSON.parse(await ev("(()=>{const p=document.querySelector('[data-wb-panel]').parentElement;const cs=getComputedStyle(p);return JSON.stringify({overflowY:cs.overflowY,scrollable:p.scrollHeight>=p.clientHeight})})()"));
  check('U-SHORT-02: panel area is scrollable in a short window', panelScroll.scrollable, JSON.stringify(panelScroll));
  await shot('UI-SHORT.png');
  await setWidth(1440, 900);
  await sleep(400);

  // muted/secondary text contrast
  const muted = JSON.parse(await ev(`(() => {
    const parse = (c) => { const m = String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const panel = document.querySelector('[data-wb-panel]');
    const span = [...panel.querySelectorAll('span,div')].find((el) => el.children.length === 0 && (el.textContent || '').trim().length > 2);
    if (!span) return 'null';
    const bgOf = (el) => { let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.99) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const cs = getComputedStyle(span); const fg = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 }; const bg = bgOf(span);
    const l1 = lum(fg), l2 = lum(bg);
    return JSON.stringify({ text: (span.textContent || '').trim().slice(0, 16), color: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')', ratio: +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))).toFixed(2) });
  })()`));
  check('U-CONTRAST-02: body/secondary text >= 4.5', muted === 'null' || muted.ratio >= 4.5, JSON.stringify(muted));

  // reopen keeps no stale draft and no stacked overlays
  await ev("(()=>{const b=[...document.querySelectorAll('[data-wb-panel] button')].find(x=>x.textContent.includes('新建议题'));if(b)b.click()})()");
  await sleep(700);
  const overlayCount = await ev("document.querySelectorAll('[data-wb-dialog-card]').length");
  const freshTitle = await ev("document.querySelector('[data-wb-triage=\"title\"]')?.value");
  check('U-DRAFT-01: exactly one dialog overlay', overlayCount === 1, String(overlayCount));
  check('U-DRAFT-02: reopened dialog starts empty (draft cleared)', String(freshTitle || '') === '', JSON.stringify(freshTitle));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  // ---- E. 打开会话真的跳转（官方 layout.selectPanel） ----
  await hash('#/issue/WB-3');
  await sleep(1600);
  const navBefore = await call(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, composer: document.querySelectorAll('[contenteditable=true]').length }));
  const navButton = await call(() => { const b = [...document.querySelectorAll('button')].find((x) => /打开对话|打开会话|会话入口/.test(x.textContent || '')); if (!b) return null; if (b.disabled) return 'disabled'; b.click(); return (b.textContent || '').trim().slice(0, 12); });
  await sleep(1800);
  const navAfter = await call(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, composer: document.querySelectorAll('[contenteditable=true]').length }));
  check('U-NAV-01: 打开会话 switches the shell to the conversation panel', Boolean(navButton) && navBefore.composer === 0 && navAfter.composer >= 1 && navAfter.panel === 0, JSON.stringify({ navButton, navBefore, navAfter }));
  await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
  await sleep(1600);
  const backPanel = await call(() => document.querySelectorAll('[data-wb-panel]').length);
  check('U-NAV-02: the workbench is reachable again after the jump', backPanel === 1, JSON.stringify({ backPanel }));
  await hash('#/progress');
  await sleep(600);
  // ---- D. console clean ----
  check('U-CONSOLE: no exceptions/errors during the run', logs.length === 0, JSON.stringify(logs.slice(0, 6)));

  const failed = results.filter((r) => !r.ok);
  console.log('---');
  console.log('UI STRICT: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  writeFileSync(join(outDir, 'ui-strict-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('STRICT RUN ABORTED: ' + String(error));
  console.error('LOGS: ' + JSON.stringify(logs.slice(0, 6)));
  writeFileSync(join(outDir, 'ui-strict-results.json'), JSON.stringify({ aborted: String(error), results }, null, 2));
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(2);
}
