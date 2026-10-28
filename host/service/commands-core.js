/**
 * Core write commands: projects, TODOs, triage, issues, acceptance criteria,
 * status/cancel/archive, terminal review, undo and comments.
 *
 * Every handler receives { payload, doc, now, ports } and mutates the draft
 * document only after validation. Validation failures throw DomainError, which
 * leaves the document untouched.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { badRequest, notFound, conflict, invalidState, acceptanceError } from '../domain/errors.js';
import { projectArchived, pushActivity, applyAutoStatus, unitsOf, liveUnits, activeUnits, closing, terminalReview, undoAvailable, autoWriteAllowed, pinActive } from '../domain/rules.js';
import { isTerminal } from '../domain/status.js';
import { newAcceptanceId, newProjectId, issueCode } from '../domain/ids.js';

const MAX_TITLE = 240;
const MAX_DESCRIPTION = 100000;
const MAX_ACCEPTANCE = 20;
const MAX_ACCEPTANCE_TEXT = 1000;
const UNSET = Symbol('unset');

const text = (value) => (typeof value === 'string' ? value : '');
const requireText = (value, field, max) => {
  const trimmed = text(value).trim();
  if (trimmed.length === 0) throw badRequest(field + ' is required', { field });
  if (trimmed.length > max) throw badRequest(field + ' is longer than ' + max + ' characters', { field });
  return trimmed;
};

function requireProject(doc, projectId) {
  const project = doc.projects.find((p) => p.projectId === projectId);
  if (!project) throw notFound('project not found: ' + String(projectId), { projectId });
  return project;
}

function requireIssue(doc, issueId) {
  const issue = doc.issues.find((i) => i.issueId === issueId);
  if (!issue) throw notFound('issue not found: ' + String(issueId), { issueId });
  return issue;
}

function requireTriaged(issue) {
  if (issue.isTriaged !== true) throw invalidState('this action requires a triaged issue', { issueId: issue.issueId });
  return issue;
}

function requireEditable(issue, doc) {
  if (issue.archivedAt) throw conflict('archived issues are read-only', { issueId: issue.issueId });
  if (doc && projectArchived(doc, issue)) throw conflict('issues of an archived project are read-only', { issueId: issue.issueId, projectId: issue.projectId });
  return issue;
}

function normalizeWorkspacePath(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw badRequest('workspacePath must be a string or null', { field: 'workspacePath' });
  const path = value.trim();
  if (path.length === 0) return null;
  if (!isAbsolute(path)) throw badRequest('workspacePath must be an absolute path', { field: 'workspacePath' });
  if (!existsSync(path)) throw badRequest('workspace directory does not exist: ' + path, { field: 'workspacePath' });
  try { if (!statSync(path).isDirectory()) throw badRequest('workspacePath is not a directory: ' + path, { field: 'workspacePath' }); }
  catch (error) { if (error.code === 'E_BAD_REQUEST') throw error; throw badRequest('workspacePath cannot be read: ' + path, { field: 'workspacePath' }); }
  return path;
}

function activitiesOf(meta, holder, actor, type, textValue, data, at) {
  return pushActivity(meta, holder, { at, actor, type, text: textValue, data });
}

function newAcceptance(entry, at) {
  const criterion = typeof entry === 'string' ? { text: entry } : entry || {};
  const value = requireText(criterion.text, 'acceptance.text', MAX_ACCEPTANCE_TEXT);
  return { id: newAcceptanceId(), text: value, done: false, doneAt: null };
}

function trimAcceptance(issue) {
  if (!Array.isArray(issue.acceptanceCriteria)) issue.acceptanceCriteria = [];
  return issue.acceptanceCriteria;
}

function finish(issue, at) {
  issue.updatedAt = at;
  return issue;
}

export function createCoreCommands() {
  const commands = {
    'project.create': ({ payload, doc, now }) => {
      const name = requireText(payload.name, 'name', MAX_TITLE);
      // Canonical field is defaultWorkspacePath; workspacePath is accepted for API.md compatibility.
      const defaultWorkspacePath = normalizeWorkspacePath(payload.defaultWorkspacePath !== undefined ? payload.defaultWorkspacePath : payload.workspacePath);
      const project = {
        projectId: newProjectId(), name, defaultWorkspacePath,
        createdAt: now, updatedAt: now, archivedAt: null, activities: [],
      };
      doc.projects.push(project);
      activitiesOf(doc.meta, project, 'human', 'project.created', '新建项目：' + name, { projectId: project.projectId }, now);
      return { projectId: project.projectId };
    },

    'project.rename': ({ payload, doc, now }) => {
      const project = requireProject(doc, payload.projectId);
      const name = requireText(payload.name, 'name', MAX_TITLE);
      const from = project.name;
      project.name = name;
      project.updatedAt = now;
      activitiesOf(doc.meta, project, 'human', 'project.renamed', '改名：' + from + ' → ' + name, { from, to: name }, now);
      return { projectId: project.projectId, name };
    },

    'project.setDefaultWorkspace': ({ payload, doc, now }) => {
      const project = requireProject(doc, payload.projectId);
      const next = normalizeWorkspacePath(payload.defaultWorkspacePath !== undefined ? payload.defaultWorkspacePath : payload.workspacePath);
      const before = project.defaultWorkspacePath;
      if (before === next) return { projectId: project.projectId, defaultWorkspacePath: next };
      project.defaultWorkspacePath = next;
      project.updatedAt = now;
      activitiesOf(doc.meta, project, 'human', next === null ? 'project.workspace_unbound' : 'project.workspace_bound',
        next === null ? '解绑默认目录' : '绑定默认目录：' + next, { from: before, to: next }, now);
      return { projectId: project.projectId, defaultWorkspacePath: next };
    },

    'project.setArchived': ({ payload, doc, now }) => {
      const project = requireProject(doc, payload.projectId);
      const archived = payload.archived === true;
      project.archivedAt = archived ? now : null;
      project.updatedAt = now;
      activitiesOf(doc.meta, project, 'human', archived ? 'project.archived' : 'project.unarchived',
        archived ? '归档项目' : '恢复项目', { projectId: project.projectId }, now);
      return { projectId: project.projectId, archived };
    },

    'todo.create': ({ payload, doc, now }) => {
      const title = requireText(payload.title, 'title', MAX_TITLE);
      const description = text(payload.description);
      if (description.length > MAX_DESCRIPTION) throw badRequest('description is too long', { field: 'description' });
      let projectId = null;
      if (payload.projectId !== undefined && payload.projectId !== null) projectId = requireProject(doc, payload.projectId).projectId;
      const issueNo = doc.meta.nextIssueNo++;
      const issueId = issueCode(issueNo);
      const issue = {
        issueId, isTriaged: false, triagedAt: null, projectId, workspacePath: null,
        title, description, acceptanceCriteria: [], status: 'todo', archivedAt: null,
        statusPin: null, statusUndo: null, createdAt: now, updatedAt: now, activities: [],
      };
      doc.issues.push(issue);
      activitiesOf(doc.meta, issue, 'human', 'todo.created', '记下 TODO：' + title, { issueId }, now);
      const normalized = title.toLowerCase();
      const duplicateHints = doc.issues
        .filter((other) => other.issueId !== issueId && !other.archivedAt && String(other.title).toLowerCase().includes(normalized.slice(0, 12)))
        .slice(0, 3)
        .map((other) => other.issueId);
      return { issueId, duplicateHints };
    },

    'todo.update': ({ payload, doc, now }) => {
      const issue = requireIssue(doc, payload.issueId);
      if (issue.isTriaged === true) throw invalidState('todo.update only accepts untriaged issues', { issueId: issue.issueId });
      requireEditable(issue, doc);
      if (payload.title !== undefined) issue.title = requireText(payload.title, 'title', MAX_TITLE);
      if (payload.description !== undefined) {
        const description = text(payload.description);
        if (description.length > MAX_DESCRIPTION) throw badRequest('description is too long', { field: 'description' });
        issue.description = description;
      }
      if (payload.projectId !== undefined) {
        issue.projectId = payload.projectId === null ? null : requireProject(doc, payload.projectId).projectId;
      }
      issue.updatedAt = now;
      activitiesOf(doc.meta, issue, 'human', 'todo.updated', '更新 TODO', { issueId: issue.issueId }, now);
      return { issueId: issue.issueId };
    },

    'todo.discard': ({ payload, doc, now }) => {
      const issue = requireIssue(doc, payload.issueId);
      if (issue.isTriaged === true) throw invalidState('todo.discard only accepts untriaged issues', { issueId: issue.issueId });
      issue.archivedAt = now;
      issue.updatedAt = now;
      activitiesOf(doc.meta, issue, 'human', 'todo.discarded', '丢弃 TODO（可恢复）', { issueId: issue.issueId }, now);
      return { issueId: issue.issueId, archived: true };
    },

    'issue.triage': ({ payload, doc, now }) => {
      const issue = requireIssue(doc, payload.issueId);
      if (issue.isTriaged === true) throw conflict('issue is already triaged', { issueId: issue.issueId });
      if (issue.archivedAt) throw conflict('archived TODO cannot be triaged', { issueId: issue.issueId });
      if (payload.projectId === undefined || payload.projectId === null || payload.projectId === '') throw badRequest('projectId is required to triage (C12)', { field: 'projectId' });
      const project = requireProject(doc, payload.projectId);
      const workspacePath = normalizeWorkspacePath(payload.workspacePath);
      const entries = Array.isArray(payload.acceptance) ? payload.acceptance : [];
      if (entries.length === 0) throw acceptanceError('at least one acceptance criterion is required');
      if (entries.length > MAX_ACCEPTANCE) throw acceptanceError('at most ' + MAX_ACCEPTANCE + ' acceptance criteria are allowed');
      const acceptanceCriteria = entries.map((entry) => newAcceptance(entry, now));
      issue.isTriaged = true;
      issue.triagedAt = now;
      issue.projectId = project.projectId;
      issue.workspacePath = workspacePath;
      issue.acceptanceCriteria = acceptanceCriteria;
      issue.status = 'todo';
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.triaged', '立项：' + issue.title, { projectId: project.projectId, acceptance: acceptanceCriteria.length }, now);
      return { issueId: issue.issueId, status: issue.status, acceptance: acceptanceCriteria.length };
    },

    'issue.update': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      if (payload.title !== undefined) issue.title = requireText(payload.title, 'title', MAX_TITLE);
      if (payload.description !== undefined) {
        const description = text(payload.description);
        if (description.length > MAX_DESCRIPTION) throw badRequest('description is too long', { field: 'description' });
        issue.description = description;
      }
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.updated', '更新议题内容', { issueId: issue.issueId }, now);
      return { issueId: issue.issueId };
    },

    'issue.setWorkspace': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const units = unitsOf(doc, issue.issueId);
      // The workspace is the contract with the session: once work started it is frozen
      // (units exist, or the status already left todo) — changing it would point the
      // next round at a different directory than the handovers describe.
      const started = units.length > 0 || (issue.status !== 'todo' && issue.status !== 'blocked');
      if (started) throw conflict('work has started: the issue workspace is frozen (C8)', { issueId: issue.issueId, units: units.length, status: issue.status });
      const next = normalizeWorkspacePath(payload.workspacePath);
      const before = issue.workspacePath;
      issue.workspacePath = next;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.workspace_changed',
        next === null ? '清除工作区' : '设置工作区：' + next, { from: before, to: next }, now);
      return { issueId: issue.issueId, workspacePath: next };
    },

    'issue.setStatus': ({ payload, doc, now, ports }) => {
      const issue = requireIssue(doc, payload.issueId);
      const status = payload.status;
      const allowed = new Set(['todo', 'in_progress', 'blocked', 'in_review']);
      if (status === 'cancelled') return commands.cancelInternal({ payload, doc, now, ports });
      if (!allowed.has(status)) throw badRequest('status must be one of todo/in_progress/blocked/in_review', { field: 'status' });
      requireTriaged(requireEditable(issue, doc));
      const units = unitsOf(doc, issue.issueId);
      if (issue.status === status) return { issueId: issue.issueId, status };
      const from = issue.status;
      issue.status = status;
      issue.statusPin = { at: now };
      issue.statusUndo = null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.status_manual', '人工改状态：' + from + ' → ' + status, { from, to: status }, now);
      return { issueId: issue.issueId, status };
    },

    'issue.undoAutoStatus': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireIssue(doc, payload.issueId));
      if (!undoAvailable(issue, Date.parse(now))) throw invalidState('nothing to undo (24h window or no automatic change)', { issueId: issue.issueId });
      const undo = issue.statusUndo;
      issue.status = undo.from;
      issue.statusPin = null;
      issue.statusUndo = null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.status_undo', '撤销自动变更：' + undo.to + ' → ' + undo.from, { from: undo.to, to: undo.from }, now);
      return { issueId: issue.issueId, status: issue.status };
    },

    'issue.comment': ({ payload, doc, now, ports }) => {
      const issue = requireIssue(doc, payload.issueId);
      const value = requireText(payload.text, 'text', 2000);
      const actor = payload.actor === 'ai' ? 'ai' : 'human';
      activitiesOf(doc.meta, issue, actor, 'comment.created', value, { issueId: issue.issueId }, now);
      return { issueId: issue.issueId };
    },

    'issue.suggestTriage': ({ payload, doc, now }) => {
      const issue = requireIssue(doc, payload.issueId);
      if (issue.isTriaged === true) throw invalidState('suggestion only applies to TODOs', { issueId: issue.issueId });
      const reason = requireText(payload.reason, 'reason', 500);
      activitiesOf(doc.meta, issue, 'ai', 'suggestion.created', reason, { issueId: issue.issueId, thread: issue.issueId }, now);
      return { issueId: issue.issueId, suggested: true };
    },

    'issue.finalAccept': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const units = unitsOf(doc, issue.issueId);
      if (issue.status !== 'in_review' || !terminalReview(issue, units)) {
        throw invalidState('terminal review is not available yet', { issueId: issue.issueId, status: issue.status });
      }
      const unmet = trimAcceptance(issue).filter((criterion) => criterion.done !== true);
      if (unmet.length > 0 && payload.acknowledgeUnmet !== true) {
        throw invalidState('acceptance criteria are not all met', { unmet: unmet.length });
      }
      issue.status = 'done';
      issue.statusPin = null;
      issue.statusUndo = null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.completed',
        unmet.length > 0 ? '终验收：带 ' + unmet.length + ' 条未满足项完成' : '终验收完成',
        { unmet: unmet.length, note: payload.note === undefined ? null : text(payload.note) }, now);
      return { issueId: issue.issueId, status: 'done', unmet: unmet.length };
    },

    'issue.finalReturn': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const units = unitsOf(doc, issue.issueId);
      if (issue.status !== 'in_review' || !terminalReview(issue, units)) {
        throw invalidState('terminal review is not available yet', { issueId: issue.issueId, status: issue.status });
      }
      const reason = requireText(payload.reason, 'reason', 2000);
      issue.status = 'in_progress';
      issue.statusPin = { at: now };
      issue.statusUndo = null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.reopened', '终验收退回：' + reason, { reason }, now);
      return { issueId: issue.issueId, status: 'in_progress' };
    },

    'issue.setArchived': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireIssue(doc, payload.issueId));
      const archived = payload.archived === true;
      if (archived && !closing(issue)) throw conflict('only done/cancelled issues can be archived', { issueId: issue.issueId, status: issue.status });
      issue.archivedAt = archived ? now : null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', archived ? 'issue.archived' : 'issue.unarchived',
        archived ? '归档议题' : '恢复议题', { issueId: issue.issueId }, now);
      return { issueId: issue.issueId, archived };
    },

    'acceptance.add': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const criteria = trimAcceptance(issue);
      if (criteria.length >= MAX_ACCEPTANCE) throw acceptanceError('at most ' + MAX_ACCEPTANCE + ' acceptance criteria are allowed');
      const criterion = newAcceptance({ text: payload.text }, now);
      criteria.push(criterion);
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.updated', '新增验收标准', { criterionId: criterion.id }, now);
      return { issueId: issue.issueId, criterion };
    },

    'acceptance.update': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const criteria = trimAcceptance(issue);
      const criterion = criteria.find((item) => item.id === payload.acceptanceId);
      if (!criterion) throw notFound('acceptance criterion not found', { acceptanceId: payload.acceptanceId });
      if (payload.text !== undefined) criterion.text = requireText(payload.text, 'text', MAX_ACCEPTANCE_TEXT);
      if (payload.done !== undefined) {
        criterion.done = payload.done === true;
        criterion.doneAt = criterion.done ? now : null;
      }
      finish(issue, now);
      return { issueId: issue.issueId, criterion };
    },

    'acceptance.remove': ({ payload, doc, now }) => {
      const issue = requireTriaged(requireEditable(requireIssue(doc, payload.issueId), doc));
      const criteria = trimAcceptance(issue);
      if (criteria.length <= 1) throw acceptanceError('at least one acceptance criterion is required');
      const index = criteria.findIndex((item) => item.id === payload.acceptanceId);
      if (index < 0) throw notFound('acceptance criterion not found', { acceptanceId: payload.acceptanceId });
      criteria.splice(index, 1);
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.updated', '删除验收标准', { acceptanceId: payload.acceptanceId }, now);
      return { issueId: issue.issueId, remaining: criteria.length };
    },

    /** Shared by issue.setStatus(cancelled) and issue.cancel. */
    cancelInternal: ({ payload, doc, now, ports }) => {
      const issue = requireTriaged(requireIssue(doc, payload.issueId));
      if (issue.archivedAt) throw conflict('archived issues are read-only', { issueId: issue.issueId });
      const wasStatus = issue.status;
      const units = unitsOf(doc, issue.issueId);
      const stopped = [];
      for (const unit of liveUnits(units)) {
        if (unit.execState === 'pending' || unit.execState === 'running') {
          unit.voided = true;
          unit.closeReason = 'cancelled';
          unit.exitReason = 'cancelled_by_user';
          unit.updatedAt = now;
          stopped.push(unit.unitId);
          if (ports && ports.sessions && typeof ports.sessions.cancel === 'function' && unit.sessionId) {
            try { ports.sessions.cancel(unit.sessionId); } catch {}
          }
        }
      }
      issue.status = 'cancelled';
      issue.statusPin = { at: now };
      issue.statusUndo = null;
      finish(issue, now);
      activitiesOf(doc.meta, issue, 'human', 'issue.cancelled', '取消议题' + (stopped.length ? '，停止 ' + stopped.length + ' 个在飞单元' : ''), { from: wasStatus, stopped }, now);
      return { issueId: issue.issueId, status: 'cancelled', stopped };
    },
  };
  commands['issue.cancel'] = commands.cancelInternal;
  return commands;
}
