#!/bin/sh
# Phase-3 acceptance: run the KICKOFF §8 eight steps against a real DSH web host.
#
# Boots the host through tests/tools/dsh-host.mjs (no duplicated startup logic),
# seeds the document with tests/fixtures/expected.mjs loadSeed, then drives the
# real HTTP command surface. Assertions are numbered P3-01.. and print
# "PASS/FAIL <id> <what>"; the last line is "P3 passed/total".
#
# Usage: workbench-plugin/scripts/verify-phase3.sh
# Exit 0 only when every mechanical assertion passes (MANUAL items are listed
# separately and never affect the exit code).
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
cd "$ROOT/workbench-plugin" || exit 1

exec node --input-type=module <<'NODE'
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startHost } from './tests/tools/dsh-host.mjs';
import { loadSeed, computeExpected, SEED_PATH, FIXTURE_WS_A } from './tests/fixtures/expected.mjs';

const results = [];
function check(id, rawOk, label, detail) {
  const ok = rawOk === true;   // never trust a truthy return value (strings count as pass for printing)
  results.push({ id, ok, label });
  const suffix = ok || !detail ? '' : ' :: ' + detail;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + label + suffix);
}
function manual(id, label, why) {
  results.push({ id, ok: null, label });
  console.log('MANUAL ' + id + ' ' + label + ' :: ' + why);
}
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing');

let host = await startHost({ profile: 'p3', seams: true, keepHome: true, prepareData: (home) => { loadSeed(home); } });

