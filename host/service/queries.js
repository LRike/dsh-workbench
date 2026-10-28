/**
 * Read models derived from the stored document. Pure: no I/O, no mutation.
 * Every view the browser needs is assembled here so the API layer stays thin.
 */
import { ACTIVE_STATUSES, categoryOf, isTerminal } from '../domain/status.js';
import {
  unitsOf, liveUnits, activeUnits, pendingReviewUnits, abnormalUnits, pendingReview, terminalReview,
  projectArchived, closing, pinActive, undoAvailable, isZombie, r4Count, lastTouch, DAY_MS, STUCK_MS,
} from '../domain/rules.js';

const byRecent = (left, right) => String(right.lastActivityAt || right.updatedAt || '').localeCompare(String(left.lastActivityAt || left.updatedAt || ''));
const trim = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) + '…' : value);
const since = (value) => (value === undefined || value === null ? null : value);

const unitSummary = (units) => {
  const live = liveUnits(units);
  return {
    total: live.length,
    passed: live.filter((u) => u.acceptState === 'passed').length,
    running: live.filter((u) => u.execState === 'running' || u.execState === 'pending').length,
    waiting: live.filter((u) => u.acceptState === 'pending' && (u.execState === 'ended' || u.execState === 'failed')).length,
  };
};

const issueSummary = (doc, issue) => {
  const units = unitsOf(doc, issue.issueId);
  return {
    issueId: issue.issueId,
    title: issue.title,
    status: issue.status,
    category: categoryOf(issue.status),
    projectId: issue.projectId,
    workspacePath: issue.workspacePath,
    isTriaged: issue.isTriaged,
    archivedAt: issue.archivedAt,
    terminalReview: terminalReview(issue, units),
    pendingReview: pendingReview(units),
    units: unitSummary(units),
    acceptanceTotal: (issue.acceptanceCriteria || []).length,
    acceptanceDone: (issue.acceptanceCriteria || []).filter((c) => c.done === true).length,
    lastActivityAt: lastTouch(issue, units),
    createdAt: issue.createdAt,
  };
};

export function buildSnapshot(doc, context = /** @type {{nowMs?: number, unassignedSessions?: any[], dirExists?: (path: string) => boolean}} */ ({})) {
  const nowMs = context.nowMs || Date.now();
  const runningUnbound = Array.isArray(context.unassignedSessions) ? context.unassignedSessions.filter((s) => s.running).length : 0;
  const projects = [];
  for (const project of doc.projects) {
    if (project.archivedAt) continue;
    const issues = doc.issues.filter((i) => i.isTriaged === true && i.projectId === project.projectId && !i.archivedAt);
    const projectUnits = issues.flatMap((issue) => liveUnits(unitsOf(doc, issue.issueId)));
    projects.push({
      projectId: project.projectId,
      name: project.name,
      defaultWorkspacePath: project.defaultWorkspacePath,
      // C9: a vanished directory degrades the project to "unbound"; derived, never stored.
      dirInvalid: Boolean(project.defaultWorkspacePath) && typeof context.dirExists === 'function' ? !context.dirExists(project.defaultWorkspacePath) : false,
      archived: Boolean(project.archivedAt),
      progress: {
        passed: projectUnits.filter((u) => u.acceptState === 'passed').length,
        total: projectUnits.length,
      },
      issues: issues.map((issue) => issueSummary(doc, issue)).sort(byRecent),
    });
  }
  projects.sort((left, right) => String(left.name).localeCompare(String(right.name)));

  const todoIssues = doc.issues.filter((i) => i.isTriaged !== true && !i.archivedAt);
  const triaged = doc.issues.filter((i) => i.isTriaged === true && !i.archivedAt);
  const pendingUnits = [];
  const stuckUnits = [];
  const terminalReviews = [];
  for (const issue of triaged) {
    const units = unitsOf(doc, issue.issueId);
    for (const unit of pendingReviewUnits(units)) {
      pendingUnits.push({ unitId: unit.unitId, issueId: issue.issueId, code: issue.issueId, issueTitle: issue.title, roundNo: unit.roundNo, sessionId: unit.sessionId, endedAt: unit.endedAt });
    }
    for (const unit of liveUnits(units)) {
      if (unit.execState === 'running' && unit.lastEventAt && nowMs - Date.parse(unit.lastEventAt) > STUCK_MS) {
        stuckUnits.push({ unitId: unit.unitId, issueId: issue.issueId, code: issue.issueId, lastEventAt: unit.lastEventAt });
      }
    }
    if (terminalReview(issue, units)) terminalReviews.push({ issueId: issue.issueId, title: issue.title, unmet: (issue.acceptanceCriteria || []).filter((c) => c.done !== true).length });
  }
  const pendingDecisions = pendingDecisionItems(doc, nowMs);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    counters: {
      running: r4Count(doc, runningUnbound),
      pendingReviewUnits: pendingUnits.length,
      pendingTerminalReviews: terminalReviews.length,
      pendingDecisions: pendingDecisions.length,
      unassignedSessions: Array.isArray(context.unassignedSessions) ? context.unassignedSessions.length : 0,
      todoCount: todoIssues.length,
      stuckUnits: stuckUnits.length,
      pendingWrapupUnits: doc.units.filter((unit) => unit.voided !== true && unit.execState === 'wrapping').length,
    },
    projects,
    todos: todoIssues.map((issue) => ({
      issueId: issue.issueId,
      title: issue.title,
      projectId: issue.projectId,
      lastActivityAt: issue.updatedAt,
      hasAiSuggestion: (issue.activities || []).some((a) => a.type === 'suggestion.created'),
    })).sort(byRecent),
    unassignedSessions: context.unassignedSessions || [],
    recentActivities: recentActivities(doc, 20),
    stuckUnits,
  };
}

