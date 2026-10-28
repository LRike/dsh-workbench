/**
 * Unit and pending-decision commands: claim, start a round, accept/reject,
 * handover, void, and the four kinds of pending decisions.
 *
 * Multi-phase commands (AI start / retry) stop after writing the pending unit and
 * return a session plan; the service performs the DSH calls and records failure.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { badRequest, notFound, conflict, invalidState } from '../domain/errors.js';
import {
  pushActivity, applyAutoStatus, unitsOf, liveUnits, activeUnits, closing, terminalReview,
  autoWriteAllowed, r4Count, projectArchived,
} from '../domain/rules.js';
import { newUnitId, newSessionId, newDecisionId } from '../domain/ids.js';
import { closeOpenTurn } from './session-state.js';

const MAX_TEXT = 2000;
/** Sent to a unit's own session when the human decides to end that unit. */
const WRAP_SUMMARY_REQUEST = '本单元到此为止，请写收尾交接：改动 / 验证 / 结果 / 剩余风险。用 workbench_write_handoff 写入工作台，四段都要非空；不要自己结束单元，收尾由人确认。';
const text = (value) => (typeof value === 'string' ? value : '');
const requireText = (value, field, max) => {
  const trimmed = text(value).trim();
  if (trimmed.length === 0) throw badRequest(field + ' is required', { field });
  if (trimmed.length > max) throw badRequest(field + ' is longer than ' + max + ' characters', { field });
  return trimmed;
};

const requireIssue = (doc, issueId) => {
  const issue = doc.issues.find((i) => i.issueId === issueId);
  if (!issue) throw notFound('issue not found: ' + String(issueId), { issueId });
  return issue;
};
const requireUnit = (doc, unitId) => {
  const unit = doc.units.find((u) => u.unitId === unitId);
  if (!unit) throw notFound('unit not found: ' + String(unitId), { unitId });
  return unit;
};
const requireTriaged = (issue) => {
  if (issue.isTriaged !== true) throw invalidState('triage is required before units', { issueId: issue.issueId });
  return issue;
};

const activity = (doc, issue, actor, type, label, data, at) => pushActivity(doc.meta, issue, { at, actor, type, text: label, data });

function roundNumber(doc, issueId) {
  const rounds = unitsOf(doc, issueId).map((u) => u.roundNo || 0);
  return (rounds.length === 0 ? 0 : Math.max(...rounds)) + 1;
}

function assertCanStart(doc, issue, nowMs, ports) {
  requireTriaged(issue);
  if (issue.archivedAt) throw conflict('archived issues are read-only', { issueId: issue.issueId });
  if (closing(issue)) throw conflict('terminal issues cannot start a round', { issueId: issue.issueId, status: issue.status });
  if (!issue.workspacePath) throw conflict('issue has no workspace; assign one before starting (C3)', { issueId: issue.issueId });
  const units = unitsOf(doc, issue.issueId);
  const active = activeUnits(units);
  if (active.length > 0) throw conflict('this issue already has an active unit (R1)', { issueId: issue.issueId, unitId: active[0].unitId });
  // No global parallelism cap any more: the human decides what to run. R1 (one
  // active unit per issue) still applies, which is what actually protects work.
}

function newUnit(doc, issue, now, fields) {
  const unit = {
    unitId: newUnitId(),
    issueId: issue.issueId,
    roundNo: roundNumber(doc, issue.issueId),
    parentUnitId: fields.parentUnitId || null,
    goal: fields.goal,
    sessionId: fields.sessionId || null,
    execState: 'pending',
    acceptState: 'pending',
    turnCount: 0,
    turns: [],
    voided: false,
    exitReason: null,
    closeReason: null,
    setupIssue: null,
    handover: null,
    createdBy: fields.createdBy || 'human',
    startedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  doc.units.push(unit);
  activity(doc, issue, fields.createdBy === 'ai' ? 'ai' : 'human', 'unit.created', '新建第 ' + unit.roundNo + ' 轮单元：' + unit.goal, { unitId: unit.unitId, sessionId: unit.sessionId }, now);
  return unit;
}

function startPlan(doc, issue, unit, now) {
  applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'in_progress', unit.unitId, { at: now, text: '开始第 ' + unit.roundNo + ' 轮' });
  const sessionTitle = issue.issueId + ' · 第' + unit.roundNo + '轮 · ' + unit.goal;
  unit.sessionTitle = sessionTitle;
  return {
    unitId: unit.unitId,
    sessionId: unit.sessionId,
    roundNo: unit.roundNo,
    goal: unit.goal,
    workspacePath: issue.workspacePath,
    title: sessionTitle,
    prompt: buildStartPrompt(issue, unit),
    issueId: issue.issueId,
  };
}