/** POST a command; returns { status, body, data } where data is the command result. */
async function post(type, payload = {}) {
  const response = await host.command(type, payload);
  const body = response.body || {};
  const inner = body.data;
  return { status: response.status, body, data: inner && inner.result !== undefined ? inner.result : inner };
}
const getJson = async (path) => {
  const response = await host.get(path);
  return { status: response.status, body: response.body, data: response.body && response.body.data };
};
const issueDetail = async (issueId) => {
  const response = await getJson('/workbench/api/issue?id=' + encodeURIComponent(issueId));
  return response.data || {};
};
const expected = computeExpected(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
const doc = () => JSON.parse(readFileSync(host.dataFile, 'utf8'));
const issueRow = (issueId) => (doc().issues || []).find((issue) => issue.issueId === issueId);
const unitsOf = (issueId) => (doc().units || []).filter((unit) => unit.issueId === issueId);
const errCode = (response) => (response && response.body && response.body.error && response.body.error.code) || ('HTTP_' + (response && response.status));
const nowMs = () => Date.now();
const ws = FIXTURE_WS_A;

// ---------------------------------------------------------------- step 1: cold boot
{
  const snapshot = await getJson('/workbench/api/snapshot');
  check('P3-01', snapshot.status === 200 && existsSync(host.dataFile) && doc().schemaVersion === 2,
    '冷启动：host 起来并加载工作台文档（schemaVersion=2）', 'status=' + snapshot.status);
  check('P3-02', snapshot.body.ok === true && snapshot.body.apiVersion === 1,
    '首屏数据源：GET /snapshot 返回统一信封 ok/apiVersion');
  const counters = (snapshot.data && snapshot.data.counters) || {};
  const counterKeys = ['running', 'pendingReviewUnits', 'pendingTerminalReviews', 'pendingDecisions', 'todoCount', 'unassignedSessions'];
  const counterDiff = counterKeys.filter((key) => counters[key] !== expected.counters[key]);
  check('P3-03', counterDiff.length === 0, '收件箱/在跑计数与夹具期望一致（FR-03/FR-40 口径）', '差异字段 ' + counterDiff.join(','));
  const progress = ((snapshot.data && snapshot.data.projects) || []).map((project) => ({ projectId: project.projectId, progress: project.progress }));
  check('P3-04', JSON.stringify(progress) === JSON.stringify(expected.projects.map((project) => ({ projectId: project.projectId, progress: project.progress }))),
    '项目进度 x/y 与夹具期望一致（FR-03/FR-61）', JSON.stringify(progress));
  const board = await getJson('/workbench/api/board');
  const columns = {};
  for (const column of (board.data && board.data.columns) || []) columns[column.status] = column.items.length;
  check('P3-05', JSON.stringify(columns) === JSON.stringify(expected.board),
    '看板只有 4 个活跃列且计数正确（FR-60）', JSON.stringify(columns));
  const routes = {};
  for (const path of ['/workbench/api/issue?id=WB-3', '/workbench/api/inbox', '/workbench/api/board', '/workbench/api/search?q=workbench', '/workbench/api/activity?issueId=WB-3']) {
    const response = await getJson(path);
    routes[path] = response.status;
  }
  check('P3-06', Object.values(routes).every((status) => status === 200), '读接口全部挂载且 200（FR-62 深链数据源）', JSON.stringify(routes));
  const search = await getJson('/workbench/api/search?q=workbench');
  const groups = search.data || {};
  check('P3-07', Array.isArray(groups.issues) && Array.isArray(groups.todos) && Array.isArray(groups.projects),
    '搜索返回议题/TODO/项目三组（FR-62）', JSON.stringify(Object.keys(groups)));
}

// ------------------------------------------------- step 2: project -> TODO -> triage -> claim -> end
let mainIssue = null;
let mainUnit = null;
{
  const project = await post('project.create', { name: 'P3 验收项目', defaultWorkspacePath: ws });
  check('P3-08', project.status === 200 && Boolean(project.data && project.data.projectId),
    '建项目并可指定默认目录（FR-01/FR-04）', 'status=' + project.status);
  const projectId = project.data.projectId;
  const renamed = await post('project.rename', { projectId, name: 'P3 验收项目（改名）' });
  check('P3-09', renamed.status === 200 && doc().projects.find((entry) => entry.projectId === projectId).defaultWorkspacePath === ws,
    '项目改名不影响默认目录（FR-04）');
  const unbound = await post('project.setDefaultWorkspace', { projectId, defaultWorkspacePath: null });
  const rebound = await post('project.setDefaultWorkspace', { projectId, defaultWorkspacePath: ws });
  check('P3-10', unbound.status === 200 && rebound.status === 200 && doc().projects.find((entry) => entry.projectId === projectId).defaultWorkspacePath === ws,
    '默认目录可解绑/重绑（FR-02 应验）');

  const todo = await post('todo.create', { title: 'P3 主链路议题：把八步跑通' });
  mainIssue = todo.data.issueId;
  const duplicate = await post('todo.create', { title: 'P3 主链路议题：把八步跑通' });
  check('P3-11', todo.status === 200 && issueRow(mainIssue).isTriaged === false && Array.isArray(duplicate.data.duplicateHints) && duplicate.data.duplicateHints.length > 0,
    '只填标题即可记 TODO，重复只提示不阻止（FR-10/FR-13）');

  const suggestion = await post('issue.suggestTriage', { issueId: mainIssue, reason: '这条该立项了' });
  const suggested = (issueRow(mainIssue).activities || []).some((activity) => activity.type === 'suggestion.created');
  check('P3-12', suggestion.status === 200 && suggested && issueRow(mainIssue).isTriaged === false,
    'AI 只能建议立项，不改立项状态（FR-12 应验）');

  const noProject = await post('issue.triage', { issueId: mainIssue, acceptance: [{ text: 'x' }] });
  const noCriteria = await post('issue.triage', { issueId: mainIssue, projectId, acceptance: [] });
  check('P3-13', errCode(noProject) === 'E_BAD_REQUEST' && errCode(noCriteria) === 'E_ACCEPTANCE',
    '立项强校验：缺项目 400 / 缺验收标准 422（FR-11/FR-21）',
    'noProject=' + errCode(noProject) + ' noCriteria=' + errCode(noCriteria));

  const triage = await post('issue.triage', { issueId: mainIssue, projectId, workspacePath: ws, acceptance: [{ text: '标准 A' }, { text: '标准 B' }] });
  check('P3-14', triage.status === 200 && issueRow(mainIssue).isTriaged === true && issueRow(mainIssue).status === 'todo' && issueRow(mainIssue).acceptanceCriteria.length === 2,
    '立项成功：isTriaged、状态 todo、标准落库（FR-11/FR-21）');

  // The acceptance-criteria guards live on their own issue, so the main issue keeps
  // one unmet criterion for the FR-25 gate later on.
  const guardTodo = await post('todo.create', { title: 'P3 验收标准守卫议题' });
  const guardIssue = guardTodo.data.issueId;
  await post('issue.triage', { issueId: guardIssue, projectId, workspacePath: ws, acceptance: [{ text: 'g1' }, { text: 'g2' }] });
  const added = await post('acceptance.add', { issueId: guardIssue, text: 'g3' });
  const firstGuard = issueRow(guardIssue).acceptanceCriteria[0].id;
  const ticked = await post('acceptance.update', { issueId: guardIssue, acceptanceId: firstGuard, done: true });
  const statusAfterTick = issueRow(guardIssue).status;
  while (issueRow(guardIssue).acceptanceCriteria.length > 1) {
    const criteria = issueRow(guardIssue).acceptanceCriteria;
    await post('acceptance.remove', { issueId: guardIssue, acceptanceId: criteria[criteria.length - 1].id });
  }
  const removeLast = await post('acceptance.remove', { issueId: guardIssue, acceptanceId: issueRow(guardIssue).acceptanceCriteria[0].id });
  check('P3-15', added.status === 200 && ticked.status === 200 && statusAfterTick === 'todo' && errCode(removeLast) === 'E_ACCEPTANCE',
    '验收标准：可加可勾、勾选不改状态、删到最后一条被拒（FR-21）',
    'removeLast=' + errCode(removeLast) + ' statusAfterTick=' + statusAfterTick);

  const claimed = await post('unit.claim', { issueId: mainIssue, sessionId: 'session-p3-main', cwd: ws });
  mainUnit = claimed.data.unitId;
  check('P3-16', claimed.status === 200 && issueRow(mainIssue).status === 'in_progress' && unitsOf(mainIssue)[0].execState === 'running',
    '认领会话成为单元并推进到处理中（FR-30/FR-37）');

  const ended = await post('test.sessionEvent', { sessionId: 'session-p3-main', kind: 'turn/end', reason: { kind: 'completed' } });
  // unit/round model: a round does not end the unit; Wrap-up does.
  const unitPre = unitsOf(mainIssue)[0];
  await post('unit.wrapup', { unitId: unitPre.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
  const unitAfter = unitsOf(mainIssue)[0];
  check('P3-17', ended.status === 200 && unitAfter.execState === 'ended' && unitAfter.acceptState === 'pending' && issueRow(mainIssue).status === 'in_review',
    '会话正常结束 → 单元已结束待验收、议题变等你确认（FR-31/FR-32 时机 2）');

  const inbox = await getJson('/workbench/api/inbox');
  const inReview = ((inbox.data && inbox.data.reviewUnits) || []).some((unit) => unit.unitId === mainUnit);
  check('P3-18', inReview, '收件箱待验收分区出现该单元（FR-40）');

  const handover = { change: '改了 host/service', verify: 'node --test 全绿', result: '通过', risk: '无' };
  const wrote = await post('unit.writeHandoff', { unitId: mainUnit, handover, source: 'human' });
  const detail = await issueDetail(mainIssue);
  const detailUnit = (detail.units || []).find((unit) => unit.unitId === mainUnit) || {};
  const readBack = detailUnit.handover || {};
  check('P3-19', wrote.status === 200 && ['change', 'verify', 'result', 'risk'].every((key) => Boolean(readBack[key])),
    '交接四段可写可读（读交接）（FR-33）',
    'write=' + wrote.status + ' keys=' + JSON.stringify(Object.keys(readBack)));

  // tick one of the two criteria -> one stays unmet, which the FR-25 gate must demand
  const remaining = issueRow(mainIssue).acceptanceCriteria;
  if (remaining.length >= 2) await post('acceptance.update', { issueId: mainIssue, acceptanceId: remaining[0].id, done: true });

  const accepted = await post('unit.accept', { unitId: mainUnit });
  const detailAfter = await issueDetail(mainIssue);
  check('P3-20', accepted.status === 200 && unitsOf(mainIssue)[0].acceptState === 'passed' && issueRow(mainIssue).status === 'in_review',
    '通过单元只写单元、议题仍是等你确认（FR-34）');

  const unmetGate = await post('issue.finalAccept', { issueId: mainIssue });
  check('P3-21', errCode(unmetGate) === 'E_STATE',
    '终验收闸门：未满足项未确认时拒绝（FR-25）', 'code=' + errCode(unmetGate));

  const finalOk = await post('issue.finalAccept', { issueId: mainIssue, acknowledgeUnmet: true });
  const trace = (issueRow(mainIssue).activities || []).some((activity) => /未满足项/.test(String(activity.text)));
  check('P3-22', finalOk.status === 200 && issueRow(mainIssue).status === 'done' && trace,
    '终验收：带未满足项完成并留痕（FR-25）');

  const archived = await post('issue.setArchived', { issueId: mainIssue, archived: true });
  const editArchived = await post('issue.update', { issueId: mainIssue, title: '不该写入' });
  check('P3-23', archived.status === 200 && issueRow(mainIssue).archivedAt && errCode(editArchived) === 'E_CONFLICT',
    '归档后只读、暂停写入（FR-24/N7）', 'edit=' + errCode(editArchived));
  void detail; void detailAfter; void detailUnit;
}

// ------------------------------------------------------- step 3: issue edit + undo + pin + cancel
{
  const project = await post('project.create', { name: 'P3 状态项目' });
  const projectId = project.data.projectId;
  const makeIssue = async (title, criteria = ['c1']) => {
    const todo = await post('todo.create', { title });
    const issueId = todo.data.issueId;
    await post('issue.triage', { issueId, projectId, workspacePath: ws, acceptance: criteria.map((text) => ({ text })) });
    return issueId;
  };

  const edited = await makeIssue('P3 编辑议题');
  const before = (issueRow(edited).activities || []).length;
  const update = await post('issue.update', { issueId: edited, title: 'P3 编辑议题（改过）' });
  const after = (issueRow(edited).activities || []).length;
  check('P3-24', update.status === 200 && after > before, '议题可就地编辑并记一条活动（FR-20）');

  // undo: an automatic change is undoable; past 24h it is not.
  const undoIssue = await makeIssue('P3 撤销议题');
  await post('unit.claim', { issueId: undoIssue, sessionId: 'session-p3-undo', cwd: ws });
  const autoStatus = issueRow(undoIssue).status;
  const undone = await post('issue.undoAutoStatus', { issueId: undoIssue });
  const undoWorks = undone.status === 200 && issueRow(undoIssue).status === 'todo';
  check('P3-25', autoStatus === 'in_progress' && undoWorks, '撤销最近一次自动变更回到原状态（FR-22）', 'auto=' + autoStatus);

  const staleIssue = await makeIssue('P3 撤销过期议题');
  await post('unit.claim', { issueId: staleIssue, sessionId: 'session-p3-stale', cwd: ws });
  const baseMs = nowMs();
  await post('test.setClock', { nowMs: baseMs });
  await post('test.advanceClock', { ms: 25 * 60 * 60 * 1000 });
  const staleUndo = await post('issue.undoAutoStatus', { issueId: staleIssue });
  check('P3-26', errCode(staleUndo) === 'E_STATE', '撤销 24h 窗口过期后拒绝（FR-22）', 'code=' + errCode(staleUndo));

  // pin: a manual status write blocks the next automatic write until the next round
  const pinIssue = await makeIssue('P3 钉住议题');
  await post('unit.claim', { issueId: pinIssue, sessionId: 'session-p3-pin', cwd: ws });
  await post('issue.setStatus', { issueId: pinIssue, status: 'blocked' });
  await post('test.sessionEvent', { sessionId: 'session-p3-pin', kind: 'turn/end', reason: { kind: 'completed' } });
  const pinnedStatus = issueRow(pinIssue).status;
  check('P3-27', pinnedStatus === 'blocked', '钉住期内自动写被拒：状态仍是 blocked（FR-22）', 'status=' + pinnedStatus);
  // unit/round model: a live unit must wrap up (four-part handover) before review.
  const pinUnit = unitsOf(pinIssue).find((u) => u.voided !== true && u.execState === 'running') || unitsOf(pinIssue)[0];
  if (pinUnit) {
    await post('unit.wrapup', { unitId: pinUnit.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
    await post('unit.accept', { unitId: pinUnit.unitId });
  }
  await post('test.advanceClock', { ms: 1000 });   // guarantee the next unit is created strictly after the pin
  await post('unit.claim', { issueId: pinIssue, sessionId: 'session-p3-pin-2', cwd: ws });
  await post('test.sessionEvent', { sessionId: 'session-p3-pin-2', kind: 'turn/end', reason: { kind: 'completed' } });
  const pinUnit2 = unitsOf(pinIssue).find((u) => u.voided !== true && u.execState === 'running') || unitsOf(pinIssue)[0] || {};
  await post('unit.wrapup', { unitId: pinUnit2.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
  check('P3-28', issueRow(pinIssue).status === 'in_review', '开下一轮后钉住过期、自动推进恢复（FR-22）', 'status=' + issueRow(pinIssue).status);

  // cancel: stops the in-flight unit and never auto-writes afterwards
  const cancelIssue = await makeIssue('P3 取消议题');
  await post('unit.claim', { issueId: cancelIssue, sessionId: 'session-p3-cancel', cwd: ws });
  const cancelled = await post('issue.cancel', { issueId: cancelIssue });
  const cancelUnit = unitsOf(cancelIssue)[0] || {};
  await post('test.sessionEvent', { sessionId: 'session-p3-cancel', kind: 'turn/end', reason: { kind: 'completed' } });
  check('P3-29', cancelled.status === 200 && cancelUnit.voided === true && cancelUnit.closeReason === 'cancelled'
    && cancelUnit.exitReason === 'cancelled_by_user' && issueRow(cancelIssue).status === 'cancelled',
    '取消议题：停飞单元 + cancelled_by_user + 之后不再自动改写（FR-23/N5/N6）');
}

// --------------------------------------------------------------- step 4: reject then a new round
{
  const project = await post('project.create', { name: 'P3 打回项目' });
  const projectId = project.data.projectId;
  const todo = await post('todo.create', { title: 'P3 打回议题' });
  const issueId = todo.data.issueId;
  await post('issue.triage', { issueId, projectId, workspacePath: ws, acceptance: [{ text: '要达标' }] });
  const claim = await post('unit.claim', { issueId, sessionId: 'session-p3-reject', cwd: ws, sessionEnded: true });
  const unitId = claim.data.unitId;
  const unitsBefore = unitsOf(issueId).length;
  const rejected = await post('unit.reject', { unitId, reason: '本轮不达标' });
  const unitsAfter = unitsOf(issueId).length;
  check('P3-30', rejected.status === 200 && unitsAfter === unitsBefore && issueRow(issueId).status === 'in_progress'
    && unitsOf(issueId)[0].voided !== true && unitsOf(issueId)[0].execState === 'running',
    '打回：不新建单元、同一单元回到执行中、议题回处理中（D-19/FR-34）',
    'units ' + unitsBefore + '->' + unitsAfter + ' status=' + issueRow(issueId).status);

  // unit/round model (D-19): a rejection resumes the SAME unit, so a second claim
  // must be refused by R1 and the next round happens inside the live unit.
  await post('test.advanceClock', { ms: 1000 });
  const claim2 = await post('unit.claim', { issueId, sessionId: 'session-p3-round2', cwd: ws, sessionEnded: true });
  await post('test.sessionEvent', { sessionId: 'session-p3-reject', kind: 'turn/start' });
  await post('test.sessionEvent', { sessionId: 'session-p3-reject', kind: 'turn/end', reason: { kind: 'completed' } });
  const liveUnit = unitsOf(issueId).find((unit) => unit.voided !== true && unit.execState === 'running') || {};
  const turnCount = liveUnit.turnCount || 0;
  if (liveUnit.unitId) await post('unit.wrapup', { unitId: liveUnit.unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
  const accept2 = liveUnit.unitId ? await post('unit.accept', { unitId: liveUnit.unitId }) : { status: 0 };
  check('P3-31', claim2.status === 409 && accept2.status === 200 && issueRow(issueId).status === 'in_review',
    '打回后在同一单元内再跑一轮并再次通过（D-19/FR-37）',
    'claim2=' + claim2.status + ' turns=' + turnCount + ' accept=' + accept2.status + ' status=' + issueRow(issueId).status);

  const detail = await issueDetail(issueId);
  const issueSummary = detail.issue || {};
  check('P3-32', issueSummary.terminalReview === true && issueSummary.pendingReview === false,
    '全部单元通过后派生 terminalReview（FR-25 闸门条件）', JSON.stringify({ terminalReview: issueSummary.terminalReview, pendingReview: issueSummary.pendingReview }));
}

// ------------------------------------------------------------------- step 5: abnormal end
{
  const project = await post('project.create', { name: 'P3 异常项目' });
  const projectId = project.data.projectId;
  const todo = await post('todo.create', { title: 'P3 异常议题' });
  const issueId = todo.data.issueId;
  await post('issue.triage', { issueId, projectId, workspacePath: ws, acceptance: [{ text: '异常标准' }] });
  const claim = await post('unit.claim', { issueId, sessionId: 'session-p3-abnormal', cwd: ws });
  const unitId = claim.data.unitId;
  await post('test.sessionEvent', { sessionId: 'session-p3-abnormal', kind: 'turn/end', reason: { kind: 'error' } });
  const abnormalUnit = unitsOf(issueId)[0];
  check('P3-33', abnormalUnit.execState === 'failed' && abnormalUnit.exitReason === 'error' && issueRow(issueId).status === 'blocked',
    '异常结束 → 单元 failed、议题遇到阻碍（N3/FR-35，非「待认领」）',
    'exec=' + abnormalUnit.execState + ' status=' + issueRow(issueId).status);

  const inbox = await getJson('/workbench/api/inbox');
  const decisions = (inbox.data && inbox.data.decisions) || [];
  const abnormalItems = decisions.filter((item) => item.kind === 'unit_abnormal' && item.subjectRef === unitId);
  check('P3-34', abnormalItems.length === 1, '收件箱等你拍板出现 unit_abnormal（FR-40/FR-35）', 'count=' + abnormalItems.length);

  const cannotAccept = await post('unit.accept', { unitId });
  check('P3-35', cannotAccept.status >= 400, '异常单元没有「判通过」的路径（concepts §5.4）', 'status=' + cannotAccept.status + ' code=' + (errCode(cannotAccept)));

  const back = await post('decision.backToTodo', { unitId, reason: '先不做这轮' });
  const inboxAfter = await getJson('/workbench/api/inbox');
  const stillThere = ((inboxAfter.data && inboxAfter.data.decisions) || []).some((item) => item.kind === 'unit_abnormal' && item.subjectRef === unitId);
  check('P3-36', back.status === 200 && issueRow(issueId).status === 'todo' && !stillThere,
    '改回待认领：作废异常单元、条目关闭（FR-35/W3）');
}

// ------------------------------------------- step 6: AI tools, badge, R1 / C2 / R4, unassigned
{
  const diagnostics = await post('test.diagnostics', {});
  const toolNames = (diagnostics.data && diagnostics.data.toolNames) || [];
  const expectedTools = ['workbench_create_todo', 'workbench_suggest_triage', 'workbench_claim_unit', 'workbench_create_unit',
    'workbench_write_handoff', 'workbench_suggest_wrapup', 'workbench_push_status', 'workbench_request_decision', 'workbench_comment'];
  check('P3-37', diagnostics.status === 200 && diagnostics.data.toolsRegistered === true
    && expectedTools.every((name) => toolNames.includes(name)) && toolNames.length === expectedTools.length,
    'AI 工具集：9 个工具已注册（含 AI 建议收尾，FR-50/FR-51）', 'tools=' + JSON.stringify(toolNames));
  const forbidden = ['workbench_set_done', 'workbench_approve', 'workbench_reject', 'workbench_final_accept', 'workbench_delete'];
  check('P3-38', forbidden.every((name) => !toolNames.includes(name)),
    '越权动作在工具层不存在（无完成/验收/删除）（FR-50）');

  const runningUnit = (await issueDetail('WB-3')).units.find((unit) => unit.execState === 'running');
  const badge = runningUnit || {};
  const execValues = ['pending', 'running', 'ended', 'failed'];
  const allExecValid = ((await issueDetail('WB-3')).units || []).every((unit) => execValues.includes(unit.execState));
  check('P3-39', badge.running === true && allExecValid && !JSON.stringify(badge).includes('queued'),
    '运行徽标：running 且无「排队中」状态（FR-42 应验）', JSON.stringify({ running: badge.running }));

  const r1 = await post('unit.claim', { issueId: 'WB-3', sessionId: 'session-p3-r1', cwd: ws });
  check('P3-40', errCode(r1) === 'E_CONFLICT', 'R1：同议题第二个活跃单元被拒（FR-31/FR-30）', 'code=' + errCode(r1));

  const c2 = await post('unit.claim', { issueId: 'WB-5', sessionId: 'session-p3-c2', cwd: '/tmp' });
  check('P3-41', errCode(c2) === 'E_CONFLICT', 'C2：会话目录与议题工作区不一致被拒（FR-30）', 'code=' + errCode(c2));

  // The global cap is retired: many units may run at once, and starting must stay open.
  const r4Project = (await post('project.create', { name: 'P3 R4 项目' })).data.projectId;
  const r4Issues = [];
  for (let index = 0; index < 4; index += 1) {
    const todo = await post('todo.create', { title: 'P3 R4 议题 ' + index });
    await post('issue.triage', { issueId: todo.data.issueId, projectId: r4Project, workspacePath: ws, acceptance: [{ text: 'c' }] });
    r4Issues.push(todo.data.issueId);
  }
  const claims = [];
  for (let index = 0; index < 4; index += 1) {
    claims.push(await post('unit.claim', { issueId: r4Issues[index], sessionId: 'session-p3-r4-' + index, cwd: ws }));
  }
  const runningAfter = (await getJson('/workbench/api/snapshot')).data.counters.running;
  check('P3-42', claims.every((claim) => claim.status === 200) && runningAfter >= 4,
    '不再限制并发的执行数量：n>3 仍允许（R4 已取消）', 'running=' + runningAfter);
  // The thing the human actually complained about: with 4+ running, a fresh issue
  // must still offer 开始这一轮 (no '在跑 N/3' disabled reason).
  const freshProject = (await post('project.create', { name: 'P3 并发不限项目' })).data.projectId;
  const freshTodo = await post('todo.create', { title: 'P3 并发不限议题' });
  await post('issue.triage', { issueId: freshTodo.data.issueId, projectId: freshProject, workspacePath: ws, acceptance: [{ text: 'c' }] });
  const freshDetail = (await getJson('/workbench/api/issue?id=' + encodeURIComponent(freshTodo.data.issueId))).data;
  const startBox = freshDetail.start || {};
  check('P3-43', startBox.available === true && (startBox.reasons || []).every((reason) => String(reason).indexOf('在跑') < 0),
    '在跑 4 个时仍可开始新一轮（不再有 R4 禁用原因）', JSON.stringify({ available: startBox.available, reasons: startBox.reasons }));
  await post('issue.cancel', { issueId: freshTodo.data.issueId });
  for (const issueId of r4Issues) await post('issue.cancel', { issueId });

  const unassigned = (await getJson('/workbench/api/snapshot')).data.counters.unassignedSessions;
  check('P3-43', unassigned === 0,
    '未归属会话口径：纯文档无会话事实时为 0，真机会话提醒由 CDP/人工验（FR-41）', 'unassigned=' + unassigned);
}

// -------------------------------------------------- step 7: restart keeps data and state
{
  const snapshotBefore = (await getJson('/workbench/api/snapshot')).data;
  const statusMap = () => {
    const map = {};
    for (const issue of doc().issues) map[issue.issueId] = { status: issue.status, archived: Boolean(issue.archivedAt), isTriaged: issue.isTriaged };
    return map;
  };
  const unitMap = () => {
    const map = {};
    for (const unit of doc().units) map[unit.unitId] = { execState: unit.execState, acceptState: unit.acceptState, voided: unit.voided };
    return map;
  };
  const issuesBefore = statusMap();
  const unitsBefore = unitMap();
  const countersBefore = snapshotBefore.counters;
  const progressBefore = snapshotBefore.projects.map((project) => ({ projectId: project.projectId, progress: project.progress }));

  await host.stop();                                   // keepHome: the fixture is the same DSH_HOME
  host = await startHost({ homeDir: host.homeDir, profile: 'p3', seams: true });   // same DSH_HOME; cleaned up by the final stop()

  const snapshotAfter = (await getJson('/workbench/api/snapshot')).data;
  check('P3-44', JSON.stringify(snapshotAfter.counters) === JSON.stringify(countersBefore),
    '重启后计数不变（数据完好、状态一致）',
    JSON.stringify({ before: countersBefore, after: snapshotAfter.counters }));
  check('P3-45', JSON.stringify(snapshotAfter.projects.map((project) => ({ projectId: project.projectId, progress: project.progress }))) === JSON.stringify(progressBefore),
    '重启后项目进度不变');
  check('P3-46', JSON.stringify(statusMap()) === JSON.stringify(issuesBefore), '重启后议题状态/归档标记不变');
  check('P3-47', JSON.stringify(unitMap()) === JSON.stringify(unitsBefore), '重启后单元三字段不变');
  const schema = doc();
  check('P3-48', schema.schemaVersion === 2 && typeof schema.meta.rev === 'number',
    '重启后文档结构合法（schemaVersion/meta.rev）');
}

await host.stop();

// ------------------------------------------------------- step 8: offline (static substitute)
{
  const codeRoots = ['host', 'client-src'];
  let external = 0;
  const { execFileSync } = await import('node:child_process');
  for (const root of codeRoots) {
    try {
      const out = execFileSync('grep', ['-RIlE', 'https?://', root], { encoding: 'utf8' });
      for (const line of out.split('\n').filter(Boolean)) {
        const hits = execFileSync('grep', ['-InE', 'https?://', line], { encoding: 'utf8' }).split('\n').filter(Boolean)
          .filter((row) => !/127\.0\.0\.1|localhost/.test(row))
          .filter((row) => !/['"]http:\/\/x['"]/.test(row));   // URL constructor base, not a call
        external += hits.length;
      }
    } catch { /* grep exits 1 when there is no match: that is the good case */ }
  }
  check('P3-49', external === 0, '断网等价断言：实现内无远端 http(s) 调用（Z3；真断网由 CDP/人工验）', 'external refs=' + external);
}

manual('P3-M1', 'AI 工具 service 层落库（create_unit / write_handoff）',
  'HTTP 层无调用工具的执行缝（只有 test.diagnostics 暴露注册表）；需在真实 AI 会话里让模型调用 2 个工具，再由 GET /issue 观察落库');
manual('P3-M2', '未归属会话提醒（FR-41）',
  '需要真实 DSH 会话事实；纯文档口径为 0，真机由 CDP 步骤（侧栏会话 + 顶部提醒）验证');
manual('P3-M3', '视觉/文案/交互手感（F-07 文案主词、入口导航、深浅色）',
  '不可机械判定，由 CDP 截图 + 人工走查清单覆盖');

const auto = results.filter((item) => item.ok !== null);
const passed = auto.filter((item) => item.ok === true).length;
const failed = auto.filter((item) => item.ok !== true);
console.log('');
if (failed.length > 0) {
  console.log('FAILED ASSERTIONS:');
  for (const item of failed) console.log('  ' + item.id + ' ' + item.label);
}
console.log('MANUAL: ' + results.filter((item) => item.ok === null).map((item) => item.id).join(', '));
console.log('P3 ' + passed + '/' + auto.length);
process.exitCode = failed.length === 0 ? 0 : 1;
NODE
