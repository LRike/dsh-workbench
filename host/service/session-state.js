/**
 * Session fact -> unit state. Pure: takes the draft document plus one session
 * event, applies the DATA-MODEL mapping table, and lets the three automatic
 * moments write the issue status through the shared gate.
 *
 * Unit/round model (docs/design/unit-round-model.md): a unit is the SESSION
 * container, a turn is one round-trip inside it. turn/end therefore only
 * accumulates round bookkeeping — it must never end the unit, and it must
 * never push the issue into review. Ending a unit is an explicit action
 * (unit.wrapup), or the session disappearing (-> wrapping, which still needs
 * a human to wrap up).
 */
import { unitsOf, applyAutoStatus, pushActivity } from '../domain/rules.js';

const iso = (value) => (typeof value === 'string' && value.length > 0 ? value : new Date().toISOString());

/** Round records are a rolling window; turnCount keeps the true total. */
const MAX_TURNS = 50;

function turnsOf(unit) {
  if (!Array.isArray(unit.turns)) unit.turns = [];
  if (typeof unit.turnCount !== 'number' || !Number.isFinite(unit.turnCount)) unit.turnCount = 0;
  return unit.turns;
}

/** Start (or resume) the round record for this unit. */
function openTurn(unit, at) {
  const turns = turnsOf(unit);
  const alreadyOpen = turns.find((turn) => !turn.endedAt);
  if (alreadyOpen) return alreadyOpen;
  const turn = { turnNo: unit.turnCount + 1, startedAt: at, endedAt: null, note: null };
  turns.push(turn);
  return turn;
}

/**
 * Close the round record that is actually open, if any. Used by explicit actions
 * (wrap-up / void): they must NEVER fabricate a round, otherwise a wrap-up after
 * a finished round would silently inflate turnCount.
 */
export function closeOpenTurn(unit, at, note) {
  const turns = turnsOf(unit);
  const open = turns.find((item) => !item.endedAt);
  if (!open) return null;
  open.endedAt = at;
  if (note) open.note = note;
  unit.turnCount = Math.max(unit.turnCount, open.turnNo);
  if (turns.length > MAX_TURNS) unit.turns = turns.slice(-MAX_TURNS);
  return open;
}

function closeTurn(unit, at, note) {
  const turns = turnsOf(unit);
  let turn = turns.find((item) => !item.endedAt);
  if (!turn) {
    turn = { turnNo: unit.turnCount + 1, startedAt: at, endedAt: null, note: null };
    turns.push(turn);
  }
  turn.endedAt = at;
  if (note) turn.note = note;
  unit.turnCount = Math.max(unit.turnCount, turn.turnNo);
  if (turns.length > MAX_TURNS) unit.turns = turns.slice(-MAX_TURNS);
  return turn;
}

function findUnit(doc, sessionId) {
  if (!sessionId) return undefined;
  return doc.units.find((unit) => unit.sessionId === sessionId && unit.voided !== true);
}

function markActivity(doc, issue, actor, type, label, data, at) {
  pushActivity(doc.meta, issue, { at, actor, type, text: label, data });
}

/**
 * @param {any} doc
 * @param {{sessionId: string, kind: string, reason?: any, at?: string}} event
 * @param {string} now
 * @returns {{handled: boolean, unitId?: string, execState?: string, issueStatus?: string, reason?: string}}
 */
