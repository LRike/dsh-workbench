import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../../host/store/repository.js';
import { SCHEMA_VERSION } from '../../host/store/document.js';

const AT = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-02T00:00:00.000Z';

/** A schemaVersion 1 document: units were "one round", ended without needing a wrap-up. */
function v1Document() {
  return {
    schemaVersion: 1,
    meta: { createdAt: AT, updatedAt: LATER, rev: 7, nextIssueNo: 3, nextActivitySeq: 20, writer: null },
    projects: [{ projectId: 'p1', name: 'Legacy', defaultWorkspacePath: '/tmp', archivedAt: null, createdAt: AT, updatedAt: LATER, activities: [] }],
    issues: [{
      issueId: 'WB-1', isTriaged: true, triagedAt: AT, projectId: 'p1', workspacePath: '/tmp',
      title: 'legacy issue', description: '', status: 'in_review', archivedAt: null, statusPin: null, statusUndo: null,
      acceptanceCriteria: [{ id: 'c1', text: 'works', done: true, createdAt: AT }],
      createdAt: AT, updatedAt: LATER, activities: [],
    }],
    units: [
      {
        unitId: 'u1', issueId: 'WB-1', roundNo: 1, parentUnitId: null, goal: 'first', sessionId: 's1',
        execState: 'ended', acceptState: 'pending', voided: false, exitReason: 'normal', closeReason: null,
        handover: { change: 'a', verify: 'b', result: 'c', risk: 'd', source: 'ai', at: LATER, editedAt: null },
        createdBy: 'human', startedAt: AT, endedAt: LATER, createdAt: AT, updatedAt: LATER,
      },
      {
        unitId: 'u2', issueId: 'WB-1', roundNo: 2, parentUnitId: null, goal: 'second', sessionId: 's2',
        execState: 'ended', acceptState: 'pending', voided: false, exitReason: 'interrupted', closeReason: null,
        handover: null,
        createdBy: 'human', startedAt: AT, endedAt: LATER, createdAt: AT, updatedAt: LATER,
      },
    ],
    decisions: [],
  };
}

test('A6 a schemaVersion 1 document migrates to v2 without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-mig-'));
  const file = join(dir, 'workbench.json');
  writeFileSync(file, JSON.stringify(v1Document(), null, 2));

  const repository = createRepository({ file, now: () => LATER });
  repository.load();
  const doc = repository.document;

  assert.equal(doc.schemaVersion, SCHEMA_VERSION, 'the document is upgraded to the current schema');
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(doc.projects.length, 1, 'projects survive');
  assert.equal(doc.issues.length, 1, 'issues survive');
  assert.equal(doc.units.length, 2, 'units survive');
  assert.equal(doc.meta.rev, 8, 'the rev is monotonic across the migration write');

  const first = doc.units.find((unit) => unit.unitId === 'u1');
  assert.equal(first.turnCount, 1, 'a historical ended unit counts as one round');
  assert.equal(first.turns.length, 1);
  assert.equal(first.turns[0].turnNo, 1);
  assert.ok(first.turns[0].endedAt, 'the backfilled round is closed');
  assert.equal(first.needsHandoff, false, 'a unit that kept its handover needs no draft');

  const second = doc.units.find((unit) => unit.unitId === 'u2');
  assert.equal(second.turnCount, 1);
  assert.equal(second.needsHandoff, true, 'an ended unit without a handover must be reviewed with a draft');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.schemaVersion, 2, 'the migrated document is persisted');
  assert.equal(onDisk.units.length, 2);

  const names = readdirSync(dir);
  assert.equal(names.filter((name) => name.includes('.bak-')).length, 1, 'the original bytes are backed up');
  assert.equal(names.filter((name) => name.includes('.corrupt-')).length, 0, 'an old schema is NOT a corrupt document');
});
