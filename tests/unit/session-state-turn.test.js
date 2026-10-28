import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../../host/store/repository.js';
import { createService } from '../../host/service/workbench.js';

let tick = 1;
const clock = {
  now: () => new Date(Date.UTC(2026, 9, 27, 12, 0, tick++)).toISOString(),
  nowMs: () => Date.UTC(2026, 9, 27, 12, 0, tick++),
};

function harness() {
  const file = join(mkdtempSync(join(tmpdir(), 'wb-turn-')), 'workbench.json');
  const repository = createRepository({ file, now: () => clock.now() });
  repository.load();
  const service = createService({ repository, clock });
  const run = (type, payload = {}) => service.execute({ type, payload, clientRequestId: type + '-' + Math.random().toString(36).slice(2) });
  const dir = mkdtempSync(join(tmpdir(), 'wb-turn-ws-'));
  return { repository, service, run, dir };
}

/** Create a triaged issue and claim it with the given session id. */
async function claimable(h, sessionId) {
  const project = await h.run('project.create', { name: 'Turn ' + sessionId });
  const projectId = project.result.projectId;
  const todo = await h.run('todo.create', { title: 'round issue ' + sessionId });
  const issueId = todo.result.issueId;
  await h.run('issue.triage', { issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'c1' }] });
  const claimed = await h.run('unit.claim', { issueId, sessionId, cwd: h.dir });
  return { issueId, unitId: claimed.result.unitId };
}

const failCode = (code) => (error) => error && error.code === code;

const find = (h, unitId, issueId) => {
  const doc = h.repository.document;
  return { unit: doc.units.find((u) => u.unitId === unitId), issue: doc.issues.find((i) => i.issueId === issueId) };
};

test('A1 turn/end only counts rounds: unit keeps running, issue stays in progress', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a1');
  for (let round = 0; round < 3; round += 1) {
    await h.service.ingestSessionEvent({ sessionId: 'turn-a1', kind: 'turn/start' });
    await h.service.ingestSessionEvent({ sessionId: 'turn-a1', kind: 'turn/end', reason: { kind: 'completed' } });
  }
  const { unit, issue } = find(h, unitId, issueId);
  assert.equal(unit.execState, 'running', 'turn/end must not end the unit');
  assert.equal(unit.turnCount, 3, 'three rounds are counted');
  assert.equal(unit.acceptState, 'pending');
  assert.equal(issue.status, 'in_progress', 'the issue must not enter review by turn/end');
  assert.equal(unit.turns.length, 3);
  assert.ok(unit.turns.every((turn) => turn.endedAt), 'every round record is closed');
});

test('A2 an aborted round is not a cancelled unit', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a2');
  await h.service.ingestSessionEvent({ sessionId: 'turn-a2', kind: 'turn/start' });
  await h.service.ingestSessionEvent({ sessionId: 'turn-a2', kind: 'turn/end', reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const { unit, issue } = find(h, unitId, issueId);
  assert.equal(unit.voided, false, 'stopping one reply must not void the unit');
  assert.equal(unit.execState, 'running', 'the unit is still alive');
  assert.equal(unit.turnCount, 1);
  assert.equal(unit.turns[0].note, 'aborted');
  assert.equal(issue.status, 'in_progress');
});

test('A3 session/disposed moves the unit to wrapping and leaves the issue alone', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a3');
  await h.service.ingestSessionEvent({ sessionId: 'turn-a3', kind: 'turn/start' });
  await h.service.ingestSessionEvent({ sessionId: 'turn-a3', kind: 'session/disposed' });
  const { unit, issue } = find(h, unitId, issueId);
  assert.equal(unit.execState, 'wrapping', 'a disposed session needs a human wrap-up');
  assert.equal(unit.turns[0].note, 'session-closed');
  assert.equal(issue.status, 'in_progress', 'the issue is not blocked by a closed session');
});

test('A4 reconcile: idle session -> wrapping, missing session -> failed', async () => {
  const h = harness();
  const idle = await claimable(h, 'turn-a4-idle');
  const gone = await claimable(h, 'turn-a4-gone');
  await h.service.ingestSessionEvent({ sessionId: 'turn-a4-idle', kind: 'turn/start' });
  await h.service.ingestSessionEvent({ sessionId: 'turn-a4-gone', kind: 'turn/start' });

  const { corrections } = await h.service.reconcile([{ sessionId: 'turn-a4-idle', running: false }]);
  const idleUnit = find(h, idle.unitId, idle.issueId);
  const goneUnit = find(h, gone.unitId, gone.issueId);
  assert.equal(idleUnit.unit.execState, 'wrapping', 'an idle session only means nobody is talking');
  assert.equal(idleUnit.issue.status, 'in_progress');
  assert.equal(goneUnit.unit.execState, 'failed', 'a missing session is a real failure');
  assert.equal(goneUnit.issue.status, 'blocked');
  assert.equal(corrections.length, 2);
});

