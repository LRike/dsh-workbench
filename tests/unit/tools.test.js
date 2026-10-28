/**
 * S9 AI tool surface tests: fake ctx.tools + the real service over a temp store.
 *
 * These tests assert the observable contract only: tool names/description/schema,
 * one real write (create_todo), the in_review|blocked gate, the unit-ownership
 * boundary, the no-context warning path, claim enrichment and decision options.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../../host/store/repository.js';
import { createService } from '../../host/service/workbench.js';
import { registerWorkbenchTools, TOOL_NAMES } from '../../host/adapters/tools.js';

/** @returns {{ warnings: string[], info: Function, warn: Function, error: Function }} */
function makeLogger() {
  const warnings = [];
  return {
    warnings,
    info() {},
    error() {},
    warn(message) { warnings.push(String(message)); },
  };
}

/**
 * Build a fake ctx.tools plus a real service backed by a temp JSON document.
 * @param {{ ports?: any, sessionController?: any }} [options]
 */
function makeHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-tools-'));
  const file = join(root, 'workbench.json');
  const repository = createRepository({ file });
  repository.load();
  const logger = makeLogger();
  const service = createService({ repository, logger, ports: options.ports || {} });
  /** @type {{ sessionController: any }} */
  const state = { sessionController: options.sessionController };
  const registered = [];
  const disposed = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => { disposed.push(definition.name); };
      },
    },
    get(name) {
      if (name === 'sessionController') return state.sessionController;
      return undefined;
    },
    logger,
  };
  const dispose = registerWorkbenchTools(ctx, service, logger);
  return {
    root,
    file,
    repository,
    service,
    logger,
    registered,
    disposed,
    dispose,
    setSessionController(controller) { state.sessionController = controller; },
  };
}

/** @param {any} h @param {string} name */
function definitionOf(h, name) {
  const definition = h.registered.find((item) => item.name === name);
  assert.ok(definition, 'tool ' + name + ' must be registered');
  return definition;
}

/**
 * Execute one tool exactly like the ToolRuntime would (args + a minimal exec).
 * @param {any} h
 * @param {string} name
 * @param {any} args
 * @param {string} [sessionId]
 */
async function run(h, name, args, sessionId) {
  const definition = definitionOf(h, name);
  const value = await definition.execute(args, {
    callId: 'call-1',
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(sessionId ? { agent: { id: sessionId } } : {}),
  });
  const errors = [];
  validateValue(definition.output.schema, value, 'value', errors);
  assert.deepEqual(errors, [], name + ' must return a value matching its output schema');
  return value;
}

/**
 * A project + TODO + triaged issue whose workspace is the harness temp dir.
 * @param {any} h
 * @param {{ title?: string, workspacePath?: string }} [options]
 */
async function seedTriaged(h, options = {}) {
  const workspace = options.workspacePath || h.root;
  const project = await h.service.execute({ type: 'project.create', payload: { name: '项目', defaultWorkspacePath: workspace } });
  const todo = await h.service.execute({ type: 'todo.create', payload: { title: options.title || '议题' } });
  const issueId = todo.result.issueId;
  await h.service.execute({
    type: 'issue.triage',
    payload: { issueId, projectId: project.result.projectId, workspacePath: workspace, acceptance: [{ text: '完成' }] },
  });
  return { projectId: project.result.projectId, issueId, workspace };
}

/**
 * One triaged issue claimed by sessionId, returning the persisted unit id.
 * @param {any} h
 * @param {{ sessionId?: string, workspacePath?: string }} [options]
 */
async function seedUnit(h, options = {}) {
  const seeded = await seedTriaged(h, { workspacePath: options.workspacePath });
  const claimed = await h.service.execute({
    type: 'unit.claim',
    payload: { issueId: seeded.issueId, sessionId: options.sessionId || 'sess-owner', cwd: seeded.workspace },
  });
  return { ...seeded, unitId: claimed.result.unitId };
}

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SCHEMA_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

/**
 * Structural check mirroring the official supported subset (assertSupportedJsonSchema).
 * @param {any} node
 * @param {string} path
 * @param {string[]} errors
 */
