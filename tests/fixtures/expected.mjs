#!/usr/bin/env node
/**
 * Expected values for tests/fixtures/seed-2p6i.json — the single source of truth
 * for phase-3 acceptance and regression checks.
 *
 * Two duties:
 *  1) loadSeed(homeDir)  -> install the fixture as the plugin's document.
 *  2) --check            -> validate the fixture's invariants AND recompute every
 *                           documented expectation, comparing it with the frozen
 *                           table below (a drift guard: change the seed and this
 *                           fails until the table is updated deliberately).
 *
 * Derivations here are intentionally independent from host/service/queries.js:
 * expectations must not follow the implementation they are meant to police.
 *
 * Usage: node tests/fixtures/expected.mjs [--check] [--json]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = join(HERE, 'seed-2p6i.json');
/** Canonical workspace path stored inside the fixture. */
export const FIXTURE_WS_A = '/tmp/wb-fixture/projA';
/** Fixed evaluation instant: right after the last fixture activity. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);

const activeStatuses = ['todo', 'in_progress', 'blocked', 'in_review'];
const isVoided = (unit) => unit.voided === true;
const live = (units) => units.filter((unit) => !isVoided(unit));
const unitsOf = (doc, issueId) => doc.units.filter((unit) => unit.issueId === issueId);
const isTerminal = (status) => status === 'done' || status === 'cancelled';

/** Independent derivation of every number TEST-PLAN §8.1 promises. */
export function computeExpected(doc, options = {}) {
  const nowMs = options.nowMs === undefined ? FIXTURE_NOW_MS : options.nowMs;
  // A seeded document has no live session facts, so the default scenario has zero
  // unassigned running sessions; phase-3 adds one real session and re-checks with 1.
  const unassignedRunningSessions = options.unassignedRunningSessions === undefined ? 0 : options.unassignedRunningSessions;

  const triaged = doc.issues.filter((issue) => issue.isTriaged === true && !issue.archivedAt);
  const todos = doc.issues.filter((issue) => issue.isTriaged !== true && !issue.archivedAt);

  const projects = doc.projects
    .filter((project) => !project.archivedAt)
    .map((project) => {
      const issues = triaged.filter((issue) => issue.projectId === project.projectId);
      const units = issues.flatMap((issue) => live(unitsOf(doc, issue.issueId)));
      return {
        projectId: project.projectId,
        name: project.name,
        defaultWorkspacePath: project.defaultWorkspacePath,
        progress: { passed: units.filter((unit) => unit.acceptState === 'passed').length, total: units.length },
        issueCount: issues.length,
      };
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name), 'zh'));

  const allLiveUnits = triaged.flatMap((issue) => live(unitsOf(doc, issue.issueId)));
  const pendingReviewUnits = allLiveUnits.filter((unit) => unit.execState === 'ended' && unit.acceptState === 'pending');
  const failedUnits = allLiveUnits.filter((unit) => unit.execState === 'failed');
  const terminalReviews = triaged
    .filter((issue) => issue.status === 'in_review')
    .filter((issue) => {
      const units = live(unitsOf(doc, issue.issueId));
      return !units.some((unit) => unit.acceptState === 'pending') && !units.some((unit) => unit.execState === 'pending' || unit.execState === 'running');
    })
    .map((issue) => ({
      issueId: issue.issueId,
      unmet: (issue.acceptanceCriteria || []).filter((criterion) => criterion.done !== true).length,
    }));

  const withoutWorkspace = triaged.filter((issue) => !isTerminal(issue.status) && !issue.workspacePath).map((issue) => issue.issueId);
  const lastTouchMs = (issue) => {
    const times = [issue.createdAt, issue.updatedAt, ...unitsOf(doc, issue.issueId).map((unit) => unit.endedAt || unit.createdAt)];
    return Math.max(...times.filter(Boolean).map((value) => Date.parse(value)));
  };
  const zombies = triaged
    .filter((issue) => issue.status === 'in_progress')
    .filter((issue) => live(unitsOf(doc, issue.issueId)).every((unit) => !(unit.execState === 'pending' || unit.execState === 'running' || unit.acceptState === 'pending')))
    .filter((issue) => nowMs - lastTouchMs(issue) > 24 * 60 * 60 * 1000)
    .map((issue) => issue.issueId);

  const board = {};
  for (const status of activeStatuses) board[status] = triaged.filter((issue) => issue.status === status).length;

  const runningUnits = allLiveUnits.filter((unit) => unit.execState === 'pending' || unit.execState === 'running');

  return {
    projects,
    board,
    counters: {
      running: runningUnits.length + unassignedRunningSessions,
      pendingReviewUnits: pendingReviewUnits.length,
      pendingTerminalReviews: terminalReviews.length,
      pendingDecisions: failedUnits.length + withoutWorkspace.length + zombies.length,
      todoCount: todos.length,
      unassignedSessions: unassignedRunningSessions,
    },
    inbox: {
      pendingReviewUnits: pendingReviewUnits.map((unit) => unit.unitId),
      terminalReviews,
      pendingDecision: {
        unit_abnormal: failedUnits.map((unit) => unit.unitId),
        issue_no_workspace: withoutWorkspace,
        issue_zombie: zombies,
      },
      todos: todos.map((issue) => issue.issueId),
    },
  };
}

