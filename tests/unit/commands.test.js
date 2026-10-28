import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../../host/store/repository.js';
import { createService } from '../../host/service/workbench.js';

let tick = 1;
const clock = { now: () => new Date(Date.UTC(2026, 9, 26, 12, 0, tick++)).toISOString(), nowMs: () => Date.UTC(2026, 9, 26, 12, 0, tick++) };

function harness() {
  const file = join(mkdtempSync(join(tmpdir(), 'wb-cmd-')), 'workbench.json');
  const repository = createRepository({ file, now: () => clock.now() });
  repository.load();
  const service = createService({ repository, clock });
  const run = (type, payload = {}) => service.execute({ type, payload, clientRequestId: type + '-' + Math.random().toString(36).slice(2) });
  const dir = mkdtempSync(join(tmpdir(), 'wb-ws-'));
  return { file, repository, service, run, dir };
}

const failCode = (code) => (error) => error && error.code === code;

async function makeProject(h, name = 'Demo') {
  const created = await h.run('project.create', { name });
  return created.result.projectId;
}

test('project create/rename/archive lifecycle', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].name, 'Demo');
  await h.run('project.rename', { projectId, name: 'Renamed' });
  await h.run('project.setArchived', { projectId, archived: true });
  const after = await h.service.snapshot();
  assert.equal(after.projects.length, 0, 'archived projects leave the default view');
});

test('todo.create returns duplicate hints but still creates', async () => {
  const h = harness();
  await h.run('todo.create', { title: '写一份周报' });
  const second = await h.run('todo.create', { title: '写一份周报' });
  assert.equal(second.result.duplicateHints.length, 1);
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.counters.todoCount, 2);
});

test('triage requires a project and at least one acceptance criterion', async () => {
  const h = harness();
  const todo = await h.run('todo.create', { title: 'Ship it' });
  await assert.rejects(h.run('issue.triage', { issueId: todo.result.issueId, acceptance: [{ text: 'done' }] }), failCode('E_BAD_REQUEST'));
  const projectId = await makeProject(h);
  await assert.rejects(h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [] }), failCode('E_ACCEPTANCE'));
  const triaged = await h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [{ text: 'works' }] });
  assert.equal(triaged.result.status, 'todo');
  const detail = h.service.issueDetail(todo.result.issueId);
  assert.equal(detail.issue.isTriaged, true);
  assert.equal(detail.issue.acceptanceCriteria.length, 1);
});

test('acceptance cannot be emptied and is capped at 20', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [{ text: 'a' }] });
  const detail = h.service.issueDetail(todo.result.issueId);
  await assert.rejects(h.run('acceptance.remove', { issueId: todo.result.issueId, acceptanceId: detail.issue.acceptanceCriteria[0].id }), failCode('E_ACCEPTANCE'));
});

test('status writes reject done and route cancelled through the cancel action', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [{ text: 'a' }] });
  await assert.rejects(h.run('issue.setStatus', { issueId: todo.result.issueId, status: 'done' }), failCode('E_BAD_REQUEST'));
  const cancelled = await h.run('issue.setStatus', { issueId: todo.result.issueId, status: 'cancelled' });
  assert.equal(cancelled.result.status, 'cancelled');
});

test('only terminal issues can be archived', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [{ text: 'a' }] });
  await assert.rejects(h.run('issue.setArchived', { issueId: todo.result.issueId, archived: true }), failCode('E_CONFLICT'));
  await h.run('issue.cancel', { issueId: todo.result.issueId });
  await h.run('issue.setArchived', { issueId: todo.result.issueId, archived: true });
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.projects[0].issues.length, 0);
});

