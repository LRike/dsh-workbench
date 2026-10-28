/**
 * W2: a derived pending-decision record exists only while its condition holds.
 * ai_decision records are user-visible history and are never pruned here.
 */
import { isZombie } from './rules.js';
import { closing } from './rules.js';

const conditionHolds = (doc, record, nowMs) => {
  if (record.kind === 'unit_abnormal') {
    const unit = doc.units.find((u) => u.unitId === record.subjectRef);
    return Boolean(unit && unit.voided !== true && unit.execState === 'failed');
  }
  if (record.kind === 'issue_no_workspace') {
    const issue = doc.issues.find((i) => i.issueId === record.subjectRef);
    return Boolean(issue && issue.isTriaged === true && !issue.archivedAt && !issue.workspacePath && !closing(issue));
  }
  if (record.kind === 'issue_zombie') {
    const issue = doc.issues.find((i) => i.issueId === record.subjectRef);
    if (!issue || issue.isTriaged !== true || issue.archivedAt) return false;
    const units = doc.units.filter((u) => u.issueId === issue.issueId);
    return isZombie(issue, units, nowMs);
  }
  return true;
};

/** Drop stored derived records whose condition disappeared; keep ai_decision rows. */
export function pruneDerivedDecisions(doc, nowMs) {
  const before = doc.decisions.length;
  doc.decisions = doc.decisions.filter((record) => record.kind === 'ai_decision' || conditionHolds(doc, record, nowMs));
  return before - doc.decisions.length;
}
