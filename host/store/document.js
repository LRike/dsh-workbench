/**
 * The single-document shape (schemaVersion 2), per docs/design/DATA-MODEL.md.
 * v2 = unit/round model: units carry turnCount/turns and, for units that ended
 * before the model existed, needsHandoff (they must be reviewed with a draft).
 * Top level keeps arrays (not maps): activity order and review order are domain data.
 */
export const SCHEMA_VERSION = 2;

/** @returns {any} a fresh, empty document */
export function emptyDocument(now = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    // meta.rev is the durable document version: monotonic across processes and
    // restarts, so a client "since" check can never skip a real change.
    meta: { createdAt: now, updatedAt: now, rev: 0, nextIssueNo: 1, nextActivitySeq: 1, writer: null },
    projects: [],
    issues: [],
    units: [],
    decisions: [],
  };
}

/** Throws when a document cannot be trusted by this version. */
export function assertDocumentShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('workbench document must be a JSON object');
  if (typeof doc.schemaVersion !== 'number') throw new Error('workbench document is missing schemaVersion');
  for (const key of ['projects', 'issues', 'units', 'decisions']) {
    if (!Array.isArray(doc[key])) throw new Error('workbench document field ' + key + ' must be an array');
  }
  const meta = doc.meta;
  if (!meta || typeof meta !== 'object') throw new Error('workbench document is missing meta');
  if (!Number.isInteger(meta.rev) || meta.rev < 0) throw new Error('workbench document meta.rev must be a non-negative integer');
  for (const key of ['nextIssueNo', 'nextActivitySeq']) {
    if (!Number.isInteger(meta[key]) || meta[key] < 1) throw new Error('workbench document meta.' + key + ' must be a positive integer');
  }
}

/** Unit fields introduced by v2; values are always derived, never invented. */
export function normalizeUnit(unit) {
  const turns = Array.isArray(unit.turns) ? unit.turns : [];
  return {
    ...unit,
    turnCount: Number.isFinite(unit.turnCount) ? unit.turnCount : (turns.length > 0 ? turns.length : (unit.execState === 'ended' ? 1 : 0)),
    turns,
    needsHandoff: unit.needsHandoff === true,
  };
}

/** Fill fields added by later minor versions; never invents domain data. */
export function normalizeDocument(doc) {
  const base = emptyDocument(doc.meta && doc.meta.createdAt ? doc.meta.createdAt : undefined);
  return {
    ...base,
    ...doc,
    schemaVersion: SCHEMA_VERSION,
    meta: { ...base.meta, ...(doc.meta || {}) },
    projects: doc.projects || [],
    issues: doc.issues || [],
    units: (doc.units || []).map(normalizeUnit),
    decisions: doc.decisions || [],
  };
}
