#!/usr/bin/env node
/**
 * Deterministic generator for tests/fixtures/seed-2p6i.json.
 *
 * The fixture is produced by running the real commands (not hand-written JSON),
 * so its shape always matches the document schema, its activities have real
 * seq numbers, and the expected values in expected.mjs can be recomputed.
 *
 * Determinism: a virtual clock advances 60s per step and all random ids are
 * re-keyed to stable names (p1/p2, u01..u07, ac1..) before writing.
 *
 * Usage: node tests/fixtures/build-seed.mjs [--write]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepository } from '../../host/store/repository.js';
import { createService } from '../../host/service/workbench.js';
import { ingestSessionEvent } from '../../host/service/session-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = join(HERE, 'seed-2p6i.json');
const BASE_MS = Date.UTC(2026, 9, 26, 9, 0, 0);
export const FIXTURE_WS_A = '/tmp/wb-fixture/projA';

/** A clock that moves one minute per read; returns ISO + ms consistently. */
function createClock() {
  let cursor = 0;
  return {
    now: () => new Date(BASE_MS + cursor++ * 60_000).toISOString(),
    nowMs: () => BASE_MS + cursor++ * 60_000,
    peekMs: () => BASE_MS + cursor * 60_000,
  };
}

function rekey(doc, maps) {
  let text = JSON.stringify(doc);
  for (const [from, to] of Object.entries(maps)) text = text.split(from).join(to);
  return JSON.parse(text);
}

/** Build the document exactly as documented in TEST-PLAN §8.1. */
export async function buildSeedDoc() {
  mkdirSync(FIXTURE_WS_A, { recursive: true });
  const file = join(mkdtempSync(join(tmpdir(), 'wb-fixture-build-')), 'workbench.json');
  const clock = createClock();
  const repository = createRepository({ file, now: () => clock.now() });
  repository.load();
  const service = createService({ repository, clock });
  let n = 0;
  const run = async (type, payload = {}) => {
    n += 1;
    const out = await service.execute({ type, payload, clientRequestId: 'c_seed_' + n });
    return out && Object.prototype.hasOwnProperty.call(out, 'result') ? out.result : out;
  };
  const event = (payload) => repository.mutate((doc) => ingestSessionEvent(doc, payload, clock.now()));
  const nowIso = () => clock.now();

  // --- projects -----------------------------------------------------------------
  const p1 = (await run('project.create', { name: 'P1 工作台核心', defaultWorkspacePath: FIXTURE_WS_A })).projectId;
  const p2 = (await run('project.create', { name: 'P2 收尾项目' })).projectId;

  const todo = async (title) => (await run('todo.create', { title })).issueId;
  const triage = async (issueId, projectId, workspacePath, texts) =>
    run('issue.triage', { issueId, projectId, workspacePath, acceptance: texts.map((text) => ({ text })) });
  const tickAll = async (issueId, ids) => {
    for (const acceptanceId of ids) await run('acceptance.update', { issueId, acceptanceId, done: true });
  };
  const criteriaOf = (issueId) => (repository.document.issues.find((i) => i.issueId === issueId).acceptanceCriteria || []).map((c) => c.id);

  // --- WB-01: done, one passed unit + one retried (voided) unit ------------------
  const wb01 = await todo('完成收尾的议题：把工作台收尾');
  await triage(wb01, p1, FIXTURE_WS_A, ['收尾标准一', '收尾标准二']);
  const u01 = (await run('unit.claim', { issueId: wb01, sessionId: 'session-wb01-a', cwd: FIXTURE_WS_A, sessionEnded: true })).unitId;
  await run('unit.accept', { unitId: u01 });
  const u02 = (await run('unit.claim', { issueId: wb01, sessionId: 'session-wb01-b', cwd: FIXTURE_WS_A, sessionEnded: true })).unitId;
  await run('unit.void', { unitId: u02, reason: 'retried' });
  await tickAll(wb01, criteriaOf(wb01));
  await run('issue.finalAccept', { issueId: wb01 });

  // --- WB-02: in_review + terminalReview, two passed units, 1/3 criteria done ----
  const wb02 = await todo('等你确认的议题：标准只勾了一条');
  await triage(wb02, p1, FIXTURE_WS_A, ['已满足的标准', '未满足的标准一', '未满足的标准二']);
  const u03 = (await run('unit.claim', { issueId: wb02, sessionId: 'session-wb02-a', cwd: FIXTURE_WS_A, sessionEnded: true })).unitId;
  await run('unit.accept', { unitId: u03 });
  const u04 = (await run('unit.claim', { issueId: wb02, sessionId: 'session-wb02-b', cwd: FIXTURE_WS_A, sessionEnded: true })).unitId;
  await run('unit.accept', { unitId: u04 });
  const firstCriterion = criteriaOf(wb02)[0];
  await run('acceptance.update', { issueId: wb02, acceptanceId: firstCriterion, done: true });

  // --- WB-03: in_progress with one running unit ---------------------------------
  const wb03 = await todo('处理中的议题：有一个在跑单元');
  await triage(wb03, p1, FIXTURE_WS_A, ['处理中标准']);
  const u05 = (await run('unit.claim', { issueId: wb03, sessionId: 'session-wb03-a', cwd: FIXTURE_WS_A })).unitId;
  await event({ kind: 'turn/start', sessionId: 'session-wb03-a', at: nowIso() });

  // --- WB-04: blocked with one failed unit --------------------------------------
  const wb04 = await todo('遇到阻碍的议题：单元异常结束');
  await triage(wb04, p1, FIXTURE_WS_A, ['阻碍标准']);
  const u06 = (await run('unit.claim', { issueId: wb04, sessionId: 'session-wb04-a', cwd: FIXTURE_WS_A })).unitId;
  await event({ kind: 'turn/end', sessionId: 'session-wb04-a', reason: { kind: 'error' }, at: nowIso() });

  // --- P2: WB-05 todo without workspace, WB-06 cancelled ------------------------
  const wb05 = await todo('待认领但没有工作区的议题');
  await triage(wb05, p2, null, ['无工作区标准']);
  const wb06 = await todo('已取消的议题');
  await triage(wb06, p2, FIXTURE_WS_A, ['取消标准']);
  const u07 = (await run('unit.claim', { issueId: wb06, sessionId: 'session-wb06-a', cwd: FIXTURE_WS_A })).unitId;
  await run('issue.setStatus', { issueId: wb06, status: 'cancelled' });

  // --- two TODOs (near-duplicate titles, for the duplicate hint) ----------------
  await todo('把工作台跑通：准备阶段三验收');
  await todo('把工作台跑通：准备阶段三验收（重复）');

  const raw = repository.document;
  const maps = { [p1]: 'p1', [p2]: 'p2' };
  const unitsInOrder = raw.units.map((u) => u.unitId);
  unitsInOrder.forEach((unitId, index) => { maps[unitId] = 'u' + String(index + 1).padStart(2, '0'); });
  raw.issues
    .flatMap((issue) => issue.acceptanceCriteria || [])
    .forEach((criterion, index) => { maps[criterion.id] = 'ac' + String(index + 1).padStart(2, '0'); });
  const doc = rekey(raw, maps);
  doc.meta.writer = null;
  // sanity: units keep the documented order/ids
  void u05; void u06; void u07;
  return doc;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const doc = await buildSeedDoc();
  writeFileSync(SEED_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote ' + SEED_PATH);
  console.log('projects=' + doc.projects.length + ' issues=' + doc.issues.length + ' units=' + doc.units.length
    + ' todos=' + doc.issues.filter((i) => i.isTriaged !== true).length);
}