test('claiming an ended session enters review and undo restores the previous status', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  const workspace = h.dir;
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: workspace, acceptance: [{ text: 'a' }] });
  const claimed = await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-x', cwd: workspace, sessionEnded: true });
  assert.equal(claimed.result.execState, 'ended');
  const detail = h.service.issueDetail(todo.result.issueId);
  assert.equal(detail.issue.status, 'in_review');
  assert.ok(detail.issue.undo);
  await h.run('issue.undoAutoStatus', { issueId: todo.result.issueId });
  assert.equal(h.service.issueDetail(todo.result.issueId).issue.status, 'todo');
});

test('R1 rejects a second active unit on the same issue', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-a', cwd: h.dir });
  await assert.rejects(h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-b', cwd: h.dir }), failCode('E_CONFLICT'));
});

test('C8 blocks workspace changes after units exist', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-a', cwd: h.dir });
  await assert.rejects(h.run('issue.setWorkspace', { issueId: todo.result.issueId, workspacePath: h.dir }), failCode('E_CONFLICT'));
});

test('terminal review requires all criteria unless acknowledged, and writes done', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }, { text: 'b' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-a', cwd: h.dir, sessionEnded: true });
  const detail = h.service.issueDetail(todo.result.issueId);
  const unitId = detail.units[0].unitId;
  await h.run('unit.accept', { unitId });
  const ready = h.service.issueDetail(todo.result.issueId);
  assert.equal(ready.issue.terminalReview, true);
  await assert.rejects(h.run('issue.finalAccept', { issueId: todo.result.issueId }), failCode('E_STATE'));
  const accepted = await h.run('issue.finalAccept', { issueId: todo.result.issueId, acknowledgeUnmet: true });
  assert.equal(accepted.result.status, 'done');
});

test('unit reject resumes the SAME unit (D-19); only a dead session voids it', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-a', cwd: h.dir, sessionEnded: true });
  const unitId = h.service.issueDetail(todo.result.issueId).units[0].unitId;
  await assert.rejects(h.run('unit.reject', { unitId }), failCode('E_BAD_REQUEST'));

  const resumed = await h.run('unit.reject', { unitId, reason: 'not good enough' });
  const detail = h.service.issueDetail(todo.result.issueId);
  assert.equal(resumed.result.resumed, true);
  assert.equal(detail.units[0].voided, false, 'D-19: the same unit keeps working');
  assert.equal(detail.units[0].execState, 'running');
  assert.equal(detail.issue.status, 'in_progress');

  await h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' } });
  const closed = await h.run('unit.reject', { unitId, reason: 'session closed', sessionUnavailable: true });
  const after = h.service.issueDetail(todo.result.issueId);
  assert.equal(closed.result.voided, true);
  assert.equal(after.units[0].voided, true);
  assert.equal(after.issue.status, 'todo');
});

test('a reject sends the unit back to work only while its session still exists (Q4)', async () => {
  const make = (rows) => {
    const h = harness();
    return { h, service: h.service, rows };
  };
  // session gone -> the unit is voided and the issue returns to the queue
  const gone = make([]);
  const projectA = await makeProject(gone.h);
  const todoA = await gone.h.run('todo.create', { title: 'Gone session' });
  await gone.h.run('issue.triage', { issueId: todoA.result.issueId, projectId: projectA, workspacePath: gone.h.dir, acceptance: [{ text: 'a' }] });
  await gone.h.run('unit.claim', { issueId: todoA.result.issueId, sessionId: 'session-gone', cwd: gone.h.dir, sessionEnded: true });
  const unitA = gone.h.service.issueDetail(todoA.result.issueId).units[0].unitId;
  // the harness has no session port, so the client-style flag is the fallback path
  const voided = await gone.h.run('unit.reject', { unitId: unitA, reason: 'not good', sessionUnavailable: true });
  assert.equal(voided.result.voided, true);
  assert.equal(gone.h.service.issueDetail(todoA.result.issueId).issue.status, 'todo');
});