function validateSchemaNode(node, path, errors) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(path + ' must be a schema object'); return; }
  for (const key of Object.keys(node)) if (!SCHEMA_KEYS.has(key)) errors.push(path + '.' + key + ' is not a supported keyword');
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) errors.push(path + ' declares both type and oneOf');
  if (!hasType) return;
  if (!SCHEMA_TYPES.has(node.type)) { errors.push(path + '.type is invalid'); return; }
  const allowedFor = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'] };
  for (const [key, types] of Object.entries(allowedFor)) if (Object.hasOwn(node, key) && !types.includes(node.type)) errors.push(path + '.' + key + ' is not allowed on ' + node.type);
  if (node.type === 'object') {
    if (node.properties !== undefined) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) errors.push(path + '.properties must be an object');
      else for (const [key, child] of Object.entries(node.properties)) validateSchemaNode(child, path + '.properties.' + key, errors);
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) errors.push(path + '.required must be a string array');
      else for (const key of node.required) if (!node.properties || !Object.hasOwn(node.properties, key)) errors.push(path + '.required names missing property ' + key);
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') errors.push(path + '.additionalProperties must be boolean');
  }
  if (node.type === 'array' && node.items !== undefined) validateSchemaNode(node.items, path + '.items', errors);
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) errors.push(path + '.enum must be a non-empty array');
}