test('A5 the round window is capped at 50 while turnCount keeps the true total', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a5');
  for (let round = 0; round < 55; round += 1) {
    await h.service.ingestSessionEvent({ sessionId: 'turn-a5', kind: 'turn/start' });
    await h.service.ingestSessionEvent({ sessionId: 'turn-a5', kind: 'turn/end', reason: { kind: 'completed' } });
  }
  const { unit, issue } = find(h, unitId, issueId);
  assert.equal(unit.turnCount, 55, 'the counter is the true total');
  assert.equal(unit.turns.length, 50, 'only the newest 50 records are kept');
  assert.equal(unit.turns[unit.turns.length - 1].turnNo, 55);
  assert.equal(issue.status, 'in_progress');
});

test('A7 a wrapping unit is surfaced in the inbox until somebody wraps it up', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a7');
  await h.service.ingestSessionEvent({ sessionId: 'turn-a7', kind: 'turn/start' });
  await h.service.ingestSessionEvent({ sessionId: 'turn-a7', kind: 'session/disposed' });

  const before = await h.service.inbox();
  assert.equal(before.wrapupUnits.length, 1, 'the inbox lists the unit that needs a wrap-up');
  assert.equal(before.wrapupUnits[0].unitId, unitId);
  assert.equal(before.wrapupUnits[0].issueId, issueId);
  assert.equal(before.counts.pendingWrapupUnits, 1);
  assert.equal(before.wrapupUnits[0].turnCount, 1, 'the interrupted round is counted, not invented');

  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.counters.pendingWrapupUnits, 1, 'the snapshot counter uses the same口径');

  await h.run('unit.suggestWrapup', { unitId, note: '看起来做完了' });
  const suggested = await h.service.inbox();
  assert.equal(suggested.suggestedUnits.length, 1, 'an AI suggestion is surfaced in the inbox');
  assert.equal(suggested.suggestedUnits[0].unitId, unitId);
  assert.equal(suggested.counts.pendingSuggestionUnits, 1);

  await h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' } });
  const after = await h.service.inbox();
  assert.equal(after.wrapupUnits.length, 0);
  assert.equal(after.counts.pendingWrapupUnits, 0);
  assert.equal(after.reviewUnits.length, 1, 'now it waits for review instead');
  assert.equal(after.suggestedUnits.length, 0, 'wrapping up consumes the suggestion');
});

test('A8 an AI wrap-up suggestion is only a signal: it never ends the unit', async () => {
  const h = harness();
  const { issueId, unitId } = await claimable(h, 'turn-a8');
  await h.service.ingestSessionEvent({ sessionId: 'turn-a8', kind: 'turn/start' });
  await h.service.ingestSessionEvent({ sessionId: 'turn-a8', kind: 'turn/end', reason: { kind: 'completed' } });

  const suggested = await h.run('unit.suggestWrapup', { unitId, note: '目标已达成，建议收尾' });
  assert.equal(suggested.result.wrapUpSuggestion.note, '目标已达成，建议收尾');
  let { unit, issue } = find(h, unitId, issueId);
  assert.equal(unit.execState, 'running', 'a suggestion must not end the unit (D-17)');
  assert.equal(issue.status, 'in_progress', 'a suggestion must not move the issue');
  assert.equal(unit.wrapUpSuggestion.by, 'ai');

  // Talking again means the suggestion is stale.
  await h.service.ingestSessionEvent({ sessionId: 'turn-a8', kind: 'turn/start' });
  ({ unit } = find(h, unitId, issueId));
  assert.equal(unit.wrapUpSuggestion, null, 'new work clears the old suggestion');

  await h.run('unit.suggestWrapup', { unitId, note: 'again' });
  await h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' } });
  ({ unit, issue } = find(h, unitId, issueId));
  assert.equal(unit.wrapUpSuggestion, null, 'wrapping up consumes the suggestion');
  assert.equal(unit.execState, 'ended');
  assert.equal(issue.status, 'in_review');

  await assert.rejects(h.run('unit.suggestWrapup', { unitId }), failCode('E_STATE'));
});
