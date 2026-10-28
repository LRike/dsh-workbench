/**
 * S9 · Workbench AI tool surface (host half).
 *
 * Official contract, read 2026-10-26 from the installed API catalog
 * (/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js) and
 * from @deepseek-ai/dsh-tools/lib/index.js:
 *
 *   tools.register(definition: ToolDefinition): () => void    // returns the exact disposer
 *   ToolDefinition extends ToolSchema {
 *     output: ToolOutputDefinition;                           // { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta? }
 *     execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
 *     projectContent?; finalizeContent?; timeoutMs?; isConcurrencySafe?; presentCall?; presentResult?;
 *   }
 *   ToolSchema { name: string; description: string; parameters: Record<string, unknown>; deferLoading?: true }
 *   ToolExecutionInput { callId; rootCallId?; name; schema?; arguments; agent?: Agent; parent?; signal: AbortSignal }
 *   Agent { readonly id: SessionId }                          // the caller's session id
 *   ContentBlock text block = { type: 'text', text: string }
 *   register() rejects a definition without output.render and validates output.schema with assertSupportedJsonSchema;
 *   the value returned by execute is validated against output.schema and then passed to output.render.
 *   A thrown Error becomes { isError: true, content: [{ type: 'text', text: 'Error: <message>' }] } (message only, no stack).
 *   Supported schema subset: type / oneOf / properties / required / additionalProperties / items / enum / const + annotations.
 *
 * We deliberately do not import `defineTool` from @deepseek-ai/dsh-tools: phase0 X4 proved bare
 * imports only resolve for `file:` installs (link: installs fail), so this file only uses the
 * ctx.tools service. parameters / output.schema below are therefore already in the compiled
 * JSON-Schema form that defineTool would have produced; argument validation is done by hand.
 *
 * Boundary: these eight tools can create a TODO, suggest triage, claim/create a unit, write a
 * handoff, push in_review|blocked, request a human decision and comment. There is intentionally
 * no tool for triage, unit accept/reject, final accept, done/cancelled, or delete.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

export const TOOL_NAMES = [
  'workbench_create_todo',
  'workbench_suggest_triage',
  'workbench_claim_unit',
  'workbench_create_unit',
  'workbench_write_handoff',
  'workbench_suggest_wrapup',
  'workbench_push_status',
  'workbench_request_decision',
  'workbench_comment',
];

/** Model-facing result schema shared by every tool (additionalProperties:false is enforced). */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the operation was accepted.' },
    message: { type: 'string', description: 'One or two short sentences for the model, including ids and the next step.' },
    issueId: { type: 'string', description: 'Issue code, e.g. WB-12.' },
    unitId: { type: 'string', description: 'Work-unit id.' },
    sessionId: { type: 'string', description: 'DSH session id.' },
    roundNo: { type: 'integer', description: 'Work-unit round number.' },
    decisionId: { type: 'string', description: 'Pending-decision id.' },
    status: { type: 'string', description: 'Issue status after the write.' },
    setupIssue: { type: 'string', description: 'create_failed or prompt_failed when session setup failed.' },
    seq: { type: 'integer', description: 'Activity seq of the comment.' },
    duplicateHints: { type: 'array', items: { type: 'string' }, description: 'Possible duplicate issue ids (advisory only).' },
  },
};

const ERROR_HINTS = {
  E_BAD_REQUEST: '参数不合法，未写入',
  E_NOT_FOUND: '找不到目标对象',
  E_CONFLICT: '当前状态不允许该操作',
  E_STATE: '当前状态不允许该操作',
  E_LIMIT: '旧的全局限流已取消（R4 已废弃）',
  E_ACCEPTANCE: '验收标准不满足',
  E_STORAGE: '保存失败，数据未改动',
  E_LOCK_TIMEOUT: '另一个窗口正在写入，请稍后重试',
  E_SCHEMA_TOO_NEW: '工作台数据由更新版本的插件写入，请先升级插件',
  E_INTERNAL: '内部错误',
};