test('the issue workspace is frozen once work has started (C8)', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Freeze' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });

  // still todo, no units: the workspace may still be corrected
  await h.run('issue.setWorkspace', { issueId: todo.result.issueId, workspacePath: '/tmp' });

  // a unit exists -> frozen
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-freeze', cwd: '/tmp' });
  await assert.rejects(h.run('issue.setWorkspace', { issueId: todo.result.issueId, workspacePath: h.dir }), failCode('E_CONFLICT'));
  assert.equal(h.service.issueDetail(todo.result.issueId).issue.workspacePath, '/tmp', 'the workspace did not move');

  // even with only a status change (work started without a unit) it stays frozen
  const second = await h.run('todo.create', { title: 'Freeze by status' });
  await h.run('issue.triage', { issueId: second.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('issue.setStatus', { issueId: second.result.issueId, status: 'in_progress' });
  await assert.rejects(h.run('issue.setWorkspace', { issueId: second.result.issueId, workspacePath: '/tmp' }), failCode('E_CONFLICT'));
});

test('the AI may not rewrite a handover once the issue is finished (U10)', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Finished' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-fin', cwd: h.dir });
  const unitId = h.service.issueDetail(todo.result.issueId).units[0].unitId;
  await h.run('unit.writeHandoff', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'ai' });

  // the human finishes the issue
  h.repository.mutate((doc) => { const issue = doc.issues[0]; issue.status = 'done'; });

  await assert.rejects(
    h.run('unit.writeHandoff', { unitId, handover: { change: 'c2', verify: 'v', result: 'r', risk: 'k' }, source: 'ai' }),
    failCode('E_STATE'),
  );
  // ...but a human may still correct the record
  await h.run('unit.writeHandoff', { unitId, handover: { change: 'fixed typo', verify: 'v', result: 'r', risk: 'k' }, source: 'human' });
  assert.equal(h.service.issueDetail(todo.result.issueId).units[0].handover.change, 'fixed typo');
});

test('a migrated unit without a handover cannot be accepted until one exists (U3)', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Legacy' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-legacy', cwd: h.dir, sessionEnded: true });
  const unitId = h.service.issueDetail(todo.result.issueId).units[0].unitId;
  // Simulate a v1 unit migrated by MIGRATIONS[2]: ended, pending, no handover.
  h.repository.mutate((doc) => { const unit = doc.units[0]; unit.handover = null; unit.needsHandoff = true; });

  await assert.rejects(h.run('unit.accept', { unitId }), failCode('E_STATE'));

  const synthesized = await h.run('unit.synthesizeHandoff', { unitId });
  assert.equal(synthesized.result.source, 'synthesized');
  const unit = h.service.issueDetail(todo.result.issueId).units[0];
  assert.equal(unit.needsHandoff, false, 'a draft makes the unit reviewable');
  assert.ok(unit.handover, 'the draft exists');

  const accepted = await h.run('unit.accept', { unitId });
  assert.equal(accepted.result.acceptState, 'passed');
});