function buildStartPrompt(issue, unit) {
  const lines = [];
  lines.push('你在做「' + issue.issueId + ' ' + issue.title + '」的第 ' + unit.roundNo + ' 轮。');
  if (unit.goal) lines.push('本轮目标：' + unit.goal);
  if (issue.description) lines.push('议题描述：' + issue.description.slice(0, 1200));
  if (Array.isArray(issue.acceptanceCriteria) && issue.acceptanceCriteria.length > 0) {
    lines.push('验收标准：');
    for (const criterion of issue.acceptanceCriteria) lines.push('- ' + (criterion.done ? '[x] ' : '[ ] ') + criterion.text);
  }
  lines.push('收尾由人发起：不要自己结束单元，也不要自行写交接；先把这一轮做扎实。');
  return lines.join('\n').slice(0, 4000);
}

export function createUnitCommands() {
  const commands = {
    'unit.claim': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireIssue(doc, payload.issueId));
      if (issue.archivedAt) throw conflict('archived issues are read-only', { issueId: issue.issueId });
      if (closing(issue)) throw conflict('terminal issues cannot accept units', { issueId: issue.issueId, status: issue.status });
      if (!issue.workspacePath) throw conflict('issue has no workspace', { issueId: issue.issueId });
      const sessionId = requireText(payload.sessionId, 'sessionId', 200);
      if (doc.units.some((u) => u.sessionId === sessionId)) throw conflict('session is already claimed by another unit (C1)', { sessionId });
      const active = activeUnits(unitsOf(doc, issue.issueId));
      if (active.length > 0) throw conflict('this issue already has an active unit (R1)', { issueId: issue.issueId, unitId: active[0].unitId });
      const canonical = (path) => { try { return realpathSync(path); } catch { return path; } };
      if (payload.cwd !== undefined && canonical(String(payload.cwd)) !== canonical(String(issue.workspacePath))) {
        throw conflict('session cwd does not match the issue workspace (C2)', { cwd: payload.cwd, workspacePath: issue.workspacePath });
      }
      const ended = payload.sessionEnded === true;
      const unit = newUnit(doc, issue, now, { goal: text(payload.goal).trim() || issue.title, sessionId, createdBy: 'human' });
      if (ended) {
        unit.execState = 'ended';
        unit.exitReason = 'normal';
        unit.endedAt = now;
        unit.startedAt = now;
        applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'in_review', unit.unitId, { at: now, text: '补挂已结束的会话' });
      } else {
        unit.execState = 'running';
        unit.startedAt = now;
        applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'in_progress', unit.unitId, { at: now, text: '认领会话' });
      }
      activity(doc, issue, 'human', 'unit.claimed', '认领会话第 ' + unit.roundNo + ' 轮', { unitId: unit.unitId, sessionId }, now);
      return { unitId: unit.unitId, roundNo: unit.roundNo, execState: unit.execState };
    },

    'unit.startRound': ({ payload, doc, now, nowMs }) => {
      const issue = requireTriaged(requireIssue(doc, payload.issueId));
      assertCanStart(doc, issue, nowMs, {});
      const mode = payload.mode === 'ai' ? 'ai' : 'me';
      const goal = text(payload.goal).trim() || issue.title;
      if (mode === 'me') {
        return {
          mode: 'me', issueId: issue.issueId, cwd: issue.workspacePath,
          promptSuggestion: '本轮目标：' + goal,
          note: '在新会话里使用「⊞ 认领」把它登记成单元',
        };
      }
      const unit = newUnit(doc, issue, now, { goal, sessionId: newSessionId(), createdBy: 'ai' });
      const plan = startPlan(doc, issue, unit, now);
      activity(doc, issue, 'ai', 'unit.started', 'AI 新建单元 · ' + unit.sessionId, { unitId: unit.unitId, sessionId: unit.sessionId }, now);
      return { mode: 'ai', ...plan };
    },

    'unit.retry': ({ payload, doc, now }) => {
      const failed = requireUnit(doc, payload.unitId);
      if (failed.execState !== 'failed' || failed.voided === true) throw invalidState('only a live abnormal unit can be retried', { unitId: failed.unitId, execState: failed.execState });
      const issue = requireTriaged(requireIssue(doc, failed.issueId));
      assertCanStart(doc, issue, 0, {});
      failed.voided = true;
      failed.closeReason = 'retried';
      failed.updatedAt = now;
      activity(doc, issue, 'human', 'unit.voided', '重试：作废第 ' + failed.roundNo + ' 轮', { unitId: failed.unitId, reason: 'retried' }, now);
      const unit = newUnit(doc, issue, now, {
        goal: text(payload.goal).trim() || failed.goal,
        sessionId: newSessionId(), createdBy: 'ai', parentUnitId: failed.unitId,
      });
      const plan = startPlan(doc, issue, unit, now);
      activity(doc, issue, 'ai', 'unit.started', 'AI 新建单元（重试第 ' + unit.roundNo + ' 轮）', { unitId: unit.unitId, sessionId: unit.sessionId }, now);
      return { mode: 'ai', retriedFrom: failed.unitId, ...plan };
    },

    'unit.suggestWrapup': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) throw invalidState('voided unit cannot be suggested for wrap-up', { unitId: unit.unitId });
      if (unit.execState !== 'running' && unit.execState !== 'wrapping') {
        throw invalidState('only a live unit can be suggested for wrap-up', { unitId: unit.unitId, execState: unit.execState });
      }
      const note = payload.note === undefined ? '' : String(payload.note).trim().slice(0, 500);
      unit.wrapUpSuggestion = { at: now, by: 'ai', note: note || null };
      unit.updatedAt = now;
      activity(doc, issue, 'ai', 'unit.wrapup_suggested', 'AI 建议收尾（第 ' + unit.roundNo + ' 号单元 · ' + (unit.turnCount || 0) + ' 轮）' + (note ? '：' + note : ''), { unitId: unit.unitId, note: note || null }, now);
      return { unitId: unit.unitId, wrapUpSuggestion: unit.wrapUpSuggestion, execState: unit.execState };
    },

    'unit.void': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) throw invalidState('unit is already voided', { unitId: unit.unitId });
      if (unit.execState === 'ended' && unit.acceptState === 'passed') throw invalidState('an accepted unit cannot be voided', { unitId: unit.unitId });
      closeOpenTurn(unit, now, 'voided');
      unit.voided = true;
      unit.closeReason = 'dismissed';
      unit.acceptState = 'pending';
      unit.updatedAt = now;
      issue.status = closing(issue) ? issue.status : 'todo';
      issue.statusPin = { at: now };
      issue.statusUndo = null;
      issue.updatedAt = now;
      const reason = payload.reason === undefined ? '' : String(payload.reason).trim().slice(0, 500);
      activity(doc, issue, 'human', 'unit.voided', '作废第 ' + unit.roundNo + ' 号单元' + (reason ? '：' + reason : ''), { unitId: unit.unitId, reason: reason || null }, now);
      return { unitId: unit.unitId, voided: true, issueStatus: issue.status };
    },

    'unit.wrapup': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) throw invalidState('voided unit cannot be wrapped up', { unitId: unit.unitId });
      if (unit.execState === 'ended') throw invalidState('unit is already wrapped up', { unitId: unit.unitId });
      if (unit.execState !== 'running' && unit.execState !== 'wrapping' && unit.execState !== 'pending') {
        throw invalidState('only a live unit can be wrapped up', { unitId: unit.unitId, execState: unit.execState });
      }
      // U3: review may never judge a unit that has no four-part handover.
      const incoming = payload.handover && typeof payload.handover === 'object' ? payload.handover : null;
      const base = incoming || unit.handover;
      if (!base) {
        // Step 1 of 2: the human says "this is over"; we ask THAT unit's session to
        // write the handover. The unit does not end here (U3 still holds).
        if (!unit.sessionId) {
          throw invalidState('this unit has no session to summarize; synthesize a draft instead (U3)', { unitId: unit.unitId });
        }
        unit.wrapRequest = { at: now, by: 'human', sessionId: unit.sessionId, prompt: WRAP_SUMMARY_REQUEST };
        unit.updatedAt = now;
        activity(doc, issue, 'human', 'unit.wrapup_requested', '请求 AI 总结第 ' + unit.roundNo + ' 号单元的交接', { unitId: unit.unitId }, now);
        return {
          unitId: unit.unitId,
          needsSummary: true,
          execState: unit.execState,
          notifySession: { sessionId: unit.sessionId, text: WRAP_SUMMARY_REQUEST },
        };
      }
      const source = payload.source === 'ai' ? 'ai' : (base.source === 'synthesized' ? 'synthesized' : 'human');
      const handover = {
        change: requireText(base.change, 'handover.change', MAX_TEXT),
        verify: requireText(base.verify, 'handover.verify', MAX_TEXT),
        result: requireText(base.result, 'handover.result', MAX_TEXT),
        risk: requireText(base.risk, 'handover.risk', MAX_TEXT),
        source,
        at: now,
        editedAt: unit.handover ? now : null,
      };
      closeOpenTurn(unit, now, 'wrapped');
      unit.wrapUpSuggestion = null;
      unit.wrapRequest = null;
      unit.handover = handover;
      unit.execState = 'ended';
      unit.acceptState = 'pending';
      unit.exitReason = 'normal';
      unit.endedAt = now;
      unit.wrapUp = { at: now, by: source === 'ai' ? 'ai' : 'human' };
      unit.needsHandoff = false;
      unit.updatedAt = now;
      activity(doc, issue, source === 'ai' ? 'ai' : 'human', 'unit.wrapped', '第 ' + unit.roundNo + ' 号单元收尾（' + unit.turnCount + ' 轮，四段交接）', { unitId: unit.unitId, turnCount: unit.turnCount, source }, now);
      applyAutoStatus(doc, issue, unitsOf(doc, issue.issueId), 'in_review', unit.unitId, { at: now, text: '第 ' + unit.roundNo + ' 号单元已收尾，进入等你确认' });
      return { unitId: unit.unitId, execState: unit.execState, acceptState: unit.acceptState, issueStatus: issue.status, terminalReview: terminalReview(issue, unitsOf(doc, issue.issueId)) };
    },

    'unit.accept': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) throw invalidState('voided unit cannot be accepted', { unitId: unit.unitId });
      if (unit.execState !== 'ended') throw invalidState('only an ended unit can be accepted', { unitId: unit.unitId, execState: unit.execState });
      if (unit.acceptState !== 'pending') throw invalidState('unit is not waiting for review', { unitId: unit.unitId, acceptState: unit.acceptState });
      // U3: never judge a unit that has nothing to judge (legacy units migrated
      // from the old model ended without a handover).
      if (unit.needsHandoff === true && !unit.handover) {
        throw invalidState('this unit has no handover yet; synthesize or write one before accepting (U3)', { unitId: unit.unitId, needsHandoff: true });
      }
      unit.acceptState = 'passed';
      unit.updatedAt = now;
      activity(doc, issue, 'human', 'unit.accepted', '通过第 ' + unit.roundNo + ' 轮', { unitId: unit.unitId }, now);
      return { unitId: unit.unitId, acceptState: 'passed', terminalReview: terminalReview(issue, unitsOf(doc, issue.issueId)) };
    },

    'unit.reject': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) throw invalidState('voided unit cannot be rejected', { unitId: unit.unitId });
      if (unit.execState !== 'ended') throw invalidState('only an ended unit can be rejected', { unitId: unit.unitId, execState: unit.execState });
      if (unit.acceptState !== 'pending') throw invalidState('unit is not waiting for review', { unitId: unit.unitId, acceptState: unit.acceptState });
      const reason = requireText(payload.reason, 'reason', MAX_TEXT);
      const sessionGone = payload.sessionUnavailable === true;
      if (sessionGone) {
        // Q4: the unit cannot continue without its session, so close it out and
        // let the human claim a fresh one (the round counter keeps going up).
        unit.voided = true;
        unit.closeReason = 'rejected';
        unit.acceptState = 'rejected';
        unit.updatedAt = now;
        issue.status = 'todo';
        issue.statusPin = { at: now };
        issue.statusUndo = null;
        issue.updatedAt = now;
        activity(doc, issue, 'human', 'unit.rejected', '打回第 ' + unit.roundNo + ' 号单元（会话已关闭，作废后重开）：' + reason, { unitId: unit.unitId, reason, sessionUnavailable: true }, now);
        return { unitId: unit.unitId, voided: true, issueStatus: 'todo', resumed: false };
      }
      // D-19: a rejection sends the SAME unit back to work, with the round counter
      // untouched, so the context and the round history stay intact.
      unit.acceptState = 'pending';
      unit.execState = 'running';
      unit.voided = false;
      unit.exitReason = null;
      unit.endedAt = null;
      unit.needsHandoff = false;
      unit.wrapUp = null;
      unit.updatedAt = now;
      issue.status = 'in_progress';
      // No pin: the same unit is still working, so wrap-up may move it back to review.
      issue.statusPin = null;
      issue.statusUndo = null;
      issue.updatedAt = now;
      activity(doc, issue, 'human', 'unit.rejected', '打回第 ' + unit.roundNo + ' 号单元（回到执行中继续）：' + reason, { unitId: unit.unitId, reason, turnCount: unit.turnCount }, now);
      return { unitId: unit.unitId, voided: false, execState: 'running', issueStatus: 'in_progress', resumed: true };
    },

    'unit.writeHandoff': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      const source = payload.source === 'ai' ? 'ai' : 'human';
      // U10: a finished issue is judged already; the AI rewriting its handover would
      // silently rewrite the evidence behind that judgement. Humans may still fix typos.
      if (source === 'ai' && unit.handover && unit.handover.source === 'human') {
        throw invalidState('the human already wrote this handover; AI will not overwrite it', { unitId: unit.unitId });
      }
      if (source === 'ai' && (closing(issue) || unit.acceptState === 'passed')) {
        throw invalidState('the issue is finished: AI may not rewrite the handover (U10)', { issueId: issue.issueId, status: issue.status, acceptState: unit.acceptState });
      }
      const handover = payload.handover || {};
      const next = {
        change: requireText(handover.change, 'change', MAX_TEXT),
        verify: requireText(handover.verify, 'verify', MAX_TEXT),
        result: requireText(handover.result, 'result', MAX_TEXT),
        risk: requireText(handover.risk, 'risk', MAX_TEXT),
        source,
        at: now,
        editedAt: unit.handover ? now : null,
      };
      unit.handover = next;
      unit.needsHandoff = false;
      unit.updatedAt = now;
      activity(doc, issue, source, 'unit.handover', '写入第 ' + unit.roundNo + ' 轮交接', { unitId: unit.unitId, source }, now);
      return { unitId: unit.unitId, source };
    },

    'unit.synthesizeHandoff': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.handover && unit.handover.source !== 'synthesized') throw conflict('a self-written handover is never overwritten', { unitId: unit.unitId });
      unit.handover = {
        change: '系统合成（待确认）：本轮目标「' + unit.goal + '」，会话 ' + (unit.sessionId || '无') + '。',
        verify: '系统合成（待确认）：未记录验证步骤；可在会话中查看工具调用与命令输出。',
        result: '系统合成（待确认）：退出原因 ' + (unit.exitReason || 'unknown') + '。',
        risk: '系统合成（待确认）：本轮没有自写交接，结论需人工复核。',
        source: 'synthesized',
        at: now,
        editedAt: null,
      };
      unit.needsHandoff = false;
      unit.updatedAt = now;
      activity(doc, issue, 'system', 'unit.handover', '合成第 ' + unit.roundNo + ' 轮交接草稿（系统合成，待确认）', { unitId: unit.unitId, source: 'synthesized' }, now);
      return { unitId: unit.unitId, source: 'synthesized' };
    },

    'unit.void': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.voided === true) return { unitId: unit.unitId, voided: true };
      const reason = payload.reason === undefined ? 'unbound' : requireText(payload.reason, 'reason', 500);
      unit.voided = true;
      unit.closeReason = reason === 'retried' ? 'retried' : 'unbound';
      unit.updatedAt = now;
      activity(doc, issue, 'human', 'unit.voided', '作废第 ' + unit.roundNo + ' 轮', { unitId: unit.unitId, reason: unit.closeReason }, now);
      const units = unitsOf(doc, issue.issueId);
      const anyActive = activeUnits(units).length > 0;
      const anyPassed = liveUnits(units).some((u) => u.acceptState === 'passed');
      if (issue.isTriaged && !closing(issue) && !issue.archivedAt && !anyActive && !autoWriteAllowed(doc, issue, units)) {
        // pinned or otherwise not auto-writable: leave the status to the human
      } else if (issue.isTriaged && !closing(issue) && !issue.archivedAt && !anyActive) {
        applyAutoStatus(doc, issue, units, anyPassed ? 'in_review' : 'todo', unit.unitId, { at: now, text: '单元作废后回收状态' });
      }
      return { unitId: unit.unitId, voided: true, issueStatus: issue.status };
    },

    'unit.setupFailed': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      const issueType = payload.setupIssue === 'prompt_failed' ? 'prompt_failed' : 'create_failed';
      unit.setupIssue = issueType;
      unit.updatedAt = now;
      activity(doc, issue, 'system', 'unit.setup_failed', issueType === 'create_failed' ? '建会话失败（可重试）' : '首条指令发送失败（可重发）', { unitId: unit.unitId, setupIssue: issueType }, now);
      return { unitId: unit.unitId, setupIssue: issueType };
    },

    'unit.clearSetupIssue': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      unit.setupIssue = null;
      unit.updatedAt = now;
      return { unitId: unit.unitId, setupIssue: null };
    },

    'ai.requestDecision': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      const reason = requireText(payload.reason, 'reason', 500);
      const options = Array.isArray(payload.options) ? payload.options : [];
      if (options.length < 2 || options.length > 3) throw badRequest('ai.requestDecision needs 2 to 3 options', { count: options.length });
      const normalized = options.map((option) => ({
        optionId: 'o_' + randomUUID().slice(0, 8),
        label: requireText(option && option.label, 'options[].label', 200),
        note: option && option.note !== undefined ? text(option.note).slice(0, 500) : null,
      }));
      for (const decision of doc.decisions) {
        if (decision.kind === 'ai_decision' && decision.unitId === unit.unitId && decision.status === 'open') {
          decision.status = 'superseded';
          decision.closedAt = now;
          decision.updatedAt = now;
          activity(doc, issue, 'ai', 'decision.superseded', '旧的决策请求被新请求取代', { decisionId: decision.decisionId }, now);
        }
      }
      const decision = {
        decisionId: newDecisionId(), kind: 'ai_decision', subjectRef: '', issueId: issue.issueId, unitId: unit.unitId,
        reason, options: normalized, status: 'open', answer: null, snoozeUntil: null, closedAt: null, createdAt: now, updatedAt: now,
      };
      decision.subjectRef = decision.decisionId;
      doc.decisions.push(decision);
      activity(doc, issue, 'ai', 'decision.asked', 'AI 请求决策：' + reason, { decisionId: decision.decisionId, kind: 'ai_decision' }, now);
      return { decisionId: decision.decisionId, options: normalized.map((o) => o.optionId) };
    },

    'decision.answer': ({ payload, doc, now }) => {
      const decision = doc.decisions.find((d) => d.decisionId === payload.decisionId);
      if (!decision) throw notFound('decision not found', { decisionId: payload.decisionId });
      if (decision.kind !== 'ai_decision') throw invalidState('only ai decisions are answered', { kind: decision.kind });
      if (decision.status !== 'open') throw conflict('decision is no longer open', { status: decision.status });
      const option = (decision.options || []).find((o) => o.optionId === payload.optionId);
      if (!option) throw badRequest('unknown optionId', { optionId: payload.optionId });
      decision.status = 'answered';
      decision.answer = { optionId: option.optionId, note: payload.note === undefined ? null : text(payload.note).slice(0, 500), decidedAt: now };
      decision.closedAt = now;
      decision.updatedAt = now;
      const issue = requireIssue(doc, decision.issueId);
      activity(doc, issue, 'human', 'decision.answered', '我答：' + option.label, { decisionId: decision.decisionId, optionId: option.optionId }, now);
      return { decisionId: decision.decisionId, status: 'answered', answer: decision.answer, sendToSession: payload.sendToSession === true, unitId: decision.unitId };
    },

    'decision.dismiss': ({ payload, doc, now }) => {
      const decision = doc.decisions.find((d) => d.decisionId === payload.decisionId);
      if (!decision) throw notFound('decision not found', { decisionId: payload.decisionId });
      if (decision.kind !== 'ai_decision') throw invalidState('derived decisions are closed by their action, not dismissed', { kind: decision.kind });
      if (decision.status !== 'open') throw conflict('decision is no longer open', { status: decision.status });
      const reason = requireText(payload.reason, 'reason', 500);
      decision.status = 'dismissed';
      decision.closedAt = now;
      decision.updatedAt = now;
      const issue = requireIssue(doc, decision.issueId);
      activity(doc, issue, 'human', 'decision.dismissed', '忽略决策请求：' + reason, { decisionId: decision.decisionId }, now);
      return { decisionId: decision.decisionId, status: 'dismissed' };
    },

    'decision.snooze': ({ payload, doc, now, nowMs }) => {
      const kind = payload.kind;
      const subjectRef = payload.subjectRef;
      if (!kind || !subjectRef) throw badRequest('kind and subjectRef are required', {});
      const hours = payload.hours === undefined ? 24 : Math.max(1, Math.min(24 * 7, Number(payload.hours) || 24));
      const existing = doc.decisions.find((d) => d.kind === kind && d.subjectRef === subjectRef);
      if (kind === 'ai_decision') {
        const decision = existing || doc.decisions.find((d) => d.decisionId === subjectRef);
        if (!decision) throw notFound('decision not found', { subjectRef });
        decision.snoozeUntil = new Date(nowMs + hours * 3600 * 1000).toISOString();
        decision.updatedAt = now;
        return { kind, subjectRef, snoozeUntil: decision.snoozeUntil };
      }
      const record = existing || { decisionId: newDecisionId(), kind, subjectRef, issueId: payload.issueId || null, unitId: payload.unitId || null, reason: '', options: [], status: null, answer: null, snoozeUntil: null, closedAt: null, createdAt: now, updatedAt: now };
      record.issueId = payload.issueId || record.issueId;
      record.unitId = payload.unitId !== undefined ? payload.unitId : record.unitId;
      record.snoozeUntil = new Date(nowMs + hours * 3600 * 1000).toISOString();
      record.updatedAt = now;
      if (!existing) doc.decisions.push(record);
      return { kind, subjectRef, snoozeUntil: record.snoozeUntil };
    },

    'decision.restore': ({ payload, doc, now }) => {
      const record = doc.decisions.find((d) => d.kind === payload.kind && d.subjectRef === payload.subjectRef);
      if (!record) return { kind: payload.kind, subjectRef: payload.subjectRef, restored: false };
      record.snoozeUntil = null;
      record.updatedAt = now;
      if (record.kind !== 'ai_decision' && record.status === null && !record.closedAt) {
        const index = doc.decisions.indexOf(record);
        doc.decisions.splice(index, 1);
      }
      return { kind: payload.kind, subjectRef: payload.subjectRef, restored: true };
    },

    'decision.backToTodo': ({ payload, doc, now }) => {
      const unit = requireUnit(doc, payload.unitId);
      const issue = requireIssue(doc, unit.issueId);
      if (unit.execState !== 'failed' || unit.voided === true) throw invalidState('only a live abnormal unit can be returned', { unitId: unit.unitId });
      unit.voided = true;
      unit.closeReason = 'dismissed';
      unit.updatedAt = now;
      issue.status = 'todo';
      issue.statusPin = { at: now };
      issue.statusUndo = null;
      issue.updatedAt = now;
      for (const decision of doc.decisions) {
        if (decision.kind === 'unit_abnormal' && decision.subjectRef === unit.unitId) decision.snoozeUntil = null;
      }
      activity(doc, issue, 'human', 'unit.voided', '异常单元改回待认领：作废第 ' + unit.roundNo + ' 轮', { unitId: unit.unitId, reason: 'dismissed' }, now);
      return { unitId: unit.unitId, issueStatus: 'todo' };
    },
  };
  return commands;
}
