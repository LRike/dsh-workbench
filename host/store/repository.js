/**
 * Single-document repository: load, index, and mutate with durable atomic writes.
 * Every mutation runs under the cross-process lock and re-reads the file first,
 * so two DSH processes (web + desktop) cannot silently overwrite each other.
 */
import { dirname } from 'node:path';
import { copyFileSync, renameSync } from 'node:fs';
import { writeFileAtomicSync, readFileSyncIfExists, ensureDirSync } from './atomic-file.js';
import { withLockSync } from './lock.js';
import { SCHEMA_VERSION, emptyDocument, assertDocumentShape, normalizeDocument } from './document.js';
import { DomainError } from '../domain/errors.js';

export class SchemaTooNewError extends Error {
  constructor(version) {
    super('workbench document schemaVersion ' + version + ' is newer than this plugin (' + SCHEMA_VERSION + ')');
    this.name = 'SchemaTooNewError';
    this.code = 'E_SCHEMA_TOO_NEW';
  }
}

const FS_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'ESTALE', 'EBUSY', 'EDQUOT']);

/** schemaVersion -> upgrade step. A missing step refuses to guess (backup + empty store). */
const MIGRATIONS = {
  /**
   * 1 -> 2: unit/round model. A unit used to *be* one round, so every historical
   * 'ended' unit becomes "one round has happened"; nothing else is rewritten.
   * Units that ended without a handover are flagged so review cannot judge a
   * ghost (the reviewer still has to confirm the synthesized draft).
   */
  2: (doc) => {
    for (const unit of doc.units || []) {
      const ended = unit.execState === 'ended';
      if (!Number.isFinite(unit.turnCount)) unit.turnCount = ended ? 1 : 0;
      if (!Array.isArray(unit.turns)) {
        unit.turns = ended
          ? [{ turnNo: 1, startedAt: unit.startedAt || unit.createdAt || null, endedAt: unit.endedAt || unit.updatedAt || null, note: null }]
          : [];
      }
      if (unit.needsHandoff !== true) unit.needsHandoff = ended && !unit.handover;
    }
    doc.schemaVersion = 2;
    return doc;
  },
};

const ACTIVITY_LIMIT = 500;
const PROJECT_ACTIVITY_LIMIT = 100;

