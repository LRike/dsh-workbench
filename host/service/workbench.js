/**
 * Workbench service: the single entry point for reads and writes.
 * Reads are derivations over the in-memory document; writes are serialized,
 * de-duplicated by clientRequestId, validated by command handlers, and persisted
 * before they resolve. Multi-phase commands then perform their DSH calls.
 */
import { createCoreCommands } from './commands-core.js';
import { createUnitCommands } from './commands-units.js';
import { existsSync } from 'node:fs';
import { buildSnapshot, buildInbox, buildBoard, buildIssueDetail, buildSearch, buildActivityPage, buildProjectDetail, buildArchived } from './queries.js';
import { ingestSessionEvent, reconcileWithSessions } from './session-state.js';
import { pruneDerivedDecisions } from '../domain/decisions-gc.js';
import { API_VERSION } from '../util/constants.js';

export class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

const IDEMPOTENCY_LIMIT = 200;

export function createService(options) {
  const repository = options.repository;
  const logger = options.logger;
  const ports = options.ports || {};
  const diagnostics = options.diagnostics || { toolsRegistered: false, toolNames: [] };
  const clock = options.clock || { now: () => new Date().toISOString(), nowMs: () => Date.now() };
  // A document written by a newer plugin version makes every read and write fail
  // with E_SCHEMA_TOO_NEW instead of silently serving an empty store.
  const storeProblem = typeof options.storeProblem === 'function' ? options.storeProblem : () => null;
  const assertStoreUsable = () => {
    const problem = storeProblem();
    if (problem) throw new ServiceError('E_SCHEMA_TOO_NEW', problem);
  };
  const commands = { ...createCoreCommands(), ...createUnitCommands() };
  const idempotent = new Map();
  let queue = Promise.resolve();
  // Latest count of running, unattributed sessions (R4 includes them).
  let lastRunningUnbound = 0;
  /** Session ids known to exist in the shell; null until the host has a snapshot. */
  let lastLiveSessionIds = null;

  const warn = (message) => { try { logger && logger.warn && logger.warn('workbench: ' + message); } catch {} };

  async function sessionContext() {
    if (!ports.sessions || typeof ports.sessions.list !== 'function') return { unassignedSessions: [], rows: [] };
    try {
      const rows = await ports.sessions.list();
      const bound = new Set(repository.document.units.map((u) => u.sessionId).filter(Boolean));
      const nowMs = clock.nowMs();
      const unassignedSessions = rows.filter((row) => !bound.has(row.sessionId) && (row.running || (row.endedAt && nowMs - Date.parse(row.endedAt) < 24 * 3600 * 1000 && row.hasOutput)))
        .map((row) => ({ sessionId: row.sessionId, cwd: row.cwd || null, running: Boolean(row.running), endedAt: row.endedAt || null, title: row.title || null }));
      lastRunningUnbound = unassignedSessions.filter((row) => row.running).length;
      return { unassignedSessions, rows };
    } catch (error) {
      warn('session context failed: ' + String(error));
      return { unassignedSessions: [], rows: [] };
    }
  }

  async function snapshot() {
    assertStoreUsable();
    repository.refresh();
    const context = await sessionContext();
    return { version: repository.rev, ...buildSnapshot(repository.document, { nowMs: clock.nowMs(), dirExists: existsSync, ...context }) };
  }

  async function inbox() {
    assertStoreUsable();
    repository.refresh();
    const context = await sessionContext();
    return { version: repository.rev, ...buildInbox(repository.document, clock.nowMs()), unassignedSessions: context.unassignedSessions };
  }

  function board() {
    assertStoreUsable();
    repository.refresh();
    return { version: repository.rev, ...buildBoard(repository.document) };
  }

  function issueDetail(idOrCode) {
    assertStoreUsable();
    repository.refresh();
    const detail = buildIssueDetail(repository.document, idOrCode, clock.nowMs(), { runningUnbound: lastRunningUnbound, liveSessionIds: lastLiveSessionIds });
    return detail === undefined ? undefined : { version: repository.rev, ...detail };
  }

  function search(query) {
    assertStoreUsable();
    repository.refresh();
    return { version: repository.rev, ...buildSearch(repository.document, query) };
  }

  function activity(issueId, before, limit) {
    assertStoreUsable();
    repository.refresh();
    return { version: repository.rev, ...buildActivityPage(repository.document, issueId, before, limit) };
  }

  async function workspaces() {
    assertStoreUsable();
    if (!ports.sessions || typeof ports.sessions.listWorkspaces !== 'function') return { version: repository.rev, workspaces: [] };
    try { return { version: repository.rev, workspaces: await ports.sessions.listWorkspaces() }; }
    catch (error) { warn('workspace listing failed: ' + String(error)); return { version: repository.rev, workspaces: [] }; }
  }

  function archived() {
    assertStoreUsable();
    repository.refresh();
    return { version: repository.rev, ...buildArchived(repository.document) };
  }

  function projectDetail(projectId) {
    assertStoreUsable();
    repository.refresh();
    const detail = buildProjectDetail(repository.document, projectId);
    return detail === undefined ? undefined : { version: repository.rev, ...detail };
  }

  function execute(command) {
    const run = async () => {
      const requestId = command && command.clientRequestId;
      if (requestId && idempotent.has(requestId)) return idempotent.get(requestId);
      const result = await dispatch(command || {});
      if (requestId) {
        idempotent.set(requestId, result);
        if (idempotent.size > IDEMPOTENCY_LIMIT) idempotent.delete(idempotent.keys().next().value);
      }
      return result;
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function dispatch(command) {
    const type = command.type;
    if (typeof type !== 'string' || type.length === 0) throw new ServiceError('E_BAD_REQUEST', 'command.type is required');
    assertStoreUsable();
    const handler = commands[type];
    if (!handler) throw new ServiceError('E_NOT_FOUND', 'unknown command ' + type);
    let payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
    // C2: the session's cwd is a host fact, not a client claim. Resolve it before
    // validation when the caller omitted it (and derive the ended flag the same way).
    if (type === 'unit.claim' && ports.sessions && typeof ports.sessions.list === 'function' && payload.cwd === undefined) {
      try {
        const rows = await ports.sessions.list();
        const row = rows.find((item) => item.sessionId === payload.sessionId);
        if (!row) throw new ServiceError('E_NOT_FOUND', 'session not found: ' + String(payload.sessionId));
        payload = { ...payload, cwd: row.cwd || undefined, sessionEnded: row.running !== true };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        warn('claim cwd resolution failed: ' + String(error));
      }
    }
    const result = repository.mutate((doc) => {
      const value = handler({ payload, doc, now: clock.now(), nowMs: clock.nowMs(), ports });
      // B4/W2: prune derived decision records whose condition no longer holds.
      pruneDerivedDecisions(doc, clock.nowMs());
      return value;
    });
    await afterMutate(type, result);
    return { result, version: repository.rev };
  }

  async function afterMutate(type, result) {
    if (!result || typeof result !== 'object') return;
    if (result.mode === 'ai' && result.sessionId && result.workspacePath) await startSession(result);
    if (result.notifySession && result.notifySession.sessionId && typeof result.notifySession.text === 'string') {
      try { await ports.sessions.sendMessage(result.notifySession.sessionId, result.notifySession.text); }
      catch (error) { warn('wrap-up request delivery failed: ' + String(error)); }
    }
    if (result.sendToSession === true && result.unitId) {
      try {
        const unit = repository.document.units.find((u) => u.unitId === result.unitId);
        if (unit && unit.sessionId) await ports.sessions.sendMessage(unit.sessionId, '关于你的决策请求 ' + result.decisionId + '，我的选择是：' + JSON.stringify(result.answer));
      } catch (error) { warn('decision send-to-session failed: ' + String(error)); }
    }
    void type;
  }

  async function startSession(plan) {
    if (!ports.sessions || typeof ports.sessions.startRound !== 'function') {
      markSetupFailed(plan.unitId, 'create_failed', 'session gateway unavailable');
      return;
    }
    try {
      const created = await ports.sessions.startRound({ workspacePath: plan.workspacePath, sessionId: plan.sessionId, title: plan.title, prompt: plan.prompt });
      repository.mutate((doc) => {
        const unit = doc.units.find((u) => u.unitId === plan.unitId);
        if (!unit) return null;
        unit.setupIssue = null;
        unit.execState = 'running';
        unit.startedAt = unit.startedAt || clock.now();
        unit.updatedAt = clock.now();
        return null;
      });
      warn('session started for unit ' + plan.unitId + ' (' + created.sessionId + ')');
    } catch (error) {
      const phase = error && error.phase === 'prompt' ? 'prompt_failed' : 'create_failed';
      markSetupFailed(plan.unitId, phase, String(error && error.message ? error.message : error));
    }
  }

  function markSetupFailed(unitId, setupIssue, message) {
    try {
      repository.mutate((doc) => {
        const unit = doc.units.find((u) => u.unitId === unitId);
        if (!unit) return null;
        unit.setupIssue = setupIssue;
        unit.updatedAt = clock.now();
        const issue = doc.issues.find((i) => i.issueId === unit.issueId);
        if (issue) {
          const seq = doc.meta.nextActivitySeq++;
          issue.activities.push({ seq, at: clock.now(), actor: 'system', type: 'unit.setup_failed', text: (setupIssue === 'create_failed' ? '建会话失败：' : '首条指令发送失败：') + message, data: { unitId, setupIssue } });
        }
        return null;
      });
    } catch (error) { warn('could not record setup failure: ' + String(error)); }
  }

  /** One normalized session event (watcher and test seams share this path). */
  async function ingestSession(event) {
    if (!event || !event.sessionId) throw new ServiceError('E_BAD_REQUEST', 'sessionId is required');
    const result = repository.mutate((doc) => ingestSessionEvent(doc, event, clock.now()));
    return { result, version: repository.rev };
  }

  /** Startup reconciliation against the session list (survives host restarts). */
  async function reconcile(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { corrections: [], version: repository.rev };
    lastLiveSessionIds = rows.map((row) => row && row.sessionId).filter((id) => typeof id === 'string');
    const corrections = repository.mutate((doc) => reconcileWithSessions(doc, rows, clock.now()));
    return { corrections, version: repository.rev };
  }

  const seamsEnabled = process.env.WORKBENCH_TEST_SEAMS === '1';
  async function executeTest(command) {
    if (!seamsEnabled) throw new ServiceError('E_NOT_FOUND', 'unknown command ' + String(command && command.type));
    const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
    if (command.type === 'test.setClock') {
      if (typeof clock.setClock !== 'function') throw new ServiceError('E_INTERNAL', 'clock is not adjustable');
      clock.setClock(payload.nowMs);
      return { result: { nowMs: clock.nowMs() }, version: repository.rev };
    }
    if (command.type === 'test.advanceClock') {
      if (typeof clock.advance !== 'function') throw new ServiceError('E_INTERNAL', 'clock is not adjustable');
      clock.advance(payload.ms);
      return { result: { nowMs: clock.nowMs() }, version: repository.rev };
    }
    if (command.type === 'test.diagnostics') {
      return { result: { toolsRegistered: diagnostics.toolsRegistered, toolNames: diagnostics.toolNames.slice(), version: repository.rev }, version: repository.rev };
    }
    if (command.type === 'test.sessionEvent') {
      return ingestSession({ sessionId: payload.sessionId, kind: payload.kind, reason: payload.reason, at: payload.at });
    }
    throw new ServiceError('E_NOT_FOUND', 'unknown test command ' + String(command.type));
  }

  return {
    apiVersion: API_VERSION,
    snapshot, inbox, board, issueDetail, search, activity, projectDetail, workspaces, archived, execute, executeTest,
    ingestSessionEvent: ingestSession, reconcile,
    testSeamsEnabled: seamsEnabled,
    version: () => repository.rev,
    dispose: async () => { await queue.catch(() => undefined); },
  };
}
