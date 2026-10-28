/**
 * S2 integration tests: a real DSH web host, the plugin installed into a
 * throwaway DSH_HOME, and the HTTP contract from docs/design/API.md exercised
 * over the wire (snapshot read, same-origin writes, error codes, persistence).
 *
 * Run:
 *   node --test tests/integration/api.test.js                  # auto: runs when DSH is installed
 *   WB_RUN_INTEGRATION=1 node --test tests/integration/api.test.js
 *   WB_RUN_INTEGRATION=0 node --test tests/integration/api.test.js   # force skip
 *
 * Assertions follow API.md, not the implementation. Where the two disagree the
 * test names say "contract:" and the mismatch is listed in the report instead of
 * being relaxed here.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startHost, isDshAvailable } from '../tools/dsh-host.mjs';
import { computeExpected, loadSeed, SEED_PATH } from '../fixtures/expected.mjs';
import { SCHEMA_VERSION as SCHEMA_VERSION_NOW } from '../../host/store/document.js';

const FORCED = process.env.WB_RUN_INTEGRATION;
const ENABLED = FORCED === '1' || (FORCED !== '0' && isDshAvailable());
const SKIP = ENABLED ? false : 'no DSH host on this machine (set WB_RUN_INTEGRATION=1 to force)';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

describe('S2 HTTP API against a real DSH host', { skip: SKIP }, () => {
  /** @type {Awaited<ReturnType<typeof startHost>>} */
  let host;
  /** @type {any} */
  let doc;

  before(async () => { host = await startHost(); });
  after(async () => { if (host) await host.stop(); });

  /** POST a command the same way the browser half does. */
  async function post(type, payload = {}, overrides = {}) {
    const result = await host.command(type, payload);
    doc = readJson(host.dataFile) || doc;
    const data = result.body && result.body.data;
    return {
      status: result.status,
      body: result.body,
      ok: result.body && result.body.ok === true,
      code: result.body && result.body.error && result.body.error.code,
      result: data && data.result !== undefined ? data.result : data,
      version: result.body && result.body.version,
    };
  }

  const snapshot = async () => {
    const response = await host.get('/workbench/api/snapshot');
    return { status: response.status, body: response.body };
  };

  const issueRow = (issueId) => {
    doc = readJson(host.dataFile) || doc;
    return (doc.issues || []).find((issue) => issue.issueId === issueId);
  };
  const projectRow = (projectId) => {
    doc = readJson(host.dataFile) || doc;
    return (doc.projects || []).find((project) => project.projectId === projectId);
  };
  const seqOf = (issueId) => (issueRow(issueId).activities || []).map((activity) => activity.seq);
  const tailSeq = (issueId) => { const seqs = seqOf(issueId); return seqs[seqs.length - 1]; };

  // --- reads ---------------------------------------------------------------

  it('GET /snapshot returns the documented envelope and counters', async () => {
    const { status, body } = await snapshot();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.apiVersion, 1);
    assert.equal(typeof body.data, 'object');
    const counters = body.data.counters;
    for (const key of ['running', 'pendingReviewUnits', 'pendingDecisions', 'todoCount']) {
      assert.equal(typeof counters[key], 'number', 'counters.' + key + ' must be a number');
    }
    assert.equal(counters.maxParallel, undefined, 'the global parallelism cap was retired (R4 removed)');
    assert.ok(Array.isArray(body.data.projects), 'projects must be an array');
  });

  it('contract: the response carries a numeric store version (API.md §1.1)', async () => {
    const { body } = await snapshot();
    assert.equal(typeof body.version, 'number', 'API.md §1.1 promises version: <storeSeq>');
  });

  it('contract: documented read routes are mounted (API.md §4.2-4.7)', async () => {
    const missing = [];
    for (const path of ['/workbench/api/issue?id=WB-1', '/workbench/api/inbox', '/workbench/api/board', '/workbench/api/search?q=x', '/workbench/api/activity?issueId=WB-1']) {
      const response = await host.get(path);
      // A mounted route answers with the envelope (200 or a domain error), not a bare 404 route miss.
      if (response.status === 404 && response.body && response.body.error && /unknown route/.test(String(response.body.error.message))) missing.push(path);
    }
    assert.deepEqual(missing, [], 'read routes documented in API.md are not mounted yet');
  });

  // --- auth ----------------------------------------------------------------

  it('auth: a write without Origin (and without a session cookie) is refused with 401/403', async () => {
    const before = readJson(host.dataFile);
    const response = await fetch(host.base + '/workbench/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'project.create', clientRequestId: 'c_noorigin', payload: { name: 'nope' } }),
    });
    assert.ok([401, 403].includes(response.status), 'expected 401 or 403, got ' + response.status);
    const afterDoc = readJson(host.dataFile);
    assert.equal(afterDoc.projects.length, before.projects.length, 'a refused write must not touch the document');
  });

  it('auth: a cross-origin write is refused with 401/403 and writes nothing', async () => {
    const before = readJson(host.dataFile);
    const response = await fetch(host.base + '/workbench/api/command', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        ...(host.cookieHeader ? { cookie: host.cookieHeader } : {}),
      },
      body: JSON.stringify({ type: 'project.create', clientRequestId: 'c_cross', payload: { name: 'nope' } }),
    });
    assert.ok([401, 403].includes(response.status), 'expected 401 or 403, got ' + response.status);
    assert.equal(readJson(host.dataFile).projects.length, before.projects.length);
  });

  it('auth: a write without a JSON content type is refused (CSRF form-post guard)', async () => {
    const response = await fetch(host.base + '/workbench/api/command', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: host.base },
      body: JSON.stringify({ type: 'project.create', payload: { name: 'form' } }),
    });
    assert.ok([401, 403].includes(response.status), 'expected 401 or 403, got ' + response.status);
  });

  it('auth: a same-origin write with the session cookie is accepted', async () => {
    const created = await post('project.create', { name: 'Cookie ' + Date.now() });
    assert.equal(created.status, 200);
    assert.equal(created.ok, true);
  });

  // --- project -------------------------------------------------------------

  it('project lifecycle: create -> rename -> default workspace -> archive, each writing an activity', async () => {
    const workspace = process.env.TMPDIR || '/tmp';
    const created = await post('project.create', { name: 'Lifecycle', defaultWorkspacePath: workspace });
    assert.equal(created.status, 200);
    const projectId = created.result.projectId;
    assert.ok(projectId);
    assert.equal(projectRow(projectId).name, 'Lifecycle');
    assert.equal(projectRow(projectId).defaultWorkspacePath, workspace);
    assert.equal(projectRow(projectId).archivedAt, null);

    const renamed = await post('project.rename', { projectId, name: 'Lifecycle v2' });
    assert.equal(renamed.result.name, 'Lifecycle v2');
    assert.equal(projectRow(projectId).name, 'Lifecycle v2');

    const bound = await post('project.setDefaultWorkspace', { projectId, defaultWorkspacePath: null });
    assert.equal(projectRow(projectId).defaultWorkspacePath, null, 'null unbinds the default directory (C5)');
    void bound;

    const archived = await post('project.setArchived', { projectId, archived: true });
    assert.equal(archived.result.archived, true);
    assert.ok(projectRow(projectId).archivedAt, 'archivedAt must be persisted');

    const activities = projectRow(projectId).activities || [];
    assert.equal(activities.length, 4, 'create/rename/bind/archive each record one activity');
    const seqs = activities.map((activity) => activity.seq);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right), 'activity seq is ascending');
    assert.equal(new Set(seqs).size, seqs.length, 'activity seq is unique');
  });

  // --- TODO ----------------------------------------------------------------

  it('todo.create needs only a title, returns duplicate hints and never touches project progress', async () => {
    const before = await snapshot();
    const created = await post('todo.create', { title: 'Ship the integration harness' });
    assert.equal(created.status, 200);
    const issueId = created.result.issueId;
    assert.match(String(issueId), /^WB-\d+$/, 'issueId is a readable WB-<n> code (DATA-MODEL)');
    assert.ok(Array.isArray(created.result.duplicateHints));
    assert.equal(issueRow(issueId).isTriaged, false);
    assert.equal(issueRow(issueId).projectId, null, 'a TODO may have no project');
    assert.equal(issueRow(issueId).workspacePath, null);

    const duplicate = await post('todo.create', { title: 'Ship the integration harness' });
    assert.ok(duplicate.result.duplicateHints.length > 0, 'a near-duplicate title only warns (R3)');
    assert.ok(duplicate.result.issueId, 'and still creates the TODO');

    const counted = await snapshot();
    assert.equal(counted.body.data.counters.todoCount, before.body.data.counters.todoCount + 2, 'both TODOs are in the triage record area');
  });

  // --- triage --------------------------------------------------------------

  it('issue.triage validates project and acceptance criteria before promoting a TODO', async () => {
    const project = await post('project.create', { name: 'Triage target' });
    const projectId = project.result.projectId;
    const todo = await post('todo.create', { title: 'Needs triage ' + Date.now() });
    const issueId = todo.result.issueId;

    const noProject = await post('issue.triage', { issueId, acceptance: [{ text: 'c1' }] });
    assert.equal(noProject.code, 'E_BAD_REQUEST', 'project is mandatory (C12)');
    assert.equal(noProject.status, 400);

    const noAcceptance = await post('issue.triage', { issueId, projectId, acceptance: [] });
    assert.equal(noAcceptance.code, 'E_ACCEPTANCE', 'at least one criterion is mandatory (FR-11)');
    assert.equal(noAcceptance.status, 422);

    const ok = await post('issue.triage', { issueId, projectId, acceptance: [{ text: 'ship it' }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.result.status, 'todo', 'a triaged issue starts in todo');
    const row = issueRow(issueId);
    assert.equal(row.isTriaged, true);
    assert.ok(row.triagedAt, 'triagedAt records the moment (DATA-MODEL)');
    assert.equal(row.projectId, projectId);
    assert.equal(row.acceptanceCriteria.length, 1);

    const snap = await snapshot();
    const projectEntry = snap.body.data.projects.find((entry) => entry.projectId === projectId);
    assert.ok(projectEntry, 'the triaged issue appears under its project in the snapshot');
    assert.equal(projectEntry.issues.length, 1);
    assert.equal(projectEntry.issues[0].status, 'todo');
  });

  // --- acceptance ----------------------------------------------------------

  it('acceptance add/update/remove keep the >=1 rule and never change the issue status', async () => {
    const project = await post('project.create', { name: 'Acceptance ' + Date.now() });
    const todo = await post('todo.create', { title: 'criteria ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, acceptance: [{ text: 'first' }] });
    const statusBefore = issueRow(issueId).status;

    const added = await post('acceptance.add', { issueId, text: 'second' });
    assert.equal(added.result.criterion.text, 'second');
    assert.equal(issueRow(issueId).acceptanceCriteria.length, 2);

    const checked = await post('acceptance.update', { issueId, acceptanceId: issueRow(issueId).acceptanceCriteria[0].id, done: true });
    assert.equal(checked.result.criterion.done, true);
    assert.ok(checked.result.criterion.doneAt, 'ticking records doneAt');
    assert.equal(issueRow(issueId).status, statusBefore, 'ticking never changes the issue status (FR-21)');

    const removed = await post('acceptance.remove', { issueId, acceptanceId: issueRow(issueId).acceptanceCriteria[1].id });
    assert.equal(removed.result.remaining, 1);

    const lastOne = await post('acceptance.remove', { issueId, acceptanceId: issueRow(issueId).acceptanceCriteria[0].id });
    assert.equal(lastOne.code, 'E_ACCEPTANCE', 'deleting the last criterion is refused (FR-21)');
    assert.equal(lastOne.status, 422);
    assert.equal(issueRow(issueId).acceptanceCriteria.length, 1);
  });

  // --- status --------------------------------------------------------------

  it('issue.setStatus writes the five human statuses, refuses done, and routes cancelled through the cancel action', async () => {
    const project = await post('project.create', { name: 'Status ' + Date.now() });
    const todo = await post('todo.create', { title: 'status ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, acceptance: [{ text: 'c' }] });

    for (const status of ['in_progress', 'blocked', 'in_review', 'todo']) {
      const response = await post('issue.setStatus', { issueId, status });
      assert.equal(response.result.status, status);
      assert.equal(issueRow(issueId).status, status);
    }

    const done = await post('issue.setStatus', { issueId, status: 'done' });
    assert.equal(done.ok, false, 'done is not writable by the generic status command (D30)');
    assert.ok(['E_BAD_REQUEST', 'E_STATE'].includes(done.code), 'documented refusal code, got ' + done.code);
    assert.notEqual(issueRow(issueId).status, 'done');

    const cancelled = await post('issue.setStatus', { issueId, status: 'cancelled' });
    assert.equal(cancelled.result.status, 'cancelled');
    assert.equal(issueRow(issueId).status, 'cancelled');
    assert.ok(issueRow(issueId).statusPin, 'a human status write pins the issue (FR-22)');
  });

  it('issue.cancel stops in-flight units and records cancelled_by_user', async () => {
    const workspace = process.env.TMPDIR || '/tmp';
    const project = await post('project.create', { name: 'Cancel ' + Date.now(), defaultWorkspacePath: workspace });
    const todo = await post('todo.create', { title: 'cancel ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, workspacePath: workspace, acceptance: [{ text: 'c' }] });
    const claim = await post('unit.claim', { issueId, sessionId: 'session-cancel-' + Date.now(), cwd: workspace });
    assert.equal(claim.status, 200);

    const cancelled = await post('issue.cancel', { issueId });
    assert.equal(cancelled.status, 200, 'issue.cancel is documented in API.md §5.2');
    assert.equal(issueRow(issueId).status, 'cancelled');
    const unit = (readJson(host.dataFile).units || []).find((entry) => entry.issueId === issueId);
    assert.equal(unit.voided, true, 'cancel voids in-flight units (N5)');
    assert.equal(unit.closeReason, 'cancelled');
    assert.equal(unit.exitReason, 'cancelled_by_user', 'N6: this exit reason never triggers an automatic status write');
  });

  // --- archive / terminal review ------------------------------------------

  it('issue.setArchived only accepts closing issues and makes them read-only', async () => {
    const project = await post('project.create', { name: 'Archive ' + Date.now() });
    const todo = await post('todo.create', { title: 'archive ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, acceptance: [{ text: 'c' }] });

    const early = await post('issue.setArchived', { issueId, archived: true });
    assert.equal(early.code, 'E_CONFLICT', 'only done/cancelled issues can be archived (FR-24)');
    assert.equal(early.status, 409);

    await post('issue.setStatus', { issueId, status: 'cancelled' });
    const archived = await post('issue.setArchived', { issueId, archived: true });
    assert.equal(archived.result.archived, true);
    assert.ok(issueRow(issueId).archivedAt);

    const edit = await post('issue.update', { issueId, title: 'should not apply' });
    assert.equal(edit.code, 'E_CONFLICT', 'archived issues are read-only (N7)');

    const restored = await post('issue.setArchived', { issueId, archived: false });
    assert.equal(restored.result.archived, false);
    const edited = await post('issue.update', { issueId, title: 'now editable' });
    assert.equal(edited.status, 200);
    assert.equal(issueRow(issueId).title, 'now editable');
  });

  it('issue.finalAccept refuses before the terminal-review gate and writes done after it', async () => {
    const workspace = process.env.TMPDIR || '/tmp';
    const project = await post('project.create', { name: 'Final ' + Date.now(), defaultWorkspacePath: workspace });
    const todo = await post('todo.create', { title: 'final ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, workspacePath: workspace, acceptance: [{ text: 'c1' }, { text: 'c2' }] });

    const early = await post('issue.finalAccept', { issueId });
    assert.equal(early.code, 'E_STATE', 'terminal review requires in_review + no pending unit');
    assert.equal(early.status, 422);

    const claimed = await post('unit.claim', { issueId, sessionId: 'session-final-' + Date.now(), cwd: workspace, sessionEnded: true });
    assert.equal(claimed.status, 200);
    await post('unit.accept', { unitId: claimed.result.unitId });
    await post('issue.setStatus', { issueId, status: 'in_review' });

    const unmet = await post('issue.finalAccept', { issueId });
    assert.equal(unmet.code, 'E_STATE', 'unmet criteria need an explicit acknowledgement (FR-25)');

    const accepted = await post('issue.finalAccept', { issueId, acknowledgeUnmet: true });
    assert.equal(accepted.result.status, 'done');
    assert.equal(accepted.result.unmet, 2);
    assert.equal(issueRow(issueId).status, 'done');
    const last = issueRow(issueId).activities.slice(-1)[0];
    assert.match(String(last.text), /带 2 条未满足项/, 'the acknowledgement leaves a trace in the activity stream (FR-25)');
  });

  // --- persistence / idempotency -----------------------------------------

  it('every accepted write is on disk immediately and activity seq keeps increasing', async () => {
    const project = await post('project.create', { name: 'Persist ' + Date.now() });
    const todo = await post('todo.create', { title: 'persist ' + Date.now() });
    const issueId = todo.result.issueId;
    await post('issue.triage', { issueId, projectId: project.result.projectId, acceptance: [{ text: 'c' }] });
    const first = tailSeq(issueId);
    await post('issue.update', { issueId, title: 'renamed ' + Date.now() });
    const second = tailSeq(issueId);
    await post('issue.comment', { issueId, text: 'a comment' });
    const third = tailSeq(issueId);

    assert.ok(Number.isInteger(first) && first > 0);
    assert.ok(second > first, 'seq increases across writes');
    assert.ok(third > second);
    assert.equal(issueRow(issueId).title, readJson(host.dataFile).issues.find((issue) => issue.issueId === issueId).title);
  });

  it('idempotency: the same clientRequestId twice yields one document change', async () => {
    const before = readJson(host.dataFile).projects.length;
    const payload = { name: 'Idem ' + Date.now() };
    // Replaying the same request id must return the first result and not write twice.
    const first = await host.command('project.create', payload, { clientRequestId: 'c_idem_fixed' });
    const second = await host.command('project.create', payload, { clientRequestId: 'c_idem_fixed' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data, first.body.data, 'the replay returns the first result');
    assert.equal(readJson(host.dataFile).projects.length, before + 1, 'the replay adds no second project');
  });

  it('contract: project.create/setDefaultWorkspace take workspacePath per API.md §5.1', async () => {
    const workspacePath = process.cwd();
    const created = await post('project.create', { name: 'API field ' + Date.now(), workspacePath });
    assert.equal(projectRow(created.result.projectId).defaultWorkspacePath, workspacePath,
      'API.md names the payload field workspacePath (implementation uses defaultWorkspacePath)');
  });

});

// --------------------------------------------------------------- storage failure paths

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const corruptFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.includes('.corrupt-')) : []);

describe('I-STORE-02a: a corrupt document is quarantined and rebuilt (B3)', { skip: SKIP }, () => {
  let host;
  let original;
  before(async () => {
    host = await startHost({
      profile: 'it-corrupt',
      prepareData: (homeDir) => {
        mkdirSync(join(homeDir, 'workbench'), { recursive: true });
        original = Buffer.from('{ this is not json');
        writeFileSync(join(homeDir, 'workbench', 'workbench.json'), original);
      },
    });
  });
  after(async () => { if (host) await host.stop(); });

  it('keeps the original bytes in a .corrupt-<ts> file and starts from an empty document', async () => {
    const snapshot = await host.get('/workbench/api/snapshot');
    assert.equal(snapshot.status, 200, 'the service must come up with a fresh document');
    const names = corruptFiles(host.dataDir);
    assert.equal(names.length, 1, 'exactly one quarantine file');
    const quarantined = join(host.dataDir, names[0]);
    assert.equal(sha256(quarantined), createHash('sha256').update(original).digest('hex'), 'quarantined bytes are intact');
    const rebuilt = JSON.parse(readFileSync(host.dataFile, 'utf8'));
    assert.equal(rebuilt.schemaVersion, SCHEMA_VERSION_NOW);
    assert.deepEqual(rebuilt.projects, [], 'the rebuilt document is empty');
  });
});

describe('I-STORE-02b: a too-new schemaVersion degrades the service to 409 (B3)', { skip: SKIP }, () => {
  let host;
  let bytesBefore;
  before(async () => {
    host = await startHost({
      profile: 'it-toonew',
      prepareData: (homeDir) => {
        mkdirSync(join(homeDir, 'workbench'), { recursive: true });
        const doc = {
          schemaVersion: 999,
          meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextIssueNo: 1, nextActivitySeq: 1, writer: null },
          projects: [], issues: [], units: [], decisions: [],
        };
        writeFileSync(join(homeDir, 'workbench', 'workbench.json'), JSON.stringify(doc, null, 2));
        bytesBefore = sha256(join(homeDir, 'workbench', 'workbench.json'));
      },
    });
  });
  after(async () => { if (host) await host.stop(); });

  it('refuses both reads and writes with 409 E_SCHEMA_TOO_NEW and leaves the file untouched', async () => {
    const snapshot = await host.get('/workbench/api/snapshot');
    assert.equal(snapshot.status, 409, 'a degraded service must not serve reads');
    assert.equal(snapshot.body.error.code, 'E_SCHEMA_TOO_NEW');

    const write = await host.command('project.create', { name: 'must not land' });
    assert.equal(write.status, 409, 'a degraded service must not accept writes');
    assert.equal(write.body.error.code, 'E_SCHEMA_TOO_NEW');

    assert.equal(sha256(host.dataFile), bytesBefore, 'the newer document is never rewritten or quarantined');
    assert.deepEqual(corruptFiles(host.dataDir), [], 'too-new is not corruption: no .corrupt- file');
  });
});

// --------------------------------------------------------------- lock + disk failures (M3)

describe('I-LOCK-01 / I-STORE-01: write failure paths', { skip: SKIP }, () => {
  let host;
  before(async () => { host = await startHost({ profile: 'it-fail' }); });
  after(async () => { if (host) await host.stop(); });

  it('I-LOCK-01: a fresh foreign lock makes the write fail with 503 E_LOCK_TIMEOUT', async () => {
    await host.command('project.create', { name: 'before lock' });
    const before = sha256(host.dataFile);
    // A live pid + a fresh ts: contended, not stale, so the store waits then gives up.
    writeFileSync(host.lockFile, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'it-lock' }), { mode: 0o600 });
    try {
      const blocked = await host.command('project.create', { name: 'must not land' });
      assert.equal(blocked.status, 503, 'lock timeout maps to 503');
      assert.equal(blocked.body.error.code, 'E_LOCK_TIMEOUT');
      assert.equal(sha256(host.dataFile), before, 'a blocked write changes nothing');
    } finally {
      unlinkSync(host.lockFile);
    }
    const retried = await host.command('project.create', { name: 'after lock released' });
    assert.equal(retried.status, 200, 'the same write succeeds once the lock is gone');
  });

  it('I-STORE-01: an unwritable data directory yields 500 E_STORAGE and rolls back', async () => {
    const before = sha256(host.dataFile);
    chmodSync(host.dataDir, 0o500);
    try {
      const failed = await host.command('project.create', { name: 'disk full simulation' });
      assert.equal(failed.status, 500, 'a write failure maps to 500');
      assert.equal(failed.body.error.code, 'E_STORAGE', 'API.md §3: write failure is E_STORAGE');
      assert.equal(sha256(host.dataFile), before, 'memory and disk both roll back');
      assert.deepEqual(readdirSync(host.dataDir).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left behind');
    } finally {
      chmodSync(host.dataDir, 0o700);
    }
    const ok = await host.command('project.create', { name: 'after chmod back' });
    assert.equal(ok.status, 200);
  });
});

// --------------------------------------------------------------- seams (B2)

describe('U-SEAM-01: test seams are off unless WORKBENCH_TEST_SEAMS=1', { skip: SKIP }, () => {
  let host;
  before(async () => { host = await startHost({ profile: 'it-noseam' }); });
  after(async () => { if (host) await host.stop(); });

  it('every test.* command is E_NOT_FOUND and writes nothing', async () => {
    assert.equal(host.seams, false);
    const before = sha256(host.dataFile);
    for (const [type, payload] of [
      ['test.setClock', { nowMs: Date.now() }],
      ['test.advanceClock', { ms: 1000 }],
      ['test.sessionEvent', { sessionId: 's', kind: 'turn/end', reason: { kind: 'completed' } }],
    ]) {
      const response = await host.command(type, payload);
      assert.equal(response.status, 404, type + ' must be absent without seams');
      assert.equal(response.body.error.code, 'E_NOT_FOUND');
    }
    assert.equal(sha256(host.dataFile), before, 'no seam command may touch the document');
  });
});

describe('I-SEAM: seams drive the clock and session events deterministically', { skip: SKIP }, () => {
  let host;
  before(async () => { host = await startHost({ profile: 'it-seam', seams: true }); });
  after(async () => { if (host) await host.stop(); });

  it('test.setClock / test.advanceClock are accepted', async () => {
    assert.equal(host.seams, true);
    const set = await host.command('test.setClock', { nowMs: Date.UTC(2026, 9, 26, 12, 0, 0) });
    assert.equal(set.status, 200, 'setClock: ' + JSON.stringify(set.body.error || ''));
    const advance = await host.command('test.advanceClock', { ms: 60_000 });
    assert.equal(advance.status, 200, 'advanceClock: ' + JSON.stringify(advance.body.error || ''));
  });

  it('test.sessionEvent turn/end only counts a round and never ends the unit (U1)', async () => {
    const workspace = process.env.TMPDIR || '/tmp';
    const project = await host.command('project.create', { name: 'Seam flow', defaultWorkspacePath: workspace });
    assert.equal(project.status, 200);
    const projectId = project.body.data.result.projectId;
    const todo = await host.command('todo.create', { title: 'seam flow issue' });
    const issueId = todo.body.data.result.issueId;
    await host.command('issue.triage', { issueId, projectId, workspacePath: workspace, acceptance: [{ text: 'c1' }] });
    const claimed = await host.command('unit.claim', { issueId, sessionId: 'session-seam-1', cwd: workspace });
    assert.equal(claimed.status, 200);

    const ended = await host.command('test.sessionEvent', { sessionId: 'session-seam-1', kind: 'turn/end', reason: { kind: 'completed' } });
    assert.equal(ended.status, 200, 'sessionEvent: ' + JSON.stringify(ended.body.error || ''));

    const detail = await host.get('/workbench/api/issue?id=' + encodeURIComponent(issueId));
    assert.equal(detail.status, 200);
    const issue = detail.body.data.issue;
    assert.equal(issue.status, 'in_progress', 'U1: a finished turn must not push the issue into review');
    // The read model returns units next to the issue, not nested inside it.
    const units = detail.body.data.units || [];
    const unit = units.find((entry) => entry.unitId === claimed.body.data.result.unitId);
    assert.ok(unit, 'the claimed unit appears in the detail payload');
    assert.equal(unit.execState, 'running', 'U1: turn/end must not end the unit');
    assert.equal(unit.acceptState, 'pending');
    assert.equal(unit.turnCount, 1, 'the finished round is counted');

    // Three rounds in the same session keep the unit alive and just accumulate.
    for (let round = 0; round < 2; round += 1) {
      await host.command('test.sessionEvent', { sessionId: 'session-seam-1', kind: 'turn/start' });
      await host.command('test.sessionEvent', { sessionId: 'session-seam-1', kind: 'turn/end', reason: { kind: 'completed' } });
    }
    const after = await host.get('/workbench/api/issue?id=' + encodeURIComponent(issueId));
    const unitAfter = (after.body.data.units || []).find((entry) => entry.unitId === claimed.body.data.result.unitId);
    assert.equal(unitAfter.execState, 'running', 'U1: still running after 3 rounds');
    assert.equal(unitAfter.turnCount, 3, 'turnCount accumulates across rounds');
    assert.equal(after.body.data.issue.status, 'in_progress', 'the issue never entered review by turn/end');
  });
});

// ------------------------------------------------- seeded fixture (TEST-PLAN §8.1)

describe('S2.5: the shared fixture drives snapshot / board / inbox expectations', { skip: SKIP }, () => {
  /** @type {Awaited<ReturnType<typeof startHost>>} */
  let host;
  /** @type {ReturnType<typeof computeExpected>} */
  let expected;

  before(async () => {
    assert.ok(existsSync(SEED_PATH), 'fixture seed-2p6i.json must exist (node tests/fixtures/build-seed.mjs)');
    host = await startHost({ profile: 'it-fixture', prepareData: (homeDir) => { loadSeed(homeDir); } });
    expected = computeExpected(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
  });
  after(async () => { if (host) await host.stop(); });

  it('GET /snapshot reproduces every documented counter and project progress', async () => {
    const response = await host.get('/workbench/api/snapshot');
    assert.equal(response.status, 200);
    const data = response.body.data;

    for (const [key, value] of Object.entries(expected.counters)) {
      assert.equal(data.counters[key], value, 'counters.' + key + ' must match the frozen fixture table');
    }
    assert.equal(data.projects.length, expected.projects.length, 'one row per project');
    for (const project of expected.projects) {
      const actual = data.projects.find((entry) => entry.projectId === project.projectId);
      assert.ok(actual, 'project ' + project.projectId + ' appears in the snapshot');
      assert.deepEqual(actual.progress, project.progress, 'progress of ' + project.projectId + ' (TEST-PLAN §8.1)');
      assert.equal(actual.issues.length, project.issueCount, 'issue count of ' + project.projectId);
      assert.equal(actual.defaultWorkspacePath, project.defaultWorkspacePath);
    }
  });

  it('GET /board shows exactly the four active columns with the fixture counts', async () => {
    const response = await host.get('/workbench/api/board');
    assert.equal(response.status, 200);
    const columns = response.body.data.columns;
    const actual = {};
    for (const column of columns) actual[column.status] = column.items.length;
    assert.deepEqual(actual, expected.board, 'board columns must match TEST-PLAN §8.1');
    assert.equal(columns.some((column) => column.status === 'done' || column.status === 'cancelled'), false);
  });

  it('GET /inbox splits units vs decisions with the documented counts', async () => {
    const response = await host.get('/workbench/api/inbox');
    assert.equal(response.status, 200);
    const data = response.body.data;
    // Inbox shape: { reviewUnits, terminalReviews, decisions, todos, counts }.
    assert.deepEqual((data.reviewUnits || []).map((unit) => unit.unitId), expected.inbox.pendingReviewUnits, 'the waiting-review queue is empty for this fixture');
    assert.deepEqual((data.terminalReviews || []).map((entry) => ({ issueId: entry.issueId, unmet: entry.unmet })), expected.inbox.terminalReviews);
    const kinds = {};
    for (const item of data.decisions || []) {
      kinds[item.kind] = kinds[item.kind] || [];
      kinds[item.kind].push(item.subjectRef);
    }
    assert.deepEqual((kinds.unit_abnormal || []).slice().sort(), expected.inbox.pendingDecision.unit_abnormal.slice().sort(), 'the failed unit is a unit_abnormal decision');
    assert.deepEqual((kinds.issue_no_workspace || []).slice().sort(), expected.inbox.pendingDecision.issue_no_workspace.slice().sort(), 'WB-5 has no workspace');
    assert.deepEqual((data.todos || []).map((todo) => todo.issueId).slice().sort(), expected.inbox.todos.slice().sort(), 'TODO records stay out of the decision count');
    assert.deepEqual(data.counts, {
      pendingReviewUnits: 0, pendingWrapupUnits: 0, pendingSuggestionUnits: 0, pendingTerminalReviews: 1, pendingDecisions: 2, todoCount: 2,
    }, 'inbox counts use the same口径 as the snapshot counters');
    assert.deepEqual((data.wrapupUnits || []).map((unit) => unit.unitId), [], 'no unit is waiting for a wrap-up in this fixture');
    const snapshot = await host.get('/workbench/api/snapshot');
    assert.equal(snapshot.body.data.counters.pendingWrapupUnits, 0, 'the snapshot uses the same口径');
  });

  it('R1 holds on the fixture: WB-3 already has a running unit', async () => {
    const blocked = await host.command('unit.claim', { issueId: 'WB-3', sessionId: 'session-extra', cwd: '/tmp/wb-fixture/projA' });
    assert.equal(blocked.status, 409, 'a second active unit on WB-3 must be refused');
    assert.equal(blocked.body.error.code, 'E_CONFLICT');
  });
});