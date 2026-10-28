/**
 * Pure domain-rule tests (no DSH, no store): the invariants that commands rely on.
 * These are the mechanical statements of R1/R4/N7/W-rules and the derived flags,
 * kept separate from the command-level tests so a rule regression points at the
 * rule, not at the command that happens to call it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeUnits, liveUnits, pendingReviewUnits, abnormalUnits, r4Count,
  autoWriteAllowed, applyAutoStatus, undoAvailable, terminalReview, pinActive,
  isZombie, lastTouch, pushActivity, DAY_MS,
} from '../../host/domain/rules.js';

const DAY = DAY_MS;
const iso = (offsetMs = 0) => new Date(Date.UTC(2026, 9, 26, 12, 0, 0) + offsetMs).toISOString();

const project = (over = {}) => ({
  projectId: 'p1', name: 'P', defaultWorkspacePath: null, archivedAt: null,
  createdAt: iso(-DAY), updatedAt: iso(), activities: [], ...over,
});
const issue = (over = {}) => ({
  issueId: 'WB-1', isTriaged: true, triagedAt: iso(-DAY), projectId: 'p1', workspacePath: '/tmp/ws',
  title: 't', description: '',
  acceptanceCriteria: [{ id: 'ac1', text: 'x', done: false, doneAt: null }],
  status: 'todo', archivedAt: null, statusPin: null, statusUndo: null,
  createdAt: iso(-DAY), updatedAt: iso(-DAY), activities: [], ...over,
});
let n = 0;
const unit = (over = {}) => ({
  unitId: 'u' + (++n), issueId: 'WB-1', roundNo: 1, parentUnitId: null, goal: 'g',
  sessionId: null, execState: 'pending', acceptState: 'pending', voided: false,
  exitReason: null, closeReason: null, setupIssue: null, handover: null,
  createdBy: 'human', startedAt: null, endedAt: null,
  createdAt: iso(-1000), updatedAt: iso(-1000), ...over,
});
const doc = (issues = [], units = [], projects = [project()]) => ({
  schemaVersion: 1,
  meta: { createdAt: iso(-DAY), updatedAt: iso(), nextIssueNo: 2, nextActivitySeq: 1, writer: null },
  projects, issues, units, decisions: [],
});

test('R1: pending, running and awaiting-review units occupy the slot; voided and passed ones do not', () => {
  assert.equal(activeUnits([unit({ execState: 'pending' })]).length, 1);
  assert.equal(activeUnits([unit({ execState: 'running' })]).length, 1);
  assert.equal(activeUnits([unit({ execState: 'ended', acceptState: 'pending' })]).length, 1,
    'a unit waiting for review still blocks a second round');
  assert.equal(activeUnits([unit({ voided: true, closeReason: 'rejected', execState: 'running' })]).length, 0);
  assert.equal(activeUnits([unit({ execState: 'ended', acceptState: 'passed' })]).length, 0);
  assert.equal(activeUnits([unit({ execState: 'failed' })]).length, 1,
    'an abnormal unit keeps the slot until it is disposed of (FR-35)');
});

test('R1 helpers: pending review and abnormal units are disjoint queues', () => {
  const ended = unit({ execState: 'ended', acceptState: 'pending' });
  const failed = unit({ execState: 'failed', acceptState: 'pending' });
  assert.deepEqual(pendingReviewUnits([ended, failed]).map((u) => u.unitId), [ended.unitId],
    'abnormal units go to the decision queue, not the review queue (FR-40)');
  assert.deepEqual(abnormalUnits([ended, failed]).map((u) => u.unitId), [failed.unitId]);
  assert.equal(liveUnits([unit({ voided: true })]).length, 0);
});

test('R4: count = live pending/running units + running unassigned sessions, never clamped', () => {
  const units = [
    unit({ execState: 'pending' }), unit({ execState: 'running' }),
    unit({ execState: 'running', voided: true, closeReason: 'cancelled' }),
    unit({ execState: 'ended', acceptState: 'pending' }),
  ];
  assert.equal(r4Count(doc([], units)), 2);
  assert.equal(r4Count(doc([], units), 1), 3);
  assert.equal(r4Count(doc([], units), 2), 4, 'n may exceed 3: the cap gates new executions, registration is still allowed');
});

test('N7: no automatic write on done/cancelled, archived issue, archived project or a live pin', () => {
  const live = doc([issue()]);
  assert.equal(autoWriteAllowed(doc([issue({ status: 'in_progress' })]), issue({ status: 'in_progress' }), []), true);
  assert.equal(autoWriteAllowed(doc([issue()]), issue({ status: 'done' }), []), false);
  assert.equal(autoWriteAllowed(doc([issue()]), issue({ status: 'cancelled' }), []), false);
  assert.equal(autoWriteAllowed(doc([issue({ archivedAt: iso() })]), issue({ archivedAt: iso() }), []), false);
  assert.equal(autoWriteAllowed(doc([issue()], [], [project({ archivedAt: iso() })]), issue(), []), false);
  assert.equal(autoWriteAllowed(doc([issue({ statusPin: { at: iso(-60_000) } })]), issue({ statusPin: { at: iso(-60_000) } }), []), false);
  assert.equal(autoWriteAllowed(doc([issue({ isTriaged: false })]), issue({ isTriaged: false }), []), false, 'TODOs have no state machine');
  void live;
});

test('N7: applyAutoStatus is inert under the gate and records exactly one undo slot when allowed', () => {
  const closingDoc = doc([issue({ status: 'done' })]);
  const closingIssue = closingDoc.issues[0];
  assert.equal(applyAutoStatus(closingDoc, closingIssue, [], 'in_review', 'u1', { at: iso(), text: 'x' }), false);
  assert.equal(closingIssue.status, 'done');
  assert.equal(closingIssue.activities.length, 0);
  assert.equal(closingIssue.statusUndo, null);

  const openDoc = doc([issue({ status: 'in_progress' })]);
  const openIssue = openDoc.issues[0];
  assert.equal(applyAutoStatus(openDoc, openIssue, [], 'in_review', 'u1', { at: iso(), text: 'done' }), true);
  assert.equal(openIssue.status, 'in_review');
  assert.equal(openIssue.statusUndo.from, 'in_progress');
  assert.equal(openIssue.statusUndo.to, 'in_review');
  assert.equal(openIssue.activities.length, 1);
  assert.equal(openIssue.activities[0].actor, 'system');
  assert.equal(openIssue.activities[0].type, 'issue.status_auto');
  assert.equal(applyAutoStatus(openDoc, openIssue, [], 'in_review', 'u1', { at: iso(), text: 'again' }), false,
    'writing the same status twice records nothing');
});

test('undo: exactly a 24h window, single slot, and nothing to undo without an automatic change', () => {
  const nowMs = Date.UTC(2026, 9, 26, 12, 0, 0);
  assert.equal(undoAvailable(issue(), nowMs), false);
  assert.equal(undoAvailable(issue({ statusUndo: { from: 'in_progress', to: 'in_review', at: new Date(nowMs - 1000).toISOString(), activitySeq: 3 } }), nowMs), true);
  assert.equal(undoAvailable(issue({ statusUndo: { from: 'in_progress', to: 'in_review', at: new Date(nowMs - DAY + 1000).toISOString(), activitySeq: 3 } }), nowMs), true,
    '23h59m59s is still inside the window');
  assert.equal(undoAvailable(issue({ statusUndo: { from: 'in_progress', to: 'in_review', at: new Date(nowMs - DAY).toISOString(), activitySeq: 3 } }), nowMs), false,
    'at exactly 24h the undo point is expired');
  assert.equal(undoAvailable(issue({ statusUndo: { from: 'in_progress', to: 'in_review', at: new Date(nowMs - DAY - 1).toISOString(), activitySeq: 3 } }), nowMs), false);
});

test('pin: a manual status write survives until a unit is created after it', () => {
  const pinned = issue({ status: 'blocked', statusPin: { at: iso(-60_000) } });
  assert.equal(pinActive(pinned, []), true);
  assert.equal(pinActive(pinned, [unit({ createdAt: iso(-120_000) })]), true, 'an older unit keeps the pin');
  assert.equal(pinActive(pinned, [unit({ createdAt: iso(-1_000) })]), false, 'a newer unit expires it');
  assert.equal(pinActive(issue(), [unit()]), false, 'no pin, no effect');
});

test('U-STATE-05: a live pin blocks automatic writes, and the next round lifts it', () => {
  const pinnedIssue = issue({ status: 'blocked', statusPin: { at: iso(-60_000) }, statusUndo: null });
  const pinnedDoc = doc([pinnedIssue]);
  const pinnedUnit = unit({ execState: 'running', createdAt: iso(-120_000) });

  // While the pin holds, the automatic moment must be a no-op with no activity trace.
  const blocked = applyAutoStatus(pinnedDoc, pinnedIssue, [pinnedUnit], 'in_review', pinnedUnit.unitId, { at: iso(), text: 'turn ended normally' });
  assert.equal(blocked, false, 'the pinned status must not be overwritten');
  assert.equal(pinnedIssue.status, 'blocked');
  assert.equal(pinnedIssue.activities.length, 0, 'a refused automatic write leaves no activity');
  assert.equal(pinnedIssue.statusUndo, null, 'and no undo slot');

  // A unit created after the pin lifts it: the same auto moment now applies.
  const newerUnit = unit({ execState: 'ended', acceptState: 'pending', createdAt: iso(1000) });
  const resumed = applyAutoStatus(pinnedDoc, pinnedIssue, [newerUnit], 'in_review', newerUnit.unitId, { at: iso(2000), text: 'turn ended normally' });
  assert.equal(resumed, true, 'starting the next round expires the pin');
  assert.equal(pinnedIssue.status, 'in_review');
  assert.ok(pinnedIssue.statusUndo, 'and the automatic change becomes undoable');
});

test('terminalReview: in_review + no pending review + no live pending unit', () => {
  const passed = unit({ execState: 'ended', acceptState: 'passed' });
  const review = unit({ execState: 'ended', acceptState: 'pending' });
  const pending = unit({ execState: 'pending' });
  const voided = unit({ execState: 'ended', acceptState: 'pending', voided: true, closeReason: 'cancelled' });
  assert.equal(terminalReview(issue({ status: 'in_review' }), [passed]), true);
  assert.equal(terminalReview(issue({ status: 'in_review' }), [passed, review]), false);
  assert.equal(terminalReview(issue({ status: 'in_review' }), [passed, pending]), false);
  assert.equal(terminalReview(issue({ status: 'in_review' }), [passed, voided]), true, 'voided units do not block the gate');
  assert.equal(terminalReview(issue({ status: 'in_progress' }), [passed]), false);
});

test('zombie: in_progress with no active unit and no touch for 24h', () => {
  const nowMs = Date.UTC(2026, 9, 26, 12, 0, 0);
  const stale = issue({ status: 'in_progress', createdAt: new Date(nowMs - 2 * DAY).toISOString() });
  const fresh = issue({ status: 'in_progress', createdAt: new Date(nowMs - 1000).toISOString() });
  assert.equal(isZombie(stale, [], nowMs), true);
  assert.equal(isZombie(fresh, [], nowMs), false);
  assert.equal(isZombie(stale, [unit({ execState: 'running', createdAt: new Date(nowMs - 2 * DAY).toISOString() })], nowMs), false,
    'an active unit keeps it alive');
  assert.equal(lastTouch(stale, []).length > 0, true);
});

test('activity stamping: seq is monotonic across holds and does not reset per issue', () => {
  const meta = { nextActivitySeq: 1 };
  const first = pushActivity(meta, { activities: [] }, { at: iso(), actor: 'human', type: 'todo.created', text: 'a' });
  const second = pushActivity(meta, { activities: [] }, { at: iso(), actor: 'human', type: 'todo.created', text: 'b' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(meta.nextActivitySeq, 3);
  assert.equal(first.data, null, 'data defaults to null, never undefined');
});