function recentActivities(doc, limit) {
  const rows = [];
  for (const issue of doc.issues) {
    for (const entry of (issue.activities || []).slice(-4)) rows.push({ issueId: issue.issueId, code: issue.isTriaged ? issue.issueId : issue.issueId, ...entry });
  }
  for (const project of doc.projects) {
    for (const entry of (project.activities || []).slice(-2)) rows.push({ projectId: project.projectId, code: project.name, ...entry });
  }
  rows.sort((left, right) => right.seq - left.seq);
  return rows.slice(0, limit);
}

/** Derived pending decisions: 4 kinds, minus snoozed records (W2/W5). */
export function pendingDecisionItems(doc, nowMs) {
  const snoozed = new Map();
  for (const decision of doc.decisions) if (decision.snoozeUntil && Date.parse(decision.snoozeUntil) > nowMs) snoozed.set(decision.kind + '|' + decision.subjectRef, decision);
  const items = [];
  const push = (item) => { if (!snoozed.has(item.kind + '|' + item.subjectRef)) items.push(item); };
  for (const issue of doc.issues) {
    if (issue.isTriaged !== true || issue.archivedAt || closing(issue) || projectArchived(doc, issue)) continue;
    const units = unitsOf(doc, issue.issueId);
    for (const unit of abnormalUnits(units)) {
      push({ kind: 'unit_abnormal', subjectRef: unit.unitId, unitId: unit.unitId, issueId: issue.issueId, issueTitle: issue.title, reason: '第 ' + unit.roundNo + ' 轮异常结束（' + (unit.exitReason || 'unknown') + '）' });
    }
    if (!issue.workspacePath) push({ kind: 'issue_no_workspace', subjectRef: issue.issueId, unitId: null, issueId: issue.issueId, issueTitle: issue.title, reason: '议题没有工作区，无法开工' });
    if (isZombie(issue, units, nowMs)) push({ kind: 'issue_zombie', subjectRef: issue.issueId, unitId: null, issueId: issue.issueId, issueTitle: issue.title, reason: '停在处理中但 24 小时没有活跃单元' });
    for (const decision of doc.decisions) {
      if (decision.kind === 'ai_decision' && decision.status === 'open' && decision.issueId === issue.issueId) {
        push({ kind: 'ai_decision', subjectRef: decision.decisionId, decisionId: decision.decisionId, unitId: decision.unitId, issueId: issue.issueId, issueTitle: issue.title, reason: decision.reason, options: decision.options });
      }
    }
  }
  return items;
}

