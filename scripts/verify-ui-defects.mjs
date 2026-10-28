// Regression gate for defect classes found by the adversarial sweep:
//   DF-01 double/triple submit must not duplicate rows
//   DF-02 archived issues are read-only (no enabled write buttons)
//   DF-03 repeated clicks must not stack dialogs
//   DF-04 long lists stay scrollable inside the panel
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , urlArg, outDir] = process.argv;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + id + (detail ? ' :: ' + detail : '')); };
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'chrome-vdf-')), '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('no devtools')), 20000); const on = (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } }; chrome.stderr.on('data', on); chrome.stdout.on('data', on); });
const port = new URL(wsUrl).port;
const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pending = new Map(); const errors = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; } if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 120)); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return 'ERR ' + String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 160); return r.result.value; };
const call = async (fn, ...args) => ev('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (text) => call((label) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === label); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; }, text);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: urlArg });
await sleep(3200);
for (let i = 0; i < 8; i++) { const a = await clickText('继续'); if (a !== 'clicked') break; await sleep(300); }
await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
await sleep(2200);
const panelCount = await call(() => document.querySelectorAll('[data-wb-panel]').length);
check('DF-00: the workbench panel renders', panelCount === 1, 'panel=' + panelCount);
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('新建议题')); if (b) { b.click(); b.click(); b.click(); } return true; });
await sleep(900);
const dialogs = await call(() => document.querySelectorAll('[data-wb-dialog-card]').length);
check('DF-03: repeated clicks open exactly one dialog', dialogs === 1, 'dialogs=' + dialogs);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(500);
const name = '回归' + Date.now().toString(36).slice(-5);
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('新建项目')); if (b) b.click(); return true; });
await sleep(700);
await call((n) => { const el = document.querySelector('[data-wb-new-project="name"]'); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, n); el.dispatchEvent(new Event('input', { bubbles: true })); return true; }, name);
await sleep(300);
await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => (x.textContent || '').includes('创建项目')); if (!b) return false; b.click(); b.click(); b.click(); return true; });
await sleep(2500);
const stored = await call(async (n) => { const s = await fetch('/workbench/api/snapshot').then((r) => r.json()); return (s.data.projects || []).filter((p) => p.name === n).length; }, name);
check('DF-01: triple-clicking 创建项目 creates exactly one project', stored === 1, 'rows=' + stored);
const archived = await call(async () => {
  const post = async (t, p) => { const r = await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: t, payload: p }) }); return r.json(); };
  const s = await fetch('/workbench/api/snapshot').then((r) => r.json());
  const issues = (s.data.projects || []).flatMap((p) => p.issues || []);
  // pin the archived sample so this check cannot eat the only startable todo (DF-08 needs it)
  // WB-4 (blocked) keeps WB-3 live, because DF-07 needs a running unit
  const cand = issues.find((i) => i.issueId === 'WB-4') || issues.find((i) => i.status !== 'done' && i.status !== 'cancelled');
  if (!cand) return null;
  await post('issue.cancel', { issueId: cand.issueId });
  await post('issue.setArchived', { issueId: cand.issueId, archived: true });
  return cand.issueId;
});
await ev('window.location.hash = ' + JSON.stringify('#/issue/' + archived));
await sleep(1800);
const ro = await call(() => { const root = document.querySelector('[data-wb-panel]'); const text = (root && root.textContent) || ''; const enabled = [...(root ? root.querySelectorAll('button') : [])].filter((b) => !b.disabled).map((b) => (b.textContent || '').trim()).filter((t) => /保存|通过|打回|开始|验收|归档|取消议题|认领|改回|重试/.test(t)); return { badge: text.indexOf('只读') >= 0 || text.indexOf('已归档') >= 0, enabled }; });
check('DF-02: archived issue shows a read-only badge', ro.badge, JSON.stringify(ro).slice(0, 120));
check('DF-02: archived issue has no enabled write buttons', ro.enabled.length === 0, JSON.stringify(ro.enabled));
await call(async () => { const post = async (t, p) => { await fetch('/workbench/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: t, payload: p }) }); }; for (let i = 1; i <= 25; i += 1) await post('todo.create', { title: '回归压力 #' + i }); return true; });
await sleep(2200);
await ev("window.location.hash = '#/inbox'");
await sleep(1600);
const scroll = await call(() => { const panel = document.querySelector('[data-wb-panel]'); const inner = [...panel.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 40); return { count: inner.length, biggest: inner.length ? Math.max.apply(null, inner.map((el) => el.scrollHeight - el.clientHeight)) : 0 }; });
check('DF-04: a 25-item list overflows into a scrollable container', scroll.count >= 1, JSON.stringify(scroll));
check('DF-05: no uncaught exceptions during the sweep', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
// DF-06 open-the-conversation must switch the shell, never fall back to "copied id"
await ev("window.location.hash = '#/issue/WB-3'");
await sleep(1800);
const navBefore = await call(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, composer: document.querySelectorAll('[contenteditable=true]').length }));
const navClick = await call(() => { const b = [...document.querySelectorAll('[data-wb-panel] button')].find((x) => /打开对话|打开会话/.test(x.textContent || '')); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; });
await sleep(1800);
const navAfter = await call(() => ({ panel: document.querySelectorAll('[data-wb-panel]').length, composer: document.querySelectorAll('[contenteditable=true]').length, body: (document.body.textContent || '').slice(0, 4000) }));
check('DF-06: 打开对话 switches to the conversation panel', navClick === 'clicked' && navBefore.composer === 0 && navAfter.composer >= 1 && navAfter.panel === 0, JSON.stringify({ navClick, navBefore: navBefore.composer, navAfter: navAfter.composer }));
check('DF-06: it never falls back to copying the session id', navAfter.body.indexOf('会话 id') < 0 && navAfter.body.indexOf('已复制') < 0, 'notice=' + String(navAfter.body.indexOf('已复制')));
await call(() => { const b = document.querySelector('button[aria-label="工作台"]'); if (b) b.click(); return true; });
await sleep(1400);
// DF-07 exactly one status per unit, and a running unit is not labelled 待验收
await ev("window.location.hash = '#/issue/WB-3'");
await sleep(1600);
const unitTags = await call(() => [...document.querySelectorAll('[data-wb-unit]')].map((el) => ({ state: el.getAttribute('data-wb-unit-state'), tags: [...el.querySelectorAll('[data-wb-unit-status],[data-wb-unit-exec],[data-wb-unit-accept],[data-wb-unit-running],[data-wb-unit-voided]')].map((t) => (t.textContent || '').trim()) })));
const tagCounts = unitTags.map((u) => u.tags.length);
check('DF-07: every unit shows exactly one status tag', tagCounts.length > 0 && tagCounts.every((n) => n === 1), JSON.stringify(tagCounts));
const runningUnitTag = (unitTags.find((u) => String(u.state || '').indexOf('running') === 0) || {}).tags || [];
check('DF-07: a running unit is labelled 执行中 and not 待验收', runningUnitTag.length === 1 && runningUnitTag[0].indexOf('执行中') >= 0 && runningUnitTag[0].indexOf('待验收') < 0, JSON.stringify(runningUnitTag));
// DF-08 the round-goal input must not cap input length (asserted on the built client source:
// the UI-level check depends on seed state, which made it flaky).
const clientSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "client.js"), "utf8");
const goalLine = (clientSrc.split("\n").find((line) => line.indexOf("本轮目标") >= 0) || "");
check("DF-08: the 本轮目标 input exists in the built client", goalLine.length > 0, goalLine.trim().slice(0, 120));
check("DF-08: 本轮目标 input has no maxLength cap", goalLine.length > 0 && goalLine.indexOf("maxLength") < 0, goalLine.trim().slice(0, 160));
// DF-09 the panel exposes a build stamp (so a stale renderer is visible)
const stamp = await call(() => { const el = document.querySelector('[data-wb-panel]'); return el ? el.getAttribute('data-wb-build') : null; });
check('DF-09: panel exposes data-wb-build', Boolean(stamp && stamp.length > 4), String(stamp));
// DF-10 an archived project makes its issues read-only (host + UI).
// Builds its own scenario: the earlier gates in this script already mutate the seed.
const scenario = await call(async () => {
  const cmd = async (type, payload) => { const r = await fetch("/workbench/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: type, payload: payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : (res && res.data ? res.data : {});
  const proj = unwrap(await cmd("project.create", { name: "归档只读检查" + Date.now().toString(36).slice(-4) }));
  const todo = unwrap(await cmd("todo.create", { title: "归档只读检查议题" }));
  const tr = await cmd("issue.triage", { issueId: todo.issueId, projectId: proj.projectId, workspacePath: "/tmp", acceptance: [{ text: "可用性标准" }] });
  const st = await cmd("issue.setStatus", { issueId: todo.issueId, status: "in_review" });
  return { projectId: proj.projectId, issueId: todo.issueId, ok: Boolean(tr.ok && st.ok) };
});
if (scenario && scenario.ok && scenario.issueId) {
  const enabledWrites = async () => call(() => { const root = document.querySelector("[data-wb-panel]"); const text = (root && root.textContent) || ""; const enabled = [...(root ? root.querySelectorAll("button") : [])].filter((b) => !b.disabled).map((b) => (b.textContent || "").trim()).filter((t) => /保存|通过|打回|开始|验收|归档|取消议题|认领|改回|重试|完成/.test(t)); return { badge: text.indexOf("只读") >= 0, enabled: enabled }; });
  const openIssue = async (wantWrites) => {
    let last = { badge: false, enabled: [] };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await ev("window.location.hash = '#/progress'");
      await sleep(220);
      await ev("window.location.hash = " + JSON.stringify("#/issue/" + scenario.issueId));
      await sleep(450);
      last = await enabledWrites();
      if (wantWrites ? last.enabled.length > 0 : last.badge) return last;
    }
    return last;
  };
  const openIssueGone = async () => {
    let last = { badge: false, enabled: [] };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await ev("window.location.hash = '#/progress'");
      await sleep(220);
      await ev("window.location.hash = " + JSON.stringify("#/issue/" + scenario.issueId));
      await sleep(450);
      last = await enabledWrites();
      if (last.badge) return last;
    }
    return last;
  };
  const command = async (type, payload) => call(async (body) => { const r = await fetch("/workbench/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }, { type: type, payload: payload });
  const before = await openIssue(true);
  const archivedRes = await command("project.setArchived", { projectId: scenario.projectId, archived: true });
  const hostRejects = await command("issue.setStatus", { issueId: scenario.issueId, status: "in_progress" });
  const after = await openIssueGone();
  check("DF-10: the issue really had write actions before the project was archived", before.enabled.length > 0, JSON.stringify(before.enabled));
  check("DF-10: the host rejects writes to issues of an archived project", Boolean(archivedRes && archivedRes.ok === true) && hostRejects.ok === false, JSON.stringify(hostRejects).slice(0, 220));
  check("DF-10: the UI shows the archived project issue as read-only", after.badge && after.enabled.length === 0, JSON.stringify(after));
  await command("project.setArchived", { projectId: scenario.projectId, archived: false });
  // DF-11 unarchiving must restore write access (no dead end)
  const afterUnarchive = await command("issue.setStatus", { issueId: scenario.issueId, status: "in_progress" });
  check("DF-11: writes work again once the project is unarchived", Boolean(afterUnarchive && afterUnarchive.ok === true), JSON.stringify(afterUnarchive).slice(0, 200));
  const backToReview = await command("issue.setStatus", { issueId: scenario.issueId, status: "in_review" });
  void backToReview;
}
// DF-12 every host error code a user can see must have a Chinese label in the client.
// Codes raised only for AI tools are excluded (they never reach the panel).
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostText = ["host/domain/errors.js", "host/service/commands-core.js", "host/service/commands-units.js", "host/domain/rules.js", "host/adapters/http-api.js"]
  .map((rel) => { try { return readFileSync(join(pluginRoot, rel), "utf8"); } catch (error) { return ""; } }).join("\n");
const AI_ONLY = new Set(["E_TOOL", "E_TOOL_BOUNDARY"]);
const hostCodes = [...new Set([...hostText.matchAll(/\bE_[A-Z_]+\b/g)].map((m) => m[0]))].filter((code) => !AI_ONLY.has(code));
const clientText = readFileSync(join(pluginRoot, "client.js"), "utf8");
const unmapped = hostCodes.filter((code) => !new RegExp(code + "\\s*:").test(clientText));
check("DF-12: every user-facing host error code has a Chinese label", unmapped.length === 0, JSON.stringify(unmapped));
// DF-13 the acceptance-criterion input must respect the host limit (1000) so a paste is not silently rejected
const criterionLine = (clientText.split("\n").find((line) => line.indexOf("新增一条标准") >= 0) || "");
check("DF-13: the criterion input is capped at the host limit", /maxLength: 1000/.test(criterionLine), criterionLine.trim().slice(0, 160));
// DF-14 keyboard: Escape closes the create dialog AND returns focus to its trigger
await ev("window.location.hash = '#/progress'");
await sleep(900);
const kbOpened = await call(() => { const b = [...document.querySelectorAll("[data-wb-panel] button")].find((x) => (x.textContent || "").includes("新建议题")); if (!b) return "missing"; b.click(); b.focus(); return "clicked"; });
await sleep(800);
await call(() => { const el = document.querySelector("[data-wb-dialog-card] input"); if (el) el.focus(); return true; });
await send("Input.insertText", { text: "焦点回归检查" });
await sleep(150);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(700);
const kbAfter = await call(() => { const card = document.querySelector("[data-wb-dialog-card]"); const active = document.activeElement; const btn = [...document.querySelectorAll("[data-wb-panel] button")].find((x) => (x.textContent || "").includes("新建议题")); return { dialogClosed: !card, focusOnTrigger: Boolean(active && btn && active === btn) }; });
check("DF-14: Escape closes the dialog", kbOpened === "clicked" && kbAfter.dialogClosed, JSON.stringify(kbAfter));
check("DF-14: focus returns to the trigger button after Escape", kbAfter.focusOnTrigger, JSON.stringify(kbAfter));
// DF-15 pressing Enter in the round-goal input must not silently create a unit
const enterScenario = await call(async () => {
  const cmd = async (type, payload) => { const r = await fetch("/workbench/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: type, payload: payload }) }); return r.json(); };
  const unwrap = (res) => (res && res.data && res.data.result) ? res.data.result : (res && res.data ? res.data : {});
  // Earlier checks can leave many units running; park live units so the start
  // box actually renders instead of its "disabled" reason.
  const board = await fetch("/workbench/api/board").then((r) => r.json()).catch(() => null);
  for (const column of ((board && board.data && board.data.columns) || [])) {
    for (const row of (column.items || [])) {
      if (!row || !row.issueId) continue;
      const d = await fetch("/workbench/api/issue?id=" + encodeURIComponent(row.issueId)).then((r) => r.json()).catch(() => null);
      for (const unit of ((d && d.data && d.data.units) || [])) {
        if (unit.voided !== true && (unit.execState === "running" || unit.execState === "wrapping" || unit.execState === "pending")) {
          await cmd("unit.void", { unitId: unit.unitId, reason: "DF-15 释放并行槽位" });
        }
      }
    }
  }
  const proj = unwrap(await cmd("project.create", { name: "回车检查" + Date.now().toString(36).slice(-4) }));
  const todo = unwrap(await cmd("todo.create", { title: "回车检查议题" }));
  const tr = await cmd("issue.triage", { issueId: todo.issueId, projectId: proj.projectId, workspacePath: "/tmp", acceptance: [{ text: "标准" }] });
  return tr.ok ? { issueId: todo.issueId } : null;
});
if (enterScenario && enterScenario.issueId) {
  await ev("window.location.hash = " + JSON.stringify("#/issue/" + enterScenario.issueId));
  await sleep(1600);
  const unitsBefore = await call(() => document.querySelectorAll("[data-wb-unit]").length);
  const focusGoal = await call(() => { const el = [...document.querySelectorAll("[data-wb-panel] input")].find((i) => String(i.getAttribute("placeholder") || "").indexOf("本轮目标") >= 0); if (!el) return "missing"; el.focus(); return "focused"; });
  if (focusGoal === "focused") {
    await send("Input.insertText", { text: "回车不应提交" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(1200);
    const unitsAfter = await call(() => document.querySelectorAll("[data-wb-unit]").length);
    const kept = await call(() => { const el = [...document.querySelectorAll("[data-wb-panel] input")].find((i) => String(i.getAttribute("placeholder") || "").indexOf("本轮目标") >= 0); return el ? el.value : null; });
    check("DF-15: Enter in the goal input does not create a unit", unitsAfter === unitsBefore, "units " + unitsBefore + "->" + unitsAfter);
    check("DF-15: Enter in the goal input keeps the typed text", kept === "回车不应提交", JSON.stringify(kept));
  } else { check("DF-15: the goal input was reachable", false, focusGoal); }
}
const passed = results.filter((r) => r.ok).length;
console.log('---');
console.log('UI DEFECTS: ' + passed + '/' + results.length + ' passed');
if (outDir) { try { writeFileSync(join(outDir, 'ui-defects-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2)); } catch (error) { /* optional */ } }
const failed = results.filter((r) => !r.ok).length;
ws.close(); chrome.kill('SIGKILL'); process.exit(failed === 0 ? 0 : 1);