/** One tool-level failure with a model-readable Chinese message (never a raw stack). */
class ToolFailure extends Error {
  /**
   * @param {string} message model-readable text
   * @param {string} [code] stable workbench error code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ToolFailure';
    this.code = code || 'E_TOOL';
  }
}

const fail = (message, code) => { throw new ToolFailure(message, code); };

/**
 * Convert a service failure into a short Chinese message plus the stable code.
 * The stack stays in the host log, never in the tool result.
 * @param {any} error
 * @returns {ToolFailure}
 */
function toToolFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'E_INTERNAL';
  const hint = ERROR_HINTS[code] || '操作失败';
  const detail = error && error.message ? String(error.message) : String(error || 'unknown error');
  return new ToolFailure(hint + '：' + detail + '（' + code + '）', code);
}

/**
 * Run one service command with a per-call idempotency key and normalize failures.
 * @param {any} service
 * @param {string} type command type, e.g. 'todo.create'
 * @param {any} payload
 * @returns {Promise<any>} the command result
 */
async function callService(service, type, payload) {
  try {
    const response = await service.execute({ type, payload, clientRequestId: 'ai-' + randomUUID() });
    return response && response.result !== undefined ? response.result : {};
  } catch (error) {
    throw toToolFailure(error);
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const trimText = (value) => asText(value).trim();

/**
 * @param {any} args
 * @param {string} field
 * @param {number} max
 * @param {string} label
 * @returns {string}
 */
function requireString(args, field, max, label) {
  const value = trimText(args && args[field]);
  if (value.length === 0) fail('缺少必填参数 ' + field + '（' + label + '）。');
  if (max > 0 && value.length > max) fail('参数 ' + field + ' 超过 ' + max + ' 个字符。');
  return value;
}

/**
 * @param {any} args
 * @param {string} field
 * @param {number} max
 * @returns {string | undefined}
 */
function optionalString(args, field, max) {
  if (args === undefined || args === null || args[field] === undefined || args[field] === null) return undefined;
  const value = trimText(args[field]);
  if (value.length === 0) return undefined;
  if (max > 0 && value.length > max) fail('参数 ' + field + ' 超过 ' + max + ' 个字符。');
  return value;
}

/** The calling agent's session id, when the host provides an agent context. */
function callerSessionId(exec) {
  const agent = exec && exec.agent ? exec.agent : undefined;
  return agent && typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : undefined;
}

/** @param {any} ctx @returns {any} the sessionController service when reachable */
function sessionControllerOf(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('sessionController');
    return ctx && ctx.sessionController ? ctx.sessionController : undefined;
  } catch (error) { return undefined; }
}

/**
 * Read the authoritative session row (cwd / running) for one session id.
 * Used to enrich claim (C2) and to find the caller's workspace; never trusted from model input.
 * @param {any} ctx
 * @param {string | undefined} sessionId
 * @param {(message: string) => void} warn
 * @returns {Promise<{ sessionId: string, cwd?: string, running?: boolean } | undefined>}
 */
async function readSessionRow(ctx, sessionId, warn) {
  if (!sessionId) return undefined;
  const controller = sessionControllerOf(ctx);
  if (!controller || typeof controller.list !== 'function') return undefined;
  try {
    const response = await controller.list({});
    const rows = Array.isArray(response) ? response : response && Array.isArray(response.items) ? response.items : [];
    const row = rows.find((item) => item && item.sessionId === sessionId);
    if (!row) return undefined;
    return {
      sessionId,
      cwd: typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined,
      running: typeof row.running === 'boolean' ? row.running : undefined,
    };
  } catch (error) {
    warn('listing sessions failed: ' + String(error && error.message ? error.message : error));
    return undefined;
  }
}

const stripTrailingSlashes = (value) => {
  const trimmed = value.replace(/[\\/]+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
};

/**
 * Compare two workspace paths, preferring canonical (realpath) equality like C2 does.
 * @param {string | undefined | null} left
 * @param {string | undefined | null} right
 * @returns {boolean}
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = stripTrailingSlashes(left);
  const b = stripTrailingSlashes(right);
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch (error) { return false; }
}

/** @param {any} service @param {string} issueId @param {string} unitId */
function unitFromIssue(service, issueId, unitId) {
  try {
    const detail = service.issueDetail(issueId);
    const units = detail && Array.isArray(detail.units) ? detail.units : [];
    const unit = units.find((item) => item && item.unitId === unitId);
    return unit ? { unit, issueId } : undefined;
  } catch (error) {
    if (error && error.code === 'E_SCHEMA_TOO_NEW') throw toToolFailure(error);
    return undefined;
  }
}

/**
 * Read one work unit and its issue id using only public read models.
 * Order: inbox (ended/abnormal/open-decision units) -> snapshot.stuckUnits ->
 * issues narrowed by the caller's workspace -> bounded scan of issues that own units.
 * @param {any} service
 * @param {any} ctx
 * @param {any} exec
 * @param {string} unitId
 * @param {(message: string) => void} warn
 * @returns {Promise<{ unit: any, issueId: string } | undefined>}
 */
async function resolveUnit(service, ctx, exec, unitId, warn) {
  try {
    const inbox = await service.inbox();
    // Accept both the documented shape (API.md §4.3: pendingReview.units / pendingDecision)
    // and the shipped read model (queries.js: reviewUnits / decisions).
    const review = inbox && inbox.pendingReview && Array.isArray(inbox.pendingReview.units) ? inbox.pendingReview.units
      : inbox && Array.isArray(inbox.reviewUnits) ? inbox.reviewUnits : [];
    const decisions = inbox && Array.isArray(inbox.pendingDecision) ? inbox.pendingDecision
      : inbox && Array.isArray(inbox.decisions) ? inbox.decisions : [];
    const hitReview = review.find((item) => item && item.unitId === unitId);
    const hitDecision = decisions.find((item) => item && item.unitId === unitId);
    const known = hitReview && hitReview.issueId ? hitReview.issueId : hitDecision && hitDecision.issueId ? hitDecision.issueId : undefined;
    if (known) { const found = unitFromIssue(service, known, unitId); if (found) return found; }
  } catch (error) {
    if (error && error.code === 'E_SCHEMA_TOO_NEW') throw toToolFailure(error);
  }

  let snapshot;
  try { snapshot = await service.snapshot(); } catch (error) {
    if (error && error.code === 'E_SCHEMA_TOO_NEW') throw toToolFailure(error);
  }
  const stuck = snapshot && Array.isArray(snapshot.stuckUnits) ? snapshot.stuckUnits.find((item) => item && item.unitId === unitId) : undefined;
  if (stuck && stuck.issueId) { const found = unitFromIssue(service, stuck.issueId, unitId); if (found) return found; }

  const caller = await readSessionRow(ctx, callerSessionId(exec), warn);
  const callerCwd = caller && caller.cwd ? caller.cwd : undefined;
  const candidates = [];
  const projects = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : [];
  for (const project of projects) {
    const issues = project && Array.isArray(project.issues) ? project.issues : [];
    for (const issue of issues) {
      const total = issue && issue.units && typeof issue.units.total === 'number' ? issue.units.total : 0;
      if (!issue || !issue.issueId || total <= 0) continue;
      candidates.push({ issueId: issue.issueId, workspacePath: issue.workspacePath, preferred: samePath(issue.workspacePath, callerCwd) });
    }
  }
  candidates.sort((left, right) => (right.preferred === true ? 1 : 0) - (left.preferred === true ? 1 : 0));
  const MAX_SCAN = 300;
  for (const candidate of candidates.slice(0, MAX_SCAN)) {
    const found = unitFromIssue(service, candidate.issueId, unitId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Enforce the tool boundary for unit-scoped writes.
 * With a caller session: unit.sessionId must equal it (no cross-session writes).
 * Without one: the unit is resolved to its issue anyway and a warning is recorded.
 * @param {{ service: any, ctx: any, exec: any, unitId: string, toolName: string, warn: (m: string) => void }} input
 * @returns {Promise<{ unit: any, issueId: string }>}
 */
async function authorizeUnit(input) {
  const found = await resolveUnit(input.service, input.ctx, input.exec, input.unitId, input.warn);
  if (!found) fail('找不到单元 ' + input.unitId + '，或它不在可操作范围内。请确认 unitId 来自 workbench_create_unit / workbench_claim_unit 的返回。');
  const callerId = callerSessionId(input.exec);
  const unitSessionId = found.unit && typeof found.unit.sessionId === 'string' ? found.unit.sessionId : undefined;
  if (callerId) {
    if (unitSessionId !== callerId) {
      fail('越权拒绝：单元 ' + input.unitId + ' 属于会话 ' + (unitSessionId || '（无会话）') + '，不是当前会话。AI 只能操作自己这一轮产生的单元。', 'E_TOOL_BOUNDARY');
    }
  } else {
    input.warn('tool ' + input.toolName + ' has no caller session context; allowed by unit ownership only (unit=' + input.unitId + ', issue=' + found.issueId + ')');
  }
  return found;
}

/** Render the shared result envelope as one model-readable text block. */
const render = (_args, value) => [{
  type: 'text',
  text: value && typeof value.message === 'string' ? value.message : JSON.stringify(value),
}];

/**
 * @param {{ name: string, description: string, parameters: Record<string, unknown>, run: (args: any, exec: any) => Promise<any> }} spec
 */
function buildTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      return spec.run(args && typeof args === 'object' ? args : {}, exec || {});
    },
  };
}

/**
 * Register the eight S9 tools on the official ToolRuntime.
 * @param {any} ctx a context where the `tools` service is reachable (inject ['tools'])
 * @param {any} service the workbench service facade (createService)
 * @param {any} [logger]
 * @returns {() => void} idempotent cleanup that unregisters every tool (use with ctx.effect)
 */
export function registerWorkbenchTools(ctx, service, logger) {
  const rawLogger = logger || (ctx && ctx.logger);
  const warn = (message) => { try { rawLogger && rawLogger.warn && rawLogger.warn('workbench: ' + message); } catch (error) { /* logging must never break a tool */ } };
  const info = (message) => { try { if (rawLogger && typeof rawLogger.info === 'function') rawLogger.info('workbench: ' + message); else warn(message); } catch (error) { /* logging must never break a tool */ } };
  const tools = ctx && ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('registerWorkbenchTools requires ctx.tools (official ToolRuntime); call it under inject ["tools"]');
  }

  const definitions = [
    buildTool({
      name: 'workbench_create_todo',
      description: '在工作台记一条待立项 TODO（只有标题是必填）。边界：只能建 TODO，不能立项、不能指定工作区或验收标准。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string', description: 'One-line TODO title (<=240 chars).' },
          description: { type: 'string', description: 'Optional details.' },
          projectId: { type: 'string', description: 'Optional project id to pre-fill at triage time.' },
        },
      },
      async run(args) {
        const title = requireString(args, 'title', 240, '一句话标题');
        const description = optionalString(args, 'description', 100000);
        const projectId = optionalString(args, 'projectId', 120);
        const payload = { title };
        if (description !== undefined) payload.description = description;
        if (projectId !== undefined) payload.projectId = projectId;
        const result = await callService(service, 'todo.create', payload);
        const issueId = result && result.issueId ? String(result.issueId) : '';
        const duplicateHints = result && Array.isArray(result.duplicateHints) ? result.duplicateHints.filter((item) => typeof item === 'string') : [];
        let message = '已记下 TODO ' + issueId + '。下一步：由人立项（AI 不能立项）；若确属重复可忽略。';
        if (duplicateHints.length > 0) message += ' 可能重复：' + duplicateHints.join('、') + '（只是提示，已保存）。';
        return { ok: true, message, issueId, duplicateHints };
      },
    }),

    buildTool({
      name: 'workbench_suggest_triage',
      description: '在某个 TODO 上留一条「建议立项」及理由，让收件箱显示建议角标。边界：不改立项状态、不写状态、不产生待拍板项。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['issueId', 'reason'],
        properties: {
          issueId: { type: 'string', description: 'TODO issue id, e.g. WB-7.' },
          reason: { type: 'string', description: 'Why this TODO looks worth triaging (<=500 chars).' },
        },
      },
      async run(args) {
        const issueId = requireString(args, 'issueId', 120, 'TODO 编号');
        const reason = requireString(args, 'reason', 500, '建议理由');
        await callService(service, 'issue.suggestTriage', { issueId, reason });
        return { ok: true, message: '已在 ' + issueId + ' 留下立项建议（仅角标与理由，立项状态未改）。', issueId };
      },
    }),

    buildTool({
      name: 'workbench_claim_unit',
      description: '把当前会话（或指定会话）认领成某个议题的工作单元。边界：只能认领自己的会话；要求议题已立项且有工作区，且目录与议题工作区一致（C2）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['issueId'],
        properties: {
          issueId: { type: 'string', description: 'Target issue id, e.g. WB-12.' },
          sessionId: { type: 'string', description: 'Session to claim; omit to use the current session. A different session than the caller is refused.' },
          goal: { type: 'string', description: 'One-line goal for this round (defaults to the issue title).' },
        },
      },
      async run(args, exec) {
        const issueId = requireString(args, 'issueId', 120, '议题编号');
        const callerId = callerSessionId(exec);
        const requested = optionalString(args, 'sessionId', 200);
        if (callerId && requested && requested !== callerId) fail('越权拒绝：只能认领当前会话，不能把别的会话挂到议题上。', 'E_TOOL_BOUNDARY');
        const sessionId = callerId || requested;
        if (!sessionId) fail('缺少会话上下文：请由 DSH 会话内调用本工具，或显式传 sessionId。');
        if (!callerId && requested) warn('claim_unit called without a caller session; claiming explicit session ' + requested);
        const row = await readSessionRow(ctx, sessionId, warn);
        const payload = { issueId, sessionId };
        const goal = optionalString(args, 'goal', 240);
        if (goal !== undefined) payload.goal = goal;
        if (row && row.cwd) payload.cwd = row.cwd;
        else warn('claim_unit could not read session cwd; C2 check falls back to the service rule (session=' + sessionId + ')');
        if (row && row.running === false) payload.sessionEnded = true;
        const result = await callService(service, 'unit.claim', payload);
        const unitId = result && result.unitId ? String(result.unitId) : '';
        const roundNo = result && typeof result.roundNo === 'number' ? result.roundNo : undefined;
        const execState = result && result.execState ? String(result.execState) : '';
        const stateText = execState === 'ended' ? '已结束·待验收' : '执行中';
        return {
          ok: true,
          message: '已认领 ' + issueId + ' 的' + (roundNo === undefined ? '' : '第 ' + roundNo + ' 轮') + '单元 ' + unitId + '（' + stateText + '）。下一步：' + (execState === 'ended' ? '由人验收这一轮' : '完成本轮工作后写交接并推状态') + '。',
          issueId,
          unitId,
          sessionId,
          ...(roundNo === undefined ? {} : { roundNo }),
        };
      },
    }),

    buildTool({
      name: 'workbench_create_unit',
      description: '为议题开新一轮并让 AI 建会话：先落「待执行」单元，再建 DSH 会话并下发首条指令。边界：要求议题已立项、有工作区、无活跃单元（R1）；不限制同时在跑的数量；不能代替人立项或验收。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['issueId', 'goal'],
        properties: {
          issueId: { type: 'string', description: 'Triaged issue id, e.g. WB-12.' },
          goal: { type: 'string', description: 'One-line goal for this round (<=240 chars).' },
        },
      },
      async run(args) {
        const issueId = requireString(args, 'issueId', 120, '议题编号');
        const goal = requireString(args, 'goal', 240, '本轮目标');
        const result = await callService(service, 'unit.startRound', { issueId, mode: 'ai', goal });
        const unitId = result && result.unitId ? String(result.unitId) : '';
        const sessionId = result && result.sessionId ? String(result.sessionId) : '';
        const roundNo = result && typeof result.roundNo === 'number' ? result.roundNo : undefined;
        let setupIssue;
        try {
          const detail = service.issueDetail(issueId);
          const units = detail && Array.isArray(detail.units) ? detail.units : [];
          const unit = units.find((item) => item && item.unitId === unitId);
          if (unit && typeof unit.setupIssue === 'string' && unit.setupIssue.length > 0) setupIssue = unit.setupIssue;
        } catch (error) { /* the unit row is already persisted; a read failure must not fail the tool */ }
        const suffix = setupIssue === 'create_failed'
          ? '注意：建会话失败（create_failed），单元已保留，可在议题详情点「重试建会话」。'
          : setupIssue === 'prompt_failed'
            ? '注意：首条指令发送失败（prompt_failed），可重发或人工打开会话继续。'
            : '下一步：在新会话里工作，结束时用 workbench_write_handoff 写四段交接，再用 workbench_push_status 推 in_review 或 blocked。';
        return {
          ok: true,
          message: '已开始 ' + issueId + ' 的' + (roundNo === undefined ? '新一轮' : '第 ' + roundNo + ' 轮') + '（单元 ' + unitId + '，会话 ' + sessionId + '）。' + suffix,
          issueId,
          unitId,
          sessionId,
          ...(roundNo === undefined ? {} : { roundNo }),
          ...(setupIssue === undefined ? {} : { setupIssue }),
        };
      },
    }),

    buildTool({
      name: 'workbench_write_handoff',
      description: '给本轮单元写四段交接（改动 / 验证 / 结果 / 剩余风险），全部非空才算有交接。边界：只能写自己这一轮的单元；不能验收、不能改议题状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'changes', 'verification', 'result', 'risks'],
        properties: {
          unitId: { type: 'string', description: 'Work unit id from create_unit / claim_unit.' },
          changes: { type: 'string', description: 'What changed (files, behaviour).' },
          verification: { type: 'string', description: 'How it was verified (commands, tests, manual checks).' },
          result: { type: 'string', description: 'Outcome of this round.' },
          risks: { type: 'string', description: 'Remaining risks / open items.' },
        },
      },
      async run(args, exec) {
        const unitId = requireString(args, 'unitId', 120, '单元 id');
        const changes = requireString(args, 'changes', 2000, '改动');
        const verification = requireString(args, 'verification', 2000, '验证');
        const resultText = requireString(args, 'result', 2000, '结果');
        const risks = requireString(args, 'risks', 2000, '剩余风险');
        const found = await authorizeUnit({ service, ctx, exec, unitId, toolName: 'workbench_write_handoff', warn });
        const issueStatus = found.issue && typeof found.issue.status === 'string' ? found.issue.status : '';
        const unitAccept = found.unit && typeof found.unit.acceptState === 'string' ? found.unit.acceptState : '';
        if (issueStatus === 'done' || issueStatus === 'cancelled' || unitAccept === 'passed') {
          fail('这个议题已经收尾（' + (issueStatus || 'passed') + '），交接是当时的证据，AI 不能再改写。需要修正请联系人手工编辑。', 'E_TOOL_BOUNDARY');
        }
        await callService(service, 'unit.writeHandoff', {
          unitId,
          handover: { change: changes, verify: verification, result: resultText, risk: risks },
          source: 'ai',
        });
        const roundNo = found.unit && typeof found.unit.roundNo === 'number' ? found.unit.roundNo : undefined;
        return {
          ok: true,
          message: '已写入 ' + found.issueId + (roundNo === undefined ? '' : ' 第 ' + roundNo + ' 号单元') + ' 的四段交接。收尾由人确认：如果这一轮做完了，用 workbench_suggest_wrapup 建议收尾；需要人拍板则用 workbench_push_status 推 blocked。',
          issueId: found.issueId,
          unitId,
          ...(roundNo === undefined ? {} : { roundNo }),
        };
      },
    }),

    buildTool({
      name: 'workbench_suggest_wrapup',
      description: '建议收尾这个单元（AI 只能建议，不能自己结束）：把「这一轮做完了」的信号写到单元上，人会在议题详情页看到并决定是否确认收尾。边界：不写交接、不改议题状态、不结束单元。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId'],
        properties: {
          unitId: { type: 'string', description: 'Work unit id from create_unit / claim_unit.' },
          reason: { type: 'string', description: 'One sentence: why this unit looks done (what is finished, what is left).' },
        },
      },
      async run(args, exec) {
        const unitId = requireString(args, 'unitId', 120, '单元 id');
        const reason = args.reason === undefined ? '' : requireString(args, 'reason', 500, '收尾理由');
        const found = await authorizeUnit({ service, ctx, exec, unitId, toolName: 'workbench_suggest_wrapup', warn });
        const result = await callService(service, 'unit.suggestWrapup', { unitId, note: reason });
        const roundNo = found.unit && typeof found.unit.roundNo === 'number' ? found.unit.roundNo : undefined;
        return {
          ok: true,
          message: '已向 ' + found.issueId + (roundNo === undefined ? '' : ' 的单元 #' + roundNo) + ' 发出收尾建议。它不会自己结束：人需要在议题详情页确认收尾并填写四段交接。',
          issueId: found.issueId,
          unitId,
          suggestion: result && result.wrapUpSuggestion ? result.wrapUpSuggestion : null,
          ...(roundNo === undefined ? {} : { roundNo }),
        };
      },
    }),

    buildTool({
      name: 'workbench_push_status',
      description: '把议题推到「等你确认」(in_review) 或「遇到阻碍」(blocked)，并附一句说明。边界：只能这两个状态；不能写 done / cancelled，不能验收单元，不能跳过人的终验收。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'status', 'note'],
        properties: {
          unitId: { type: 'string', description: 'Work unit id from create_unit / claim_unit.' },
          status: { type: 'string', enum: ['in_review', 'blocked'], description: 'in_review = normal finish; blocked = needs a human decision.' },
          note: { type: 'string', description: 'One sentence explaining why (visible in the activity log).' },
        },
      },
      async run(args, exec) {
        const unitId = requireString(args, 'unitId', 120, '单元 id');
        const status = requireString(args, 'status', 40, '目标状态');
        if (status !== 'in_review' && status !== 'blocked') {
          fail('越权拒绝：AI 只能推 in_review 或 blocked；完成/取消/验收必须由人操作。', 'E_TOOL_BOUNDARY');
        }
        const note = requireString(args, 'note', 500, '一句说明');
        const found = await authorizeUnit({ service, ctx, exec, unitId, toolName: 'workbench_push_status', warn });
        await callService(service, 'issue.setStatus', { issueId: found.issueId, status });
        await callService(service, 'issue.comment', { issueId: found.issueId, text: '（AI 推状态 → ' + status + '）' + note, actor: 'ai' });
        const label = status === 'in_review' ? '等你确认' : '遇到阻碍';
        return {
          ok: true,
          message: '已把 ' + found.issueId + ' 推到「' + label + '」，并记下说明。下一步：' + (status === 'in_review' ? '由人在议题详情做单元验收 / 终验收' : '等人在收件箱「等你拍板」里处置') + '。',
          issueId: found.issueId,
          unitId,
          status,
        };
      },
    }),

    buildTool({
      name: 'workbench_request_decision',
      description: '向人请求一个决策：一句原因 + 2~3 个选项（每个选项有一句影响说明）。边界：只写待拍板项，不改议题/单元状态；作答与忽略仍由人做，不能自己选答案。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'reason', 'options'],
        properties: {
          unitId: { type: 'string', description: 'Work unit id asking for the decision.' },
          reason: { type: 'string', description: 'Why a human must decide (<=500 chars).' },
          options: {
            type: 'array',
            description: '2 to 3 options; the first one is shown first.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: {
                label: { type: 'string', description: 'Short option label (<=200 chars).' },
                note: { type: 'string', description: 'One sentence on the impact of choosing it.' },
              },
            },
          },
        },
      },
      async run(args, exec) {
        const unitId = requireString(args, 'unitId', 120, '单元 id');
        const reason = requireString(args, 'reason', 500, '决策原因');
        const rawOptions = Array.isArray(args.options) ? args.options : [];
        if (rawOptions.length < 2 || rawOptions.length > 3) fail('需要 2~3 个选项，当前 ' + rawOptions.length + ' 个。');
        const options = rawOptions.map((option, index) => {
          const note = optionalString(option || {}, 'note', 500);
          return {
            label: requireString(option || {}, 'label', 200, '选项 ' + (index + 1) + ' 的文案'),
            ...(note === undefined ? {} : { note }),
          };
        });
        const found = await authorizeUnit({ service, ctx, exec, unitId, toolName: 'workbench_request_decision', warn });
        const result = await callService(service, 'ai.requestDecision', { unitId, issueId: found.issueId, reason, options });
        const decisionId = result && result.decisionId ? String(result.decisionId) : '';
        return {
          ok: true,
          message: '已写入待拍板项 ' + decisionId + '（' + options.length + ' 个选项），议题状态未改。下一步：等人作答后继续；不要自行选择答案。',
          issueId: found.issueId,
          unitId,
          decisionId,
        };
      },
    }),

    buildTool({
      name: 'workbench_comment',
      description: '在议题活动流里写一条评论（AI 署名）。边界：只写评论，不改状态、不改立项、不进收件箱。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['issueId', 'text'],
        properties: {
          issueId: { type: 'string', description: 'Issue id, e.g. WB-12.' },
          text: { type: 'string', description: 'Comment text (<=2000 chars).' },
        },
      },
      async run(args) {
        const issueId = requireString(args, 'issueId', 120, '议题编号');
        const text = requireString(args, 'text', 2000, '评论内容');
        await callService(service, 'issue.comment', { issueId, text, actor: 'ai' });
        let seq;
        try {
          const page = service.activity(issueId, undefined, 1);
          if (page && Array.isArray(page.items) && page.items.length > 0 && typeof page.items[0].seq === 'number') seq = page.items[0].seq;
        } catch (error) { /* comment is persisted; the seq is only a convenience */ }
        return {
          ok: true,
          message: '已写入评论' + (seq === undefined ? '' : '（活动序号 ' + seq + '）') + '。',
          issueId,
          ...(seq === undefined ? {} : { seq }),
        };
      },
    }),
  ];

  const disposers = [];
  for (const definition of definitions) {
    const dispose = tools.register(definition);
    if (typeof dispose === 'function') disposers.push({ name: definition.name, dispose });
    else warn('tool ' + definition.name + ' registration returned no disposer');
  }
  info('registered ' + definitions.length + ' AI tools');

  let disposed = false;
  return function disposeWorkbenchTools() {
    if (disposed) return;
    disposed = true;
    while (disposers.length > 0) {
      const entry = disposers.pop();
      if (!entry) continue;
      try { entry.dispose(); } catch (error) { warn('disposing tool ' + entry.name + ' failed: ' + String(error)); }
    }
  };
}