export function buildInbox(doc, nowMs = Date.now()) {
  const reviewUnits = [];
  const wrapupUnits = [];
  const suggestedUnits = [];
  const terminalReviews = [];
  for (const issue of doc.issues) {
    if (issue.isTriaged !== true || issue.archivedAt) continue;
    const units = unitsOf(doc, issue.issueId);
    for (const unit of pendingReviewUnits(units)) {
      reviewUnits.push({ unitId: unit.unitId, issueId: issue.issueId, issueTitle: issue.title, roundNo: unit.roundNo, sessionId: unit.sessionId, endedAt: unit.endedAt, hasHandover: Boolean(unit.handover), needsHandoff: unit.needsHandoff === true });
    }
    // A session that died (or went idle) leaves work that still needs a human
    // wrap-up: surface it instead of letting it sit invisible in progress.
    // An AI suggestion is useless if it is only visible inside the issue page.
    for (const unit of units) {
      if (unit.voided === true || !unit.wrapUpSuggestion) continue;
      suggestedUnits.push({ unitId: unit.unitId, issueId: issue.issueId, issueTitle: issue.title, roundNo: unit.roundNo, turnCount: Number.isFinite(unit.turnCount) ? unit.turnCount : 0, note: unit.wrapUpSuggestion.note || null, at: unit.wrapUpSuggestion.at || null });
    }
    for (const unit of units) {
      if (unit.voided === true || unit.execState !== 'wrapping') continue;
      wrapupUnits.push({ unitId: unit.unitId, issueId: issue.issueId, issueTitle: issue.title, roundNo: unit.roundNo, sessionId: unit.sessionId, turnCount: Number.isFinite(unit.turnCount) ? unit.turnCount : 0, exitReason: unit.exitReason || null, endedAt: unit.endedAt });
    }
    if (terminalReview(issue, units)) terminalReviews.push({ issueId: issue.issueId, issueTitle: issue.title, unmet: (issue.acceptanceCriteria || []).filter((c) => c.done !== true).length });
  }
  const decisions = pendingDecisionItems(doc, nowMs).map((item) => {
    const record = doc.decisions.find((d) => d.kind === item.kind && d.subjectRef === item.subjectRef);
    return { ...item, snoozeUntil: record && record.snoozeUntil ? record.snoozeUntil : null };
  });
  const todos = doc.issues.filter((i) => i.isTriaged !== true && !i.archivedAt).map((issue) => ({ issueId: issue.issueId, title: issue.title, projectId: issue.projectId, hasAiSuggestion: (issue.activities || []).some((a) => a.type === 'suggestion.created') }));
  return { reviewUnits, wrapupUnits, suggestedUnits, terminalReviews, decisions, todos, counts: { pendingReviewUnits: reviewUnits.length, pendingWrapupUnits: wrapupUnits.length, pendingSuggestionUnits: suggestedUnits.length, pendingTerminalReviews: terminalReviews.length, pendingDecisions: decisions.length, todoCount: todos.length } };
}

export function buildBoard(doc) {
  const columns = [];
  for (const status of ACTIVE_STATUSES) {
    const items = doc.issues
      .filter((issue) => issue.isTriaged === true && !issue.archivedAt && issue.status === status)
      .map((issue) => issueSummary(doc, issue))
      .sort(byRecent);
    if (items.length > 0) columns.push({ status, category: categoryOf(status), items });
  }
  return { columns, maxPerColumn: 20 };
}

export function buildIssueDetail(doc, idOrCode, nowMs = Date.now(), options = /** @type {{runningUnbound?: number}} */ ({})) {
  const issue = doc.issues.find((i) => i.issueId === idOrCode);
  if (!issue) return undefined;
  const units = unitsOf(doc, issue.issueId);
  const project = doc.projects.find((p) => p.projectId === issue.projectId);
  return {
    issue: {
      ...issueSummary(doc, issue),
      description: issue.description,
      projectName: project ? project.name : null,
      projectArchived: projectArchived(doc, issue),
      acceptanceCriteria: issue.acceptanceCriteria || [],
      pinned: pinActive(issue, units),
      undo: undoAvailable(issue, nowMs) ? issue.statusUndo : null,
      activities: (issue.activities || []).slice(-50).slice().reverse(),
    },
    units: units.map((unit) => ({
      unitId: unit.unitId, roundNo: unit.roundNo, parentUnitId: unit.parentUnitId, goal: unit.goal, sessionId: unit.sessionId,
      execState: unit.execState, acceptState: unit.acceptState, voided: unit.voided, exitReason: unit.exitReason,
      closeReason: unit.closeReason, setupIssue: unit.setupIssue, createdBy: unit.createdBy, handover: unit.handover,
      startedAt: unit.startedAt, endedAt: unit.endedAt, startedAtMs: unit.startedAt ? Date.parse(unit.startedAt) : null,
      running: unit.execState === 'running', stuck: Boolean(unit.lastEventAt && nowMs - Date.parse(unit.lastEventAt) > STUCK_MS && unit.execState === 'running'),
      sessionTitle: unit.sessionTitle || null,
      sessionAvailable: Array.isArray(options.liveSessionIds) && unit.sessionId ? options.liveSessionIds.indexOf(unit.sessionId) >= 0 : undefined,
      turnCount: Number.isFinite(unit.turnCount) ? unit.turnCount : 0,
      turns: Array.isArray(unit.turns) ? unit.turns.slice(-10) : [],
      wrapUp: unit.wrapUp || null,
      wrapUpSuggestion: unit.wrapUpSuggestion || null,
      wrapRequest: unit.wrapRequest || null,
      needsHandoff: unit.needsHandoff === true,
    })).sort((left, right) => right.roundNo - left.roundNo),
    decisions: doc.decisions.filter((d) => d.issueId === issue.issueId),
    inboxItems: pendingDecisionItems(doc, nowMs).filter((item) => item.issueId === issue.issueId),
    start: startAvailability(doc, issue, units, nowMs, options.runningUnbound || 0),
  };
}