/**
 * Validate one success value against a schema (the runtime does this before render).
 * @param {any} schema
 * @param {any} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(path + ' is not one of the enum values');
  if (!Object.hasOwn(schema, 'type')) return;
  const type = schema.type;
  const matches = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value)
        : type === 'number' ? typeof value === 'number'
          : type === 'string' ? typeof value === 'string'
            : type === 'boolean' ? typeof value === 'boolean'
              : type === 'null' ? value === null : false;
  if (!matches) { errors.push(path + ' must be ' + type); return; }
  if (type === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(path + '.' + key + ' is required');
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) validateValue(properties[key], value[key], path + '.' + key, errors);
      else if (schema.additionalProperties === false) errors.push(path + '.' + key + ' is not allowed');
    }
  }
  if (type === 'array' && schema.items) value.forEach((item, index) => validateValue(schema.items, item, path + '[' + index + ']', errors));
}

const fakeSessions = (rows) => ({ list: async () => ({ items: rows }) });

test('registers the nine S9 tools with description, JSON schema and an idempotent disposer', () => {
  const h = makeHarness();
  assert.deepEqual(h.registered.map((item) => item.name), TOOL_NAMES);
  assert.equal(TOOL_NAMES.length, 9);
  assert.ok(TOOL_NAMES.includes('workbench_suggest_wrapup'), 'the AI can suggest a wrap-up but never perform it');

  for (const definition of h.registered) {
    assert.equal(typeof definition.name, 'string');
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.includes('边界'), definition.name + ' description must state its boundary');
    const schemaErrors = [];
    validateSchemaNode(definition.parameters, 'parameters', schemaErrors);
    validateSchemaNode(definition.output.schema, 'output', schemaErrors);
    assert.deepEqual(schemaErrors, [], definition.name + ' schema must stay in the official supported subset');
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.parameters.properties && typeof definition.parameters.properties === 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.deepEqual(definition.output.render({}, { ok: true, message: '结果' }), [{ type: 'text', text: '结果' }]);
  }

  // No tool may expose triage / accept / reject / final-accept / delete.
  const forbidden = h.registered.filter((item) => /triage_issue|accept|reject|final|delete|done|cancel/i.test(item.name));
  assert.deepEqual(forbidden.map((item) => item.name), []);

  assert.equal(h.disposed.length, 0);
  h.dispose();
  assert.deepEqual(h.disposed.sort(), [...TOOL_NAMES].sort());
  h.dispose();
  assert.equal(h.disposed.length, TOOL_NAMES.length, 'dispose must be idempotent (one per tool, never doubled)');
});

test('create_todo writes a real TODO and reports duplicate hints without blocking', async () => {
  const h = makeHarness();
  const first = await run(h, 'workbench_create_todo', { title: 'SSO 登录流程' });
  assert.equal(first.ok, true);
  assert.match(first.issueId, /^WB-\d+$/);
  assert.deepEqual(first.duplicateHints, []);

  const todos = (await h.service.snapshot()).todos;
  assert.ok(todos.some((item) => item.issueId === first.issueId), 'the TODO must be readable from snapshot');

  const second = await run(h, 'workbench_create_todo', { title: 'SSO 登录' });
  assert.ok(second.duplicateHints.includes(first.issueId), 'a shorter similar title must produce a hint');
  assert.match(second.message, /可能重复/);

  await assert.rejects(() => run(h, 'workbench_create_todo', { title: '   ' }), /缺少必填参数 title/);
});

test('push_status rejects done/cancelled and only writes in_review or blocked', async () => {
  const h = makeHarness();
  const seeded = await seedUnit(h);

  await assert.rejects(
    run(h, 'workbench_push_status', { unitId: seeded.unitId, status: 'done', note: '想直接完成' }, 'sess-owner'),
    /越权拒绝/,
  );
  await assert.rejects(
    run(h, 'workbench_push_status', { unitId: seeded.unitId, status: 'cancelled', note: '想取消' }, 'sess-owner'),
    /越权拒绝/,
  );

  const pushed = await run(h, 'workbench_push_status', { unitId: seeded.unitId, status: 'in_review', note: '本轮跑完了' }, 'sess-owner');
  assert.equal(pushed.ok, true);
  assert.equal(pushed.status, 'in_review');

  const detail = h.service.issueDetail(seeded.issueId);
  assert.equal(detail.issue.status, 'in_review');
  assert.ok(
    detail.issue.activities.some((entry) => entry.type === 'comment.created' && entry.actor === 'ai' && String(entry.text).includes('本轮跑完了')),
    'the AI note must land in the activity log',
  );

  const blocked = await run(h, 'workbench_push_status', { unitId: seeded.unitId, status: 'blocked', note: '需要人来定' }, 'sess-owner');
  assert.equal(blocked.status, 'blocked');
  assert.equal(h.service.issueDetail(seeded.issueId).issue.status, 'blocked');
});

test('unit-scoped tools refuse a unit owned by another session (no cross-session writes)', async () => {
  const h = makeHarness();
  const seeded = await seedUnit(h);

  await assert.rejects(
    run(h, 'workbench_write_handoff', { unitId: seeded.unitId, changes: 'a', verification: 'b', result: 'c', risks: 'd' }, 'sess-intruder'),
    /越权拒绝/,
  );
  await assert.rejects(
    run(h, 'workbench_request_decision', { unitId: seeded.unitId, reason: 'r', options: [{ label: 'A' }, { label: 'B' }] }, 'sess-intruder'),
    /越权拒绝/,
  );
  await assert.rejects(
    run(h, 'workbench_push_status', { unitId: seeded.unitId, status: 'blocked', note: 'n' }, 'sess-intruder'),
    /越权拒绝/,
  );
});

test('without a caller session the write is allowed but loudly logged, never silent', async () => {
  const h = makeHarness();
  const seeded = await seedUnit(h);

  const result = await run(h, 'workbench_write_handoff', { unitId: seeded.unitId, changes: '改动', verification: '测试', result: '完成', risks: '无' });
  assert.equal(result.ok, true);
  assert.ok(
    h.logger.warnings.some((line) => line.includes('no caller session context')),
    'a missing caller session must be logged',
  );

  const detail = h.service.issueDetail(seeded.issueId);
  const unit = detail.units.find((item) => item.unitId === seeded.unitId);
  assert.equal(unit.handover.source, 'ai');
  assert.equal(unit.handover.change, '改动');
  assert.equal(unit.handover.risk, '无');
});

test('claim_unit only claims the caller session and takes cwd from the host but not from the model', async () => {
  const h = makeHarness();
  const seeded = await seedTriaged(h);
  h.setSessionController(fakeSessions([{ sessionId: 'sess-owner', cwd: seeded.workspace, running: true }]));

  await assert.rejects(
    run(h, 'workbench_claim_unit', { issueId: seeded.issueId, sessionId: 'sess-other' }, 'sess-owner'),
    /越权拒绝/,
  );

  const claimed = await run(h, 'workbench_claim_unit', { issueId: seeded.issueId }, 'sess-owner');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.sessionId, 'sess-owner');
  assert.ok(claimed.unitId);

  const detail = h.service.issueDetail(seeded.issueId);
  assert.equal(detail.issue.status, 'in_progress');
  const unit = detail.units.find((item) => item.unitId === claimed.unitId);
  assert.equal(unit.sessionId, 'sess-owner');
  assert.equal(unit.execState, 'running');
});

test('create_unit starts a round, creates the session and leaves a running AI unit', async () => {
  const plans = [];
  const h = makeHarness({
    ports: {
      sessions: {
        list: async () => ({ items: [] }),
        listWorkspaces: async () => [],
        startRound: async (plan) => { plans.push(plan); return { sessionId: plan.sessionId }; },
        sendMessage: async () => {},
        cancel: () => {},
      },
    },
  });
  const seeded = await seedTriaged(h);

  const created = await run(h, 'workbench_create_unit', { issueId: seeded.issueId, goal: '实现 S9' });
  assert.equal(created.ok, true);
  assert.equal(created.issueId, seeded.issueId);
  assert.ok(created.unitId);
  assert.ok(created.sessionId);
  assert.equal(plans.length, 1);
  assert.match(plans[0].title, /^WB-\d+ · 第1轮 · 实现 S9$/);

  const detail = h.service.issueDetail(seeded.issueId);
  assert.equal(detail.issue.status, 'in_progress');
  const unit = detail.units.find((item) => item.unitId === created.unitId);
  assert.equal(unit.createdBy, 'ai');
  assert.equal(unit.execState, 'running');
});

test('request_decision needs 2..3 options and surfaces one open pending decision', async () => {
  const h = makeHarness();
  const seeded = await seedUnit(h);

  await assert.rejects(
    run(h, 'workbench_request_decision', { unitId: seeded.unitId, reason: 'r', options: [{ label: '只有一个' }] }, 'sess-owner'),
    /2~3 个选项/,
  );
  await assert.rejects(
    run(h, 'workbench_request_decision', { unitId: seeded.unitId, reason: 'r', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] }, 'sess-owner'),
    /2~3 个选项/,
  );

  const asked = await run(
    h,
    'workbench_request_decision',
    { unitId: seeded.unitId, reason: '两条验收标准冲突', options: [{ label: '以 PRD 为准', note: '留差异记录' }, { label: '以 concepts 为准' }] },
    'sess-owner',
  );
  assert.equal(asked.ok, true);
  assert.match(asked.decisionId, /^d_/);

  /** @type {any} */
  const inbox = await h.service.inbox();
  const decisions = Array.isArray(inbox.decisions) ? inbox.decisions : inbox.pendingDecision || [];
  assert.ok(decisions.some((item) => item.decisionId === asked.decisionId && item.kind === 'ai_decision'));
  assert.equal(h.service.issueDetail(seeded.issueId).issue.status, 'in_progress', 'asking must not change the issue status');
});

test('suggest_triage works only on TODOs and comment returns the activity seq', async () => {
  const h = makeHarness();
  const todo = await h.service.execute({ type: 'todo.create', payload: { title: '一个想法' } });
  const suggested = await run(h, 'workbench_suggest_triage', { issueId: todo.result.issueId, reason: '看起来值得做' });
  assert.equal(suggested.issueId, todo.result.issueId);

  const todos = (await h.service.snapshot()).todos;
  assert.equal(todos.find((item) => item.issueId === todo.result.issueId).hasAiSuggestion, true);

  const seeded = await seedTriaged(h);
  await assert.rejects(
    run(h, 'workbench_suggest_triage', { issueId: seeded.issueId, reason: '已立项不该再建议' }),
    /当前状态不允许该操作/,
  );

  const commented = await run(h, 'workbench_comment', { issueId: seeded.issueId, text: '一条评论' });
  assert.equal(typeof commented.seq, 'number');
  const detail = h.service.issueDetail(seeded.issueId);
  assert.ok(detail.issue.activities.some((entry) => entry.type === 'comment.created' && entry.actor === 'ai'));
});