test('the start prompt never teaches the AI how to end a unit', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Prompt' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  const planned = await h.run('unit.startRound', { issueId: todo.result.issueId, mode: 'ai', goal: '把登录页做完' });
  const prompt = planned.result.prompt;
  assert.ok(typeof prompt === 'string' && prompt.indexOf('把登录页做完') >= 0, 'the prompt carries the goal');
  assert.equal(prompt.indexOf('四段交接'), -1, 'no handover lesson in a keep-going prompt');
  assert.ok(prompt.indexOf('收尾由人发起') >= 0, 'but it does say who decides the ending');
  // R1 keeps one active unit per issue, so the manual path needs its own issue.
  const second = await h.run('todo.create', { title: 'Prompt me' });
  await h.run('issue.triage', { issueId: second.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  const mePath = await h.run('unit.startRound', { issueId: second.result.issueId, mode: 'me', goal: '再试一次' });
  assert.equal(mePath.result.promptSuggestion.indexOf('交接'), -1, 'the copy-paste suggestion stays clean too');
});

test('ending a unit without a handover asks THAT session to summarize, then waits', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Summarize' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-sum', cwd: h.dir });
  const unitId = h.service.issueDetail(todo.result.issueId).units[0].unitId;

  const asked = await h.run('unit.wrapup', { unitId });
  assert.equal(asked.result.needsSummary, true, 'the first click only asks for a summary');
  assert.equal(asked.result.notifySession.sessionId, 'session-sum', 'the request goes to the unit own session');
  assert.ok(asked.result.notifySession.text.indexOf('改动') >= 0, 'it names the four parts');
  const unit = h.service.issueDetail(todo.result.issueId).units[0];
  assert.equal(unit.execState, 'running', 'the unit is not ended by asking (U3)');
  assert.ok(unit.wrapRequest && unit.wrapRequest.at, 'the request is recorded so the UI can show progress');

  // the AI writes it, the human confirms -> then the unit really ends
  await h.run('unit.writeHandoff', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' }, source: 'ai' });
  const done = await h.run('unit.wrapup', { unitId });
  assert.equal(done.result.execState, 'ended');
  assert.equal(h.service.issueDetail(todo.result.issueId).units[0].wrapRequest, null, 'the request clears when it is fulfilled');
});

test('unit.wrapup is the only door to review and it requires a four-part handover (U3)', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'Wrap' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-wrap', cwd: h.dir });
  const unitId = h.service.issueDetail(todo.result.issueId).units[0].unitId;

  // A running unit cannot reach review without a handover: the first click only asks
  // its own session to write one (two-step wrap-up), so it must not end the unit.
  const asked = await h.run('unit.wrapup', { unitId });
  assert.equal(asked.result.needsSummary, true);
  assert.equal(h.service.issueDetail(todo.result.issueId).units[0].execState, 'running');
  await assert.rejects(
    h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: '', result: 'r', risk: 'k' } }),
    failCode('E_BAD_REQUEST'),
  );

  const before = h.service.issueDetail(todo.result.issueId).units[0].turnCount;
  const wrapped = await h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' } });
  assert.equal(h.service.issueDetail(todo.result.issueId).units[0].turnCount, before, 'wrap-up must never fabricate a round');
  assert.equal(wrapped.result.execState, 'ended');
  assert.equal(wrapped.result.acceptState, 'pending');
  assert.equal(wrapped.result.issueStatus, 'in_review');

  // Wrapping twice is rejected, and the unit is no longer "running".
  await assert.rejects(h.run('unit.wrapup', { unitId, handover: { change: 'c', verify: 'v', result: 'r', risk: 'k' } }), failCode('E_STATE'));
});

test('abnormal unit appears as a pending decision and cannot be accepted', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'T' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, workspacePath: h.dir, acceptance: [{ text: 'a' }] });
  await h.run('unit.claim', { issueId: todo.result.issueId, sessionId: 'session-a', cwd: h.dir });
  h.repository.mutate((doc) => {
    const unit = doc.units[0];
    unit.execState = 'failed';
    unit.exitReason = 'interrupted';
    unit.endedAt = clock.now();
    const issue = doc.issues[0];
    issue.status = 'blocked';
  });
  const inbox = await h.service.inbox();
  assert.equal(inbox.decisions.filter((d) => d.kind === 'unit_abnormal').length, 1);
  await assert.rejects(h.run('unit.accept', { unitId: h.repository.document.units[0].unitId }), failCode('E_STATE'));
});

test('zombie and no-workspace decisions are derived', async () => {
  const h = harness();
  const projectId = await makeProject(h);
  const todo = await h.run('todo.create', { title: 'No workspace' });
  await h.run('issue.triage', { issueId: todo.result.issueId, projectId, acceptance: [{ text: 'a' }] });
  const inbox = await h.service.inbox();
  assert.equal(inbox.decisions.filter((d) => d.kind === 'issue_no_workspace').length, 1);
});