/**
 * The frozen table. Update ONLY together with a deliberate fixture change.
 * Values are exactly the ones documented in TEST-PLAN §8.1.
 */
export const FROZEN = {
  projects: [
    { projectId: 'p1', name: 'P1 工作台核心', defaultWorkspacePath: FIXTURE_WS_A, progress: { passed: 3, total: 5 }, issueCount: 4 },
    { projectId: 'p2', name: 'P2 收尾项目', defaultWorkspacePath: null, progress: { passed: 0, total: 0 }, issueCount: 2 },
  ],
  board: { todo: 1, in_progress: 1, blocked: 1, in_review: 1 },
  counters: {
    running: 1, pendingReviewUnits: 0, pendingTerminalReviews: 1,
    pendingDecisions: 2, todoCount: 2, unassignedSessions: 0,
  },
  inbox: {
    pendingReviewUnits: [],
    terminalReviews: [{ issueId: 'WB-2', unmet: 2 }],
    pendingDecision: { unit_abnormal: ['u06'], issue_no_workspace: ['WB-5'], issue_zombie: [] },
    todos: ['WB-7', 'WB-8'],
  },
};

/**
 * Phase-3 adds one real, running, unassigned session; the document-only numbers
 * above then shift by exactly +1 running (n = 2/3). Verified against FROZEN too.
 */
export const FROZEN_SCENARIO = { unassignedRunningSessions: 1, counters: { running: 2, unassignedSessions: 1 } };