function startAvailability(doc, issue, units, nowMs, runningUnbound = 0) {
  const reasons = [];
  if (!issue.isTriaged) reasons.push('未立项');
  if (!issue.workspacePath) reasons.push('还没有指定工作区');
  if (issue.archivedAt) reasons.push('已归档（只读）');
  if (projectArchived(doc, issue)) reasons.push('项目已归档（只读）');
  if (closing(issue)) reasons.push('收尾状态不能开工');
  if (activeUnits(units).length > 0) reasons.push('已有活跃单元（R1）');
  // R4 was retired: a busy machine is not a reason to forbid starting.
  return { available: reasons.length === 0, reasons };
}

export function buildSearch(doc, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { issues: [], todos: [], projects: [] };
  const match = (value) => String(value || '').toLowerCase().includes(q);
  return {
    issues: doc.issues.filter((i) => i.isTriaged === true && !i.archivedAt && (match(i.issueId) || match(i.title) || match(i.description))).slice(0, 20)
      .map((i) => ({ issueId: i.issueId, title: trim(i.title, 120), status: i.status, category: categoryOf(i.status) })),
    todos: doc.issues.filter((i) => i.isTriaged !== true && !i.archivedAt && (match(i.title) || match(i.description))).slice(0, 20)
      .map((i) => ({ issueId: i.issueId, title: trim(i.title, 120) })),
    projects: doc.projects.filter((p) => !p.archivedAt && match(p.name)).slice(0, 20).map((p) => ({ projectId: p.projectId, name: p.name })),
  };
}

export function buildActivityPage(doc, issueId, beforeSeq, limit) {
  const issue = doc.issues.find((i) => i.issueId === issueId);
  if (!issue) return { items: [], hasMore: false };
  const size = Math.max(1, Math.min(100, limit || 50));
  const rows = (issue.activities || []).filter((a) => beforeSeq === undefined || beforeSeq === null || a.seq < beforeSeq).slice().reverse();
  return { items: rows.slice(0, size), hasMore: rows.length > size };
}

export function buildProjectDetail(doc, projectId) {
  const project = doc.projects.find((p) => p.projectId === projectId);
  if (!project) return undefined;
  const issues = doc.issues.filter((i) => i.projectId === projectId && i.isTriaged === true && !i.archivedAt).map((i) => issueSummary(doc, i)).sort(byRecent);
  const units = issues.flatMap((issue) => liveUnits(unitsOf(doc, issue.issueId)));
  return {
    project: { ...project, activities: (project.activities || []).slice(-20).reverse() },
    issues,
    progress: {
      passed: units.filter((u) => u.acceptState === 'passed').length,
      total: units.length,
      running: units.filter((u) => u.execState === 'running').length,
      waiting: units.filter((u) => u.acceptState === 'pending' && u.execState === 'ended').length,
      cancelled: issues.filter((i) => i.status === 'cancelled').length,
    },
  };
}

/** Archived projects and issues (FR-24: the archive drawer). */
export function buildArchived(doc) {
  return {
    projects: doc.projects.filter((p) => p.archivedAt).map((p) => ({ projectId: p.projectId, name: p.name, archivedAt: p.archivedAt })),
    issues: doc.issues.filter((i) => i.archivedAt).map((i) => ({ issueId: i.issueId, title: i.title, status: i.status, category: categoryOf(i.status), isTriaged: i.isTriaged, archivedAt: i.archivedAt, projectId: i.projectId || null })),
  };
}

export { since, DAY_MS };