/** @param {{file: string, logger?: any, now?: () => string}} options */
export function createRepository(options) {
  const file = options.file;
  const lockPath = file + '.lock';
  const logger = options.logger;
  const now = options.now === undefined ? () => new Date().toISOString() : options.now;
  let doc = emptyDocument(now());
  let indexes = buildIndexes(doc);
  let rev = 0;
  let loaded = false;
  let corruptPath;

  const warn = (message) => { try { logger && logger.warn && logger.warn('workbench: ' + message); } catch {} };

  function buildIndexes(target) {
    const projectsById = new Map(target.projects.map((p) => [p.projectId, p]));
    const issuesById = new Map(target.issues.map((i) => [i.issueId, i]));
    const unitsById = new Map(target.units.map((u) => [u.unitId, u]));
    const unitsByIssue = new Map();
    const unitsBySession = new Map();
    const childrenByParent = new Map();
    const issuesByProject = new Map();
    const todoIssues = [];
    const triagedIssues = [];
    const decisionsByKey = new Map();
    const openAiDecisions = [];
    for (const unit of target.units) {
      if (!unitsByIssue.has(unit.issueId)) unitsByIssue.set(unit.issueId, []);
      unitsByIssue.get(unit.issueId).push(unit);
      if (unit.sessionId) unitsBySession.set(unit.sessionId, unit);
      if (unit.parentUnitId) {
        if (!childrenByParent.has(unit.parentUnitId)) childrenByParent.set(unit.parentUnitId, []);
        childrenByParent.get(unit.parentUnitId).push(unit);
      }
    }
    for (const units of unitsByIssue.values()) units.sort((l, r) => l.roundNo - r.roundNo);
    for (const issue of target.issues) {
      if (issue.isTriaged === true) {
        triagedIssues.push(issue);
        if (!issuesByProject.has(issue.projectId)) issuesByProject.set(issue.projectId, []);
        issuesByProject.get(issue.projectId).push(issue);
      } else todoIssues.push(issue);
    }
    for (const decision of target.decisions) {
      decisionsByKey.set(decision.kind + '|' + decision.subjectRef, decision);
      if (decision.kind === 'ai_decision' && decision.status === 'open') openAiDecisions.push(decision);
    }
    const activeUnitByIssue = new Map();
    for (const [issueId, units] of unitsByIssue) {
      const active = units.find((u) => u.voided !== true && (u.execState === 'pending' || u.execState === 'running' || u.acceptState === 'pending'));
      activeUnitByIssue.set(issueId, active || null);
    }
    return { projectsById, issuesById, unitsById, unitsByIssue, unitsBySession, childrenByParent, issuesByProject, todoIssues, triagedIssues, decisionsByKey, openAiDecisions, activeUnitByIssue };
  }

  function quarantine(reason) {
    const ts = now().replace(/[:.]/g, '-');
    corruptPath = file + '.corrupt-' + ts;
    try { ensureDirSync(dirname(file)); renameSync(file, corruptPath); warn('document was unreadable (' + reason + '); moved to ' + corruptPath); }
    catch (error) { warn('document was unreadable (' + reason + ') and could not be moved: ' + String(error)); }
  }

  function adopt(next) { doc = next; indexes = buildIndexes(doc); rev += 1; }

  /** True while an in-memory migration still has to be written over the old file. */
  let preferMemory = false;

  function readFromDisk() {
    const text = readFileSyncIfExists(file);
    if (text === undefined) return { kind: 'missing' };
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { return { kind: 'corrupt', reason: 'invalid JSON: ' + error.message }; }
    // A newer document must be rejected before shape validation: this version
    // cannot judge a future layout, and must never quarantine it.
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) return { kind: 'too-new', version: parsed.schemaVersion };
    try { assertDocumentShape(parsed); }
    catch (error) { return { kind: 'corrupt', reason: error.message }; }
    if (parsed.schemaVersion < SCHEMA_VERSION) return { kind: 'older', version: parsed.schemaVersion, doc: parsed };
    return { kind: 'current', doc: normalizeDocument(parsed) };
  }

  function trimActivities(target) {
    for (const issue of target.issues) if (issue.activities && issue.activities.length > ACTIVITY_LIMIT) issue.activities = issue.activities.slice(-ACTIVITY_LIMIT);
    for (const project of target.projects) if (project.activities && project.activities.length > PROJECT_ACTIVITY_LIMIT) project.activities = project.activities.slice(-PROJECT_ACTIVITY_LIMIT);
  }

  function writeLocked(mutator) {
    try {
      return writeLockedInner(mutator);
    } catch (error) {
      // Domain errors (including E_LOCK_TIMEOUT) pass through; raw filesystem
      // failures (EACCES/ENOSPC/EROFS from the lock file or the temp file) become
      // the documented E_STORAGE so callers never receive an unwrapped errno.
      if (error instanceof DomainError) throw error;
      const code = error && error.code ? error.code : undefined;
      // Only filesystem errno values become E_STORAGE; domain logic errors thrown
      // by a mutator keep their own message and type.
      if (!code || !FS_ERROR_CODES.has(code)) throw error;
      warn('persist failed (' + code + '): ' + String(error && error.message ? error.message : error));
      throw new DomainError('E_STORAGE', 'failed to persist the workbench document', { causeCode: code, path: file });
    }
  }

  function writeLockedInner(mutator) {
    return withLockSync(lockPath, () => {
      const current = readFromDisk();
      let base;
      // After an in-memory migration the file on disk is still the OLD schema;
      // re-reading it would quarantine a perfectly good document and start from
      // empty, so the migrated copy wins exactly once.
      if (preferMemory) { preferMemory = false; base = doc; }
      else if (current.kind === 'current') base = current.doc;
      else if (current.kind === 'missing') base = emptyDocument(now());
      else if (current.kind === 'too-new') throw new SchemaTooNewError(current.version);
      else { quarantine(current.reason || 'unreadable'); base = emptyDocument(now()); }
      if (loaded && doc.meta && base.meta && doc.meta.updatedAt && base.meta.updatedAt && doc.meta.updatedAt > base.meta.updatedAt) base = doc;
      const draft = structuredClone(base);
      const result = mutator(draft);
      draft.schemaVersion = SCHEMA_VERSION;
      draft.meta.rev = (Number.isInteger(base.meta.rev) ? base.meta.rev : 0) + 1;
      draft.meta.updatedAt = now();
      draft.meta.writer = { pid: process.pid, at: draft.meta.updatedAt };
      trimActivities(draft);
      assertDocumentShape(draft);
      try {
        writeFileAtomicSync(file, JSON.stringify(draft));
      } catch (error) {
        const code = error && error.code ? error.code : 'EUNKNOWN';
        warn('persist failed (' + code + '): ' + String(error && error.message ? error.message : error));
        throw new DomainError('E_STORAGE', 'failed to persist the workbench document', { causeCode: code, path: file });
      }
      adopt(draft);
      return result;
    }, { waitMs: 3000 });
  }

  function load() {
    ensureDirSync(dirname(file));
    const result = readFromDisk();
    if (result.kind === 'missing') { adopt(emptyDocument(now())); writeLocked((current) => current); }
    else if (result.kind === 'corrupt') { quarantine(result.reason); adopt(emptyDocument(now())); writeLocked((current) => current); }
    else if (result.kind === 'too-new') { adopt(emptyDocument(now())); throw new SchemaTooNewError(result.version); }
    else if (result.kind === 'older') {
      // Never lose the original bytes: back up first, then migrate step by step.
      const backup = file + '.bak-' + now().replace(/[:.]/g, '-');
      try { copyFileSync(file, backup); warn('backed up schemaVersion ' + result.version + ' document to ' + backup); }
      catch (error) { warn('could not back up the older document: ' + String(error)); }
      let migrated = result.doc;
      let complete = true;
      for (let version = result.version + 1; version <= SCHEMA_VERSION; version += 1) {
        const step = MIGRATIONS[version];
        if (typeof step !== 'function') { complete = false; break; }
        migrated = step(migrated);
      }
      if (!complete) {
        quarantine('no migration path from schemaVersion ' + result.version);
        adopt(emptyDocument(now()));
        writeLocked((current) => current);
      } else {
        warn('document schemaVersion ' + result.version + ' migrated to ' + SCHEMA_VERSION);
        adopt({ ...normalizeDocument(migrated), schemaVersion: SCHEMA_VERSION });
        preferMemory = true;
        writeLocked((current) => current);
      }
    } else { adopt(result.doc); }
    loaded = true;
    return doc;
  }

  return {
    load,
    get file() { return file; },
    get corruptPath() { return corruptPath; },
    get document() { return doc; },
    get indexes() { return indexes; },
    get rev() { return Number.isInteger(doc.meta && doc.meta.rev) ? doc.meta.rev : 0; },
    /** Mutate under the lock; returns the mutator result. Throws without changing anything on failure. */
    mutate(mutator) { return writeLocked(mutator); },
    /** Adopt a newer document written by another process. */
    refresh() {
      const result = readFromDisk();
      if (result.kind === 'current' && JSON.stringify(result.doc) !== JSON.stringify(doc)) adopt(result.doc);
      return doc;
    },
  };
}