/** Invariants the fixture itself must satisfy (DATA-MODEL §2/§3). */
export function validateSeed(doc) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };
  expect(doc.schemaVersion === 1, 'schemaVersion must be 1');
  expect(Number.isInteger(doc.meta && doc.meta.rev), 'meta.rev must be an integer');
  for (const key of ['projects', 'issues', 'units', 'decisions']) expect(Array.isArray(doc[key]), key + ' must be an array');

  const issueIds = new Set(doc.issues.map((issue) => issue.issueId));
  expect(issueIds.size === doc.issues.length, 'issueId must be unique');
  const sessionIds = doc.units.map((unit) => unit.sessionId).filter(Boolean);
  expect(new Set(sessionIds).size === sessionIds.length, 'unit.sessionId must be globally unique (C1)');
  for (const unit of doc.units) {
    expect(issueIds.has(unit.issueId), 'unit ' + unit.unitId + ' points at a missing issue');
    if (unit.voided === true) expect(Boolean(unit.closeReason), 'voided unit ' + unit.unitId + ' needs closeReason');
    if (unit.execState === 'ended' || unit.execState === 'failed') expect(Boolean(unit.exitReason), 'finished unit ' + unit.unitId + ' needs exitReason');
  }
  for (const issue of doc.issues) {
    if (issue.isTriaged === true) {
      expect(Boolean(issue.projectId), 'triaged issue ' + issue.issueId + ' needs a project (C12)');
      expect((issue.acceptanceCriteria || []).length >= 1, 'triaged issue ' + issue.issueId + ' needs >=1 criterion');
      expect((issue.acceptanceCriteria || []).length <= 20, 'issue ' + issue.issueId + ' exceeds 20 criteria');
    }
    const seqs = (issue.activities || []).map((activity) => activity.seq);
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), 'activities of ' + issue.issueId + ' must ascend by seq');
  }
  for (const project of doc.projects) expect(!project.archivedAt, 'fixture must not contain archived projects');
  return problems;
}

/** Install the fixture into a DSH home so the plugin loads it at boot. */
export function loadSeed(homeDir, options = {}) {
  const workspaceRoot = options.workspaceRoot === undefined ? FIXTURE_WS_A : options.workspaceRoot;
  const target = join(homeDir, 'workbench', 'workbench.json');
  mkdirSync(dirname(target), { recursive: true });
  if (workspaceRoot === FIXTURE_WS_A) {
    mkdirSync(FIXTURE_WS_A, { recursive: true });
    copyFileSync(SEED_PATH, target);
    return target;
  }
  const doc = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const rewrite = (value) => (typeof value === 'string' ? value.split(FIXTURE_WS_A).join(workspaceRoot) : value);
  mkdirSync(workspaceRoot, { recursive: true });
  for (const project of doc.projects) project.defaultWorkspacePath = rewrite(project.defaultWorkspacePath);
  for (const issue of doc.issues) {
    issue.workspacePath = rewrite(issue.workspacePath);
    for (const unit of doc.units) if (unit.issueId === issue.issueId) unit.goal = rewrite(unit.goal);
  }
  writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
  return target;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const doc = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const problems = validateSeed(doc);
  const actual = computeExpected(doc);
  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify(actual, null, 2));
  } else {
    console.log('fixture: ' + SEED_PATH);
    console.log('projects  ' + actual.projects.map((p) => p.projectId + ' ' + p.progress.passed + '/' + p.progress.total + ' (' + p.issueCount + ' issues)').join(' | '));
    console.log('board     ' + JSON.stringify(actual.board));
    console.log('counters  ' + JSON.stringify(actual.counters));
    console.log('decisions ' + JSON.stringify(actual.inbox.pendingDecision));
  }

  let failed = 0;
  for (const problem of problems) { console.log('FAIL  invariant: ' + problem); failed += 1; }
  const compare = (label, got, want) => {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a === b) { console.log('PASS  ' + label); return; }
    console.log('FAIL  ' + label + '\n        actual   ' + a + '\n        expected ' + b);
    failed += 1;
  };
  if (!process.argv.includes('--no-compare')) {
    compare('projects progress', actual.projects, FROZEN.projects);
    compare('board columns', actual.board, FROZEN.board);
    compare('counters', actual.counters, FROZEN.counters);
    compare('inbox', actual.inbox, FROZEN.inbox);
    const withSession = computeExpected(doc, { unassignedRunningSessions: FROZEN_SCENARIO.unassignedRunningSessions });
    compare('scenario counters (1 unassigned running session)', {
      running: withSession.counters.running, unassignedSessions: withSession.counters.unassignedSessions,
    }, FROZEN_SCENARIO.counters);
  }
  console.log(failed === 0 ? 'EXPECTED: OK' : 'EXPECTED: ' + failed + ' problem(s)');
  process.exit(failed === 0 ? 0 : 1);
}