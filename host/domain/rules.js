/**
 * Pure domain rules shared by commands and queries: activity stamping, the three
 * auto-write moments and their shared gates, R1/R4 accounting, and derived flags.
 * No I/O; callers pass the document and the time.
 */
import { categoryOf, isTerminal } from './status.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const STUCK_MS = 15 * 60 * 1000;

export const unitsOf = (doc, issueId) => doc.units.filter((u) => u.issueId === issueId);
export const liveUnits = (units) => units.filter((u) => u.voided !== true);
export const activeUnits = (units) => liveUnits(units).filter((u) => u.execState === 'pending' || u.execState === 'running' || u.execState === 'wrapping' || u.acceptState === 'pending');
export const pendingReviewUnits = (units) => liveUnits(units).filter((u) => u.execState === 'ended' && u.acceptState === 'pending');
export const abnormalUnits = (units) => liveUnits(units).filter((u) => u.execState === 'failed');
export const pendingReview = (units) => liveUnits(units).some((u) => u.acceptState === 'pending');
export const terminalReview = (issue, units) => issue.status === 'in_review' && !pendingReview(units) && !liveUnits(units).some((u) => u.execState === 'pending');

export const projectOf = (doc, issue) => (issue.projectId ? doc.projects.find((p) => p.projectId === issue.projectId) : undefined);
export const projectArchived = (doc, issue) => {
  const project = projectOf(doc, issue);
  return Boolean(project && project.archivedAt);
};
export const closing = (issue) => isTerminal(issue.status);

/** A manual status write pins the issue until a unit created later exists. */
export const pinActive = (issue, units) => Boolean(issue.statusPin && issue.statusPin.at)
  && !units.some((u) => u.createdAt && u.createdAt > issue.statusPin.at);

/** Shared gate of the three automatic moments (N7 + pin). */
export const autoWriteAllowed = (doc, issue, units) => issue.isTriaged === true
  && !issue.archivedAt && !projectArchived(doc, issue) && !closing(issue) && !pinActive(issue, units);

export const undoAvailable = (issue, nowMs) => Boolean(issue.statusUndo && issue.statusUndo.at)
  && nowMs - Date.parse(issue.statusUndo.at) < DAY_MS;

/** Global R4 count: live pending/running units plus running unattributed sessions. */
export const r4Count = (doc, runningUnboundSessions = 0) => doc.units.filter((u) => u.voided !== true && (u.execState === 'pending' || u.execState === 'running')).length + runningUnboundSessions;

export const lastTouch = (issue, units) => {
  let latest = issue.createdAt;
  let latestSeq = -1;
  for (const activity of issue.activities || []) {
    if (String(activity.type).startsWith('issue.status') && activity.seq > latestSeq) { latestSeq = activity.seq; latest = activity.at; }
  }
  for (const unit of units) {
    if (unit.createdAt && unit.createdAt > latest) latest = unit.createdAt;
    if (unit.endedAt && unit.endedAt > latest) latest = unit.endedAt;
  }
  return latest;
};

export const isZombie = (issue, units, nowMs) => issue.status === 'in_progress'
  && activeUnits(units).length === 0
  && nowMs - Date.parse(lastTouch(issue, units)) > DAY_MS;

/** Append one activity entry, stamping meta.nextActivitySeq. */
export function pushActivity(meta, holder, entry) {
  const seq = meta.nextActivitySeq++;
  const activity = { seq, at: entry.at, actor: entry.actor, type: entry.type, text: entry.text, data: entry.data === undefined ? null : entry.data };
  if (!Array.isArray(holder.activities)) holder.activities = [];
  holder.activities.push(activity);
  return activity;
}

/**
 * Apply one automatic status transition when the shared gate allows it, and
 * remember it as the single undo slot. Returns true when the status changed.
 */
export function applyAutoStatus(doc, issue, units, to, unitId, entry) {
  if (!autoWriteAllowed(doc, issue, units)) return false;
  if (issue.status === to) return false;
  const from = issue.status;
  const activity = pushActivity(doc.meta, issue, { ...entry, actor: 'system', type: 'issue.status_auto', data: { from, to, unitId } });
  issue.status = to;
  issue.statusUndo = { from, to, at: activity.at, activitySeq: activity.seq };
  issue.updatedAt = activity.at;
  return true;
}

/** The small view of an issue used by lists and the board. */
export const issueBadge = (issue) => {
  if (issue.archivedAt) return { kind: 'archived', text: '已归档' };
  const category = categoryOf(issue.status);
  return { kind: category, text: issue.status };
};