export function ingestSessionEvent(doc, event, now) {
  const at = iso(event.at || now);
  const unit = findUnit(doc, event.sessionId);
  if (!unit) return { handled: false, reason: 'no-unit' };
  const issue = doc.issues.find((item) => item.issueId === unit.issueId);
  if (!issue) return { handled: false, reason: 'no-issue' };

  if (event.kind === 'created' || event.kind === 'turn/start' || event.kind === 'heartbeat') {
    if (unit.execState === 'pending') unit.execState = 'running';
    else if (unit.execState === 'wrapping') unit.execState = 'running';
    if (unit.execState === 'running') {
      openTurn(unit, at);
      unit.startedAt = unit.startedAt || at;
      // New work means the AI's earlier "let's wrap up" is stale.
      unit.wrapUpSuggestion = null;
    }
    unit.lastEventAt = at;
    unit.updatedAt = at;
    if (unit.execState === 'running') {
      applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'in_progress', unit.unitId, { at, text: '会话开始执行' });
    }
    return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
  }

  if (event.kind === 'turn/end') {
    const reason = event.reason && typeof event.reason === 'object' ? event.reason : { kind: 'completed' };
    const cause = reason.reason && typeof reason.reason === 'object' ? reason.reason.kind : reason.reason;
    unit.lastEventAt = at;
    unit.updatedAt = at;

    if (reason.kind === 'completed') {
      if (unit.execState === 'pending') unit.execState = 'running';
      closeTurn(unit, at, null);
      return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
    }

    if (reason.kind === 'aborted' && cause === 'user') {
      if (unit.execState === 'pending') unit.execState = 'running';
      if (unit.execState === 'wrapping') unit.execState = 'running';
      closeTurn(unit, at, 'aborted');
      return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
    }

    closeTurn(unit, at, reason.kind === 'max-tokens' ? 'error' : String(cause || reason.kind || 'interrupted'));
    unit.execState = 'failed';
    unit.exitReason = reason.kind === 'error' || reason.kind === 'max-tokens' ? 'error' : 'interrupted';
    unit.endedAt = at;
    markActivity(doc, issue, 'system', 'unit.abnormal', '第 ' + unit.roundNo + ' 号单元异常结束（' + unit.exitReason + '）', { unitId: unit.unitId, exitReason: unit.exitReason }, at);
    applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'blocked', unit.unitId, { at, text: '第 ' + unit.roundNo + ' 号单元异常结束，进入遇到阻碍' });
    return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
  }

  if (event.kind === 'session/disposed' || event.kind === 'agent/status') {
    if (event.kind === 'agent/status') {
      unit.lastEventAt = at;
      unit.updatedAt = at;
      return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
    }
    if (unit.execState === 'running' || unit.execState === 'pending') {
      closeTurn(unit, at, 'session-closed');
      unit.execState = 'wrapping';
      unit.exitReason = 'session-closed';
      unit.endedAt = at;
      unit.updatedAt = at;
      markActivity(doc, issue, 'system', 'unit.wrapping', '会话已结束，第 ' + unit.roundNo + ' 号单元待收尾', { unitId: unit.unitId, exitReason: unit.exitReason }, at);
    }
    return { handled: true, unitId: unit.unitId, execState: unit.execState, issueStatus: issue.status };
  }

  return { handled: false, reason: 'unknown-kind' };
}

/**
 * Startup reconciliation: units that claim to be running but whose session is
 * gone or idle are corrected from the session list (the only source of truth
 * that survives a host restart). An idle session is NOT a finished unit any
 * more: it only means nobody is talking right now, so it moves to 待收尾.
 */
export function reconcileWithSessions(doc, rows, now) {
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  const corrections = [];
  for (const unit of doc.units) {
    if (unit.voided === true || !unit.sessionId) continue;
    if (unit.execState !== 'running' && unit.execState !== 'pending') continue;
    const row = byId.get(unit.sessionId);
    const issue = doc.issues.find((item) => item.issueId === unit.issueId);
    if (!issue) continue;
    if (!row) {
      closeTurn(unit, now, 'session-missing');
      unit.execState = 'failed';
      unit.exitReason = 'interrupted';
      unit.endedAt = now;
      unit.updatedAt = now;
      corrections.push({ unitId: unit.unitId, from: 'running', to: 'failed', reason: 'session-missing' });
      applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'blocked', unit.unitId, { at: now, text: '重启对账：会话已不存在，标记异常' });
    } else if (row.running !== true) {
      closeTurn(unit, now, 'session-idle');
      unit.execState = 'wrapping';
      unit.exitReason = 'session-idle';
      unit.endedAt = now;
      unit.updatedAt = now;
      corrections.push({ unitId: unit.unitId, from: 'running', to: 'wrapping', reason: 'session-idle' });
      markActivity(doc, issue, 'system', 'unit.wrapping', '重启对账：会话已空闲，第 ' + unit.roundNo + ' 号单元待收尾', { unitId: unit.unitId, exitReason: unit.exitReason }, now);
    }
  }
  return corrections;
}
