/* ---- 32-issue-detail.js：议题详情（P2） ----
   props: { issueRef, refreshKey, reload, navigate }
   navigate 约定与 33/34/35 一致：navigate(view, ref?, anchor?)
   读取：GET /issue?id=<WB-12|issueId>（API.md §4.2）；另取 GET /snapshot 只为 running 计数。
   写操作全部走 apiCommand，失败按 error.code 行内提示；每次成功后 props.reload() + 重新拉详情。
   无 import/export/JSX；内部标识统一 wbD 前缀。 */

const WB_D_STATUS_LABEL = {
  todo: '待认领', in_progress: '处理中', blocked: '遇到阻碍', in_review: '等你确认', done: '完成', cancelled: '取消',
};
const WB_D_EXEC_LABEL = { pending: '待执行', running: '执行中', wrapping: '待收尾', ended: '已结束', failed: '异常结束' };
const WB_D_ACCEPT_LABEL = { pending: '待验收', passed: '通过', rejected: '打回' };
const WB_D_CLOSE_LABEL = {
  cancelled: '已取消', rejected: '被打回', unbound: '已解绑', retried: '已重试', dismissed: '改回待认领',
};
const WB_D_SOURCE_LABEL = { ai: 'AI 自写', human: '人工自写', synthesized: '系统合成，待确认' };
const WB_D_ACTOR_LABEL = { human: '我', system: '系统', ai: 'AI' };
const WB_D_ERROR_TEXT = {
  E_BAD_REQUEST: '参数不合法', E_FORBIDDEN: '来源校验失败', E_NOT_FOUND: '找不到对象',
  E_CONFLICT: '操作冲突（R1 活跃单元 / C2 目录不匹配 / C8 有单元不可换工作区 / N7 收尾或归档只读）',
  E_LIMIT: '在跑已达上限（3/3），先收一轮', E_STATE: '当前状态不允许这个动作',
  E_ACCEPTANCE: '验收标准不合法（为空 / 超 20 条 / 删最后一条）',
  E_TEXT: '文本为空或超长（标题上限 240、验收标准上限 1000 字）', E_STORAGE: '写盘失败，数据未改动',
  E_LOCK_TIMEOUT: '数据正被另一个窗口写入，请重试', E_SCHEMA_TOO_NEW: '数据版本高于插件版本', E_INTERNAL: '内部错误',
};
const wbDErrText = (error) => {
  const code = error && error.code;
  const mapped = code ? WB_D_ERROR_TEXT[code] : null;
  const message = error && error.message ? String(error.message) : '';
  if (!mapped) return message || '操作失败';
  return message && message !== mapped ? mapped + '：' + message : mapped;
};

const WB_D_BTN = { padding: '4px 10px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: TOKENS.text, fontSize: '12px', lineHeight: 1.4, cursor: 'pointer' };
const WB_D_BTN_PRIMARY = { padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + TOKENS.accent, background: 'transparent', color: TOKENS.accent, fontSize: '12px', fontWeight: 600, lineHeight: 1.4, cursor: 'pointer' };
const WB_D_INPUT = { padding: '5px 8px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: TOKENS.bg, color: TOKENS.text, fontSize: '12px', lineHeight: 1.5, minWidth: 0 };
const WB_D_MUTED = { fontSize: '12px', color: TOKENS.textSecondary };
const WB_D_CARD = { border: '1px solid ' + TOKENS.border, borderRadius: '10px', background: TOKENS.bg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' };
const WB_D_SECTION_TITLE = { margin: 0, fontSize: '14px', color: TOKENS.text };
const WB_D_SMALL_CARD = { border: '1px solid ' + TOKENS.border, borderRadius: '8px', background: TOKENS.bgSecondary, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '4px' };

const wbDTime = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (value) => (value < 10 ? '0' + value : String(value));
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
};
const wbDBadge = (text, attribute) => h('span', {
  ['data-wb-' + (attribute || 'badge')]: text,
  style: { padding: '1px 8px', borderRadius: '999px', border: '1px solid ' + TOKENS.border, color: TOKENS.textSecondary, fontSize: '11px', whiteSpace: 'nowrap' },
}, text);
/** One primary status per unit. 执行中/运行中/待验收 used to be three overlapping tags:
 *  acceptState defaults to 'pending', so a running unit showed "待验收" too early. */
function wbDUnitStatus(unit) {
  if (unit.voided) return { label: '已作废' + (unit.closeReason ? ' · ' + (WB_D_CLOSE_LABEL[unit.closeReason] || unit.closeReason) : ''), tone: 'unit-voided' };
  if (unit.execState === 'failed') return { label: '异常结束', tone: 'unit-failed' };
  if (unit.execState === 'running') return { label: unit.stuck ? '执行中 · 疑似停滞' : '执行中', tone: 'unit-running' };
  if (unit.execState === 'wrapping') return { label: '待收尾 · 需要收尾确认', tone: 'unit-wrapping' };
  if (unit.execState === 'pending') return { label: '待执行', tone: 'unit-exec' };
  if (unit.acceptState === 'passed') return { label: '已通过', tone: 'unit-passed' };
  if (unit.acceptState === 'rejected') return { label: '被打回', tone: 'unit-rejected' };
  return { label: '已结束 · 待验收', tone: 'unit-accept' };
}
const wbDLine = (error, scope) => {
  if (!error) return null;
  return h('div', { 'data-wb-inline-error': scope || 'detail', style: { fontSize: '12px', color: TOKENS.text, borderLeft: '3px solid ' + TOKENS.border, paddingLeft: '8px' } }, wbDErrText(error));
};
/** navigate 约定与 33/34/35 一致：navigate(view, ref?, anchor?)；view: 'progress' | 'board' | 'inbox' | 'search' | 'issue' | 'triage'。 */
const wbDGo = (navigate, view, ref) => {
  if (typeof navigate !== 'function') return;
  try {
    navigate(view, ref === undefined ? null : ref);
  } catch (error) {
    /* shell 负责路由；跳转失败不影响本页数据 */
  }
};

/** 交接四段（DATA-MODEL 2.6 / API 4.2 handoff）：缺任一段视为无交接 → N1 兜底。 */
function wbDHandoff(props) {
  const unit = props.unit;
  const raw = unit.handoff || unit.handover || null;
  const pick = (primary, fallback) => {
    if (!raw) return '';
    const value = raw[primary] !== undefined ? raw[primary] : raw[fallback];
    return value === undefined || value === null ? '' : String(value);
  };
  const sections = [
    { key: 'changes', label: '改动', value: pick('changes', 'change') },
    { key: 'verification', label: '验证', value: pick('verification', 'verify') },
    { key: 'result', label: '结果', value: pick('result', 'result') },
    { key: 'risks', label: '剩余风险', value: pick('risks', 'risk') },
  ];
  const complete = sections.every((section) => section.value.trim() !== '');
  const source = raw && raw.source ? raw.source : null;

  return h('div', { 'data-wb-handoff': unit.unitId, style: Object.assign({}, WB_D_SMALL_CARD, { gap: '6px' }) },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('span', { style: WB_D_MUTED }, '本轮交接'),
      source ? wbDBadge(WB_D_SOURCE_LABEL[source] || source, 'handoff-source') : null,
      complete ? null : h('span', { style: WB_D_MUTED, 'data-wb-handoff-missing': unit.unitId }, '交接缺失：缺任一段即视为无交接'),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', {
        type: 'button',
        disabled: props.busyKey !== null,
        style: WB_D_BTN,
        onClick: () => props.onSynthesize(unit.unitId),
      }, complete && source !== 'synthesized' ? '让 AI 重写交接' : '让 AI 重写（合成草稿）'),
    ),
    complete
      ? h('dl', { style: { margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: '12px' } },
          sections.map((section) => h('div', { key: section.key, style: { display: 'contents' } },
            h('dt', { style: { color: TOKENS.textSecondary } }, section.label),
            h('dd', { style: { margin: 0, color: TOKENS.text, whiteSpace: 'pre-wrap' } }, section.value),
          )),
        )
      : h('span', { style: WB_D_MUTED }, '没有可信的收尾证据时，系统会用「最后几轮对话 + 退出原因」合成一份草稿，等你确认。'),
  );
}

/** 议题详情：页头 / 验收标准 / 工作单元 / 开始这一轮 / 终验收 / 活动流与撤销。 */
function IssueDetailView(props) {
  const issueRef = props.issueRef;
  const [phase, setPhase] = React.useState('loading');
  const [detail, setDetail] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [busyKey, setBusyKey] = React.useState(null);
  const busyRef = React.useRef(0);
  const [actionError, setActionError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [titleEditing, setTitleEditing] = React.useState(false);
  const [workspaceDraft, setWorkspaceDraft] = React.useState('');
  const [criterionDraft, setCriterionDraft] = React.useState('');
  const [rejectingUnitId, setRejectingUnitId] = React.useState(null);
  const [rejectReason, setRejectReason] = React.useState('');
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [finalConfirm, setFinalConfirm] = React.useState(false);
  const [returnReason, setReturnReason] = React.useState('');
  const [goalDraft, setGoalDraft] = React.useState('');
  const [wrappingUnitId, setWrappingUnitId] = React.useState(null);
  const [wrapDraft, setWrapDraft] = React.useState({ change: '', verify: '', result: '', risk: '' });
  const [startResult, setStartResult] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const body = await apiGet('/issue?id=' + encodeURIComponent(String(issueRef || '')));
      setDetail(body && body.data ? body.data : null);
      setPhase('ready');
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
      setPhase(caught && caught.code === 'E_NOT_FOUND' ? 'missing' : 'error');
    }
  }, [issueRef]);

  React.useEffect(() => { void load(); }, [load, props.refreshKey]);

  // Refresh the page data every 10s so the view follows the host. It must never
  // interrupt typing: skip a tick while a field inside this page has focus, while a
  // write is in flight, or while the tab is hidden (nothing to show).
  React.useEffect(() => {
    const REFRESH_MS = 10000;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const typing = Boolean(active && active.closest && active.closest('[data-wb-panel]') && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      if (typing) return;
      if (busyRef.current > 0) return;
      void load();
    }, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  });

  const act = React.useCallback(async (key, run, keepResult) => {
    busyRef.current += 1;
    setBusyKey(key);
    setActionError(null);
    setNotice(null);
    try {
      const result = await run();
      if (!keepResult) {
        setConfirmCancel(false);
        setRejectingUnitId(null);
        setRejectReason('');
        setTitleEditing(false);
        if (props.reload) props.reload();
        await load();
      }
      return result;
    } catch (caught) {
      setActionError(caught);
      return null;
    } finally {
      busyRef.current = Math.max(0, busyRef.current - 1);
      setBusyKey(null);
    }
  }, [load, props.reload]);

  const issue = detail && detail.issue ? detail.issue : null;
  const issueId = issue ? (issue.issueId || issue.code) : '';
  const code = issue ? (issue.code || issue.issueId) : String(issueRef || '');
  const acceptance = issue ? (issue.acceptanceCriteria || issue.acceptance || []) : [];
  /* host 实际把 units 放在 detail 顶层（queries.buildIssueDetail）；同时兼容 API.md §4.2 的 issue.units 形态 */
  const rawUnits = detail && Array.isArray(detail.units) ? detail.units
    : (issue && Array.isArray(issue.units) ? issue.units : []);
  const units = rawUnits.slice().sort((left, right) => (left.roundNo || 0) - (right.roundNo || 0));
  const liveUnits = units.filter((unit) => !unit.voided);
  const activeUnits = liveUnits.filter((unit) => unit.execState === 'pending' || unit.execState === 'running' || unit.acceptState === 'pending');
  const status = issue ? issue.status : '';
  const closing = status === 'done' || status === 'cancelled';
  const archived = Boolean(issue && issue.archivedAt);
  // Terminal (done/cancelled) is final: the page goes fully read-only, no 开工入口 at all.
  const readOnly = archived || Boolean(issue && issue.projectArchived) || closing;
  const writable = !readOnly;
  const unmet = acceptance.filter((item) => !item.done).length;
  const terminalReview = Boolean(issue && issue.terminalReview);
  /* R4 与禁用原因以 host 的 detail.start 为准（queries.startAvailability） */
  const startInfo = detail && detail.start ? detail.start : null;
  const undo = issue ? (issue.undo || issue.undoableAutoStatus || null) : null;
  const undoFresh = undo && undo.at ? (Date.now() - Date.parse(undo.at) < 24 * 60 * 60 * 1000) : false;

  const startDisabledReason = (() => {
    if (startInfo) {
      if (startInfo.available === true) return null;
      const reasons = Array.isArray(startInfo.reasons) ? startInfo.reasons.filter((reason) => reason) : [];
      if (reasons.length > 0) return reasons.join('；');
    }
    if (readOnly) return '议题已归档：只读，恢复后才能开工';
    if (closing) return '议题已' + (status === 'done' ? '完成' : '取消') + '（收尾状态），只有人能显式改回';
    if (!issue || !issue.workspacePath) return '先给议题指定工作区，否则不能开工';
    if (activeUnits.length > 0) return '已有活跃单元（R1）：先验收或处置它，再开下一轮';
    return null;
  })();

  const openSession = (sessionId) => {
    if (!sessionId) { setNotice('这个单元没有绑定会话'); return; }
    if (wbOpenSession(sessionId)) { setNotice('已打开会话 ' + String(sessionId).slice(0, 20)); return; }
    setNotice('打不开会话：当前 shell 没有暴露 uiWorkspace.openSession');
  };

  const copyText = (text, label) => {
    const done = () => setNotice(label + '已复制');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => setNotice(text));
        return;
      }
    } catch (caught) {
      setNotice(text);
      return;
    }
    setNotice(text);
  };

  if (phase === 'loading') {
    return h('div', { 'data-wb-issue-detail': 'loading', style: Object.assign({}, WB_D_MUTED, { padding: '32px' }) }, '加载议题中…');
  }
  if (phase === 'missing' || phase === 'error') {
    return h('div', { 'data-wb-issue-detail': phase, style: Object.assign({}, WB_D_CARD, { gap: '10px' }) },
      h('h3', { style: WB_D_SECTION_TITLE }, phase === 'missing' ? '议题不存在' : '读取议题失败'),
      h('span', { style: WB_D_MUTED }, phase === 'missing'
        ? '数据里没有这个编号。若它是已归档议题，请到「已归档」里打开（归档不等于删除）。'
        : wbDErrText(loadError)),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { type: 'button', style: WB_D_BTN, onClick: () => void load() }, '重试'),
        h('button', { type: 'button', style: WB_D_BTN, onClick: () => wbDGo(props.navigate, 'progress') }, '返回工作台'),
      ),
    );
  }

  const acceptedCount = acceptance.filter((item) => item.done).length;

  const acceptanceBlock = h('section', { 'data-wb-acceptance': 'list', style: WB_D_CARD },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('h3', { style: WB_D_SECTION_TITLE }, '验收标准'),
      h('span', { style: WB_D_MUTED }, acceptedCount + '/' + acceptance.length + ' 已勾'),
      h('span', { style: WB_D_MUTED }, '全部勾完 ≠ 完成：完成仍要单独走终验收'),
      h('span', { style: { flex: '1 1 auto' } }),
      readOnly ? null : h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('input', { value: criterionDraft, placeholder: '新增一条标准（≤1000 字）', maxLength: 1000, onChange: (event) => setCriterionDraft(event.target.value), style: Object.assign({}, WB_D_INPUT, { width: '220px' }) }),
        h('button', {
          type: 'button',
          style: WB_D_BTN,
          disabled: busyKey !== null || criterionDraft.trim() === '' || acceptance.length >= 20,
          onClick: () => {
            const text = criterionDraft.trim();
            if (text === '') return;
            void act('acceptance-add', async () => {
              await apiCommand('acceptance.add', { issueId: issueId, text: text });
              setCriterionDraft('');
            });
          },
        }, '＋加一条'),
      ),
    ),
    acceptance.length === 0
      ? h('span', { style: WB_D_MUTED, 'data-wb-acceptance-empty': 'empty' }, '验收标准不能为空；立项时必须至少 1 条。')
      : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
          acceptance.map((item) => h('li', { key: item.id, 'data-wb-acceptance': item.id, style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(item.done),
              disabled: readOnly || busyKey !== null,
              onChange: (event) => void act('acceptance-done:' + item.id, () => apiCommand('acceptance.update', { issueId: issueId, acceptanceId: item.id, done: event.target.checked })),
            }),
            h('input', {
              defaultValue: item.text,
              disabled: readOnly,
              style: Object.assign({}, WB_D_INPUT, { flex: '1 1 auto' }),
              onBlur: (event) => {
                const text = event.target.value.trim();
                if (text === '' || text === item.text) return;
                void act('acceptance-text:' + item.id, () => apiCommand('acceptance.update', { issueId: issueId, acceptanceId: item.id, text: text }));
              },
            }),
            h('span', { style: WB_D_MUTED }, item.doneAt ? wbDTime(item.doneAt) : ''),
            readOnly ? null : h('button', {
              type: 'button',
              style: WB_D_BTN,
              disabled: busyKey !== null || acceptance.length <= 1,
              onClick: () => void act('acceptance-remove:' + item.id, () => apiCommand('acceptance.remove', { issueId: issueId, acceptanceId: item.id })),
            }, '删除'),
          )),
        ),
  );

  const unitRow = (unit, index) => {
    const round = unit.roundNo || index + 1;
    const rounds = Number.isFinite(unit.turnCount) ? unit.turnCount : 0;
    const live = !unit.voided && (unit.execState === 'running' || unit.execState === 'wrapping' || unit.execState === 'pending');
    const wrapping = wrappingUnitId === unit.unitId;
    const isFailed = unit.execState === 'failed' && !unit.voided;
    const canReview = unit.execState === 'ended' && unit.acceptState === 'pending' && !unit.voided;
    const rejecting = rejectingUnitId === unit.unitId;
    return h('li', {
      key: unit.unitId,
      'data-wb-unit': unit.unitId,
      'data-wb-unit-state': (unit.execState || '') + ':' + (unit.acceptState || '') + ':' + (unit.voided ? 'voided' : 'live'),
      style: Object.assign({}, WB_D_SMALL_CARD, { gap: '8px', opacity: unit.voided ? 0.72 : 1 }),
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
        h('strong', { style: { fontSize: '13px' } }, '单元 #' + round),
        wbDBadge(rounds + ' 轮', 'unit-turns'),
        h('span', { style: { fontSize: '13px' } }, unit.goal || '（未写目标）'),
        wbDBadge(wbDUnitStatus(unit).label, 'unit-status'),
        unit.wrapUpSuggestion && live ? wbDBadge('AI 建议收尾', 'unit-suggestion') : null,
        h('span', { style: { flex: '1 1 auto' } }),
        unit.sessionId
          ? h('button', {
              type: 'button',
              style: WB_D_BTN,
              disabled: busyKey !== null,
              onClick: () => openSession(unit.sessionId, unit.sessionTitle),
            }, '打开对话')
          : h('span', { style: WB_D_MUTED }, '待执行 · 还没开始'),
      ),
      unit.setupIssue ? h('div', { 'data-wb-setup-issue': unit.setupIssue, style: { fontSize: '12px', color: TOKENS.text, borderLeft: '3px solid ' + TOKENS.border, paddingLeft: '8px' } },
        unit.setupIssue === 'create_failed' ? '建会话失败（create_failed）：单元已落库、会话没建起来，可重试建会话。' : '首条指令发送失败（prompt_failed）：会话已存在，可重发或人工打开继续。',
      ) : null,
      h(wbDHandoff, {
        unit: unit,
        busyKey: busyKey,
        onSynthesize: (unitId) => void act('synthesize:' + unitId, () => apiCommand('unit.synthesizeHandoff', { unitId: unitId })),
      }),
      unit.voided || readOnly ? null : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
        isFailed
          ? h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
              h('span', { style: WB_D_MUTED }, '异常结束只能处置（不能判通过）：'),
              h('button', { type: 'button', style: WB_D_BTN_PRIMARY, disabled: busyKey !== null, onClick: () => void act('retry:' + unit.unitId, () => apiCommand('unit.retry', { unitId: unit.unitId })) }, '重试'),
              h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null, onClick: () => void act('back:' + unit.unitId, () => apiCommand('decision.backToTodo', { unitId: unit.unitId })) }, '改回待认领'),
              h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null, onClick: () => void act('snooze:' + unit.unitId, () => apiCommand('decision.snooze', { kind: 'unit_abnormal', subjectRef: unit.unitId, hours: 24, issueId: issueId, unitId: unit.unitId })) }, '继续等（24 小时）'),
            )
          : canReview
            ? h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
                h('button', { type: 'button', 'data-wb-accept': unit.unitId, style: WB_D_BTN_PRIMARY, disabled: busyKey !== null || (unit.needsHandoff === true && !unit.handover), onClick: () => void act('accept:' + unit.unitId, () => apiCommand('unit.accept', { unitId: unit.unitId })) }, '通过单元 #' + round),
                h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null, onClick: () => { setRejectingUnitId(rejecting ? null : unit.unitId); setRejectReason(''); } }, unit.sessionAvailable === false ? '打回（会话已关闭，将作废重开）' : '打回（回执行中继续）'),
                unit.needsHandoff === true && !unit.handover
                  ? h('span', { 'data-wb-needs-handoff': unit.unitId, style: WB_D_MUTED }, '这个单元没有交接（老数据迁移来的）：先补交接再判断，不能直接通过')
                  : null,
                unit.needsHandoff === true && !unit.handover
                  ? h('button', { type: 'button', 'data-wb-synthesize': unit.unitId, style: WB_D_BTN, disabled: busyKey !== null, onClick: () => void act('synthesize:' + unit.unitId, () => apiCommand('unit.synthesizeHandoff', { unitId: unit.unitId })) }, '合成交接草稿')
                  : null,
              )
            : live
              ? h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
                  unit.wrapUpSuggestion
                    ? h('span', { 'data-wb-wrapup-suggested': unit.unitId, style: WB_D_MUTED }, 'AI 建议收尾' + (unit.wrapUpSuggestion.note ? '：' + unit.wrapUpSuggestion.note : '') + ' —— 确认与否由你决定')
                    : null,
                  h('button', {
                    type: 'button',
                    'data-wb-wrapup': unit.unitId,
                    style: WB_D_BTN_PRIMARY,
                    disabled: busyKey !== null,
                    onClick: () => {
                      // Two-step ending: with no handover yet, the first click asks THIS
                      // unit's own session to summarize; nothing ends until the human confirms.
                      if (!unit.handover) {
                        void act('asksummary:' + unit.unitId, async () => {
                          const res = await apiCommand('unit.wrapup', { unitId: unit.unitId });
                          const needsSummary = Boolean(res && res.data && res.data.result && res.data.result.needsSummary);
                          setNotice(needsSummary ? '已请这个单元的 AI 写交接，等它写完再确认收尾（也可以自己填）' : '已收尾');
                        });
                        return;
                      }
                      setWrappingUnitId(wrapping ? null : unit.unitId);
                      setWrapDraft({ change: unit.handover.change || '', verify: unit.handover.verify || '', result: unit.handover.result || '', risk: unit.handover.risk || '' });
                    },
                  }, wrapping ? '先不收尾' : (unit.handover ? '结束本单元（确认交接）' : '结束本单元（请 AI 写交接）')),
                  unit.wrapRequest && !unit.handover
                    ? h('span', { 'data-wb-wrapwaiting': unit.unitId, style: WB_D_MUTED }, '已请求 AI 总结交接，等待中…')
                    : null,
                  unit.wrapRequest && !unit.handover
                    ? h('button', { type: 'button', 'data-wb-wrapmanual': unit.unitId, style: WB_D_BTN, disabled: busyKey !== null, onClick: () => { setWrappingUnitId(unit.unitId); setWrapDraft({ change: '', verify: '', result: '', risk: '' }); } }, '我自己填')
                    : null,
                  h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null, onClick: () => void act('void:' + unit.unitId, () => apiCommand('unit.void', { unitId: unit.unitId, reason: '人工作废' })) }, '作废本单元'),
                  h('span', { style: WB_D_MUTED }, '收尾要写四段交接：没有交接时先让 AI 总结，再由你确认；不打磨了就直接作废'),
                )
              : h('span', { style: WB_D_MUTED }, unit.execState === 'passed' ? '' : '这一单元暂无可做的验收动作'),
        wrapping ? h('div', { 'data-wb-wrapform': unit.unitId, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('span', { style: WB_D_MUTED }, '四段交接（缺一不可，系统不接受空段）：改动 / 验证 / 结果 / 剩余风险'),
          ['change', 'verify', 'result', 'risk'].map((field) => h('input', {
            key: field,
            'data-wb-wrapfield': field,
            value: wrapDraft[field],
            placeholder: { change: '改动：做了什么', verify: '验证：怎么确认的', result: '结果：达成/未达成', risk: '剩余风险' }[field],
            onChange: (event) => setWrapDraft(Object.assign({}, wrapDraft, { [field]: event.target.value })),
            style: WB_D_INPUT,
          })),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', 'data-wb-wrapconfirm': unit.unitId, style: WB_D_BTN_PRIMARY, disabled: busyKey !== null || ['change', 'verify', 'result', 'risk'].some((field) => String(wrapDraft[field] || '').trim() === ''), onClick: () => void act('wrapup:' + unit.unitId, async () => { await apiCommand('unit.wrapup', { unitId: unit.unitId, handover: { change: wrapDraft.change.trim(), verify: wrapDraft.verify.trim(), result: wrapDraft.result.trim(), risk: wrapDraft.risk.trim() }, source: 'human' }); setWrappingUnitId(null); }) }, '确认收尾 → 待验收'),
            h('span', { style: WB_D_MUTED }, '收尾后议题进入「等你确认」'),
          ),
        ) : null,
        rejecting ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { value: rejectReason, placeholder: '打回必须写一句原因', onChange: (event) => setRejectReason(event.target.value), style: Object.assign({}, WB_D_INPUT, { flex: '1 1 240px' }) }),
          h('button', {
            type: 'button',
            style: WB_D_BTN_PRIMARY,
            disabled: busyKey !== null || rejectReason.trim() === '',
            onClick: () => {
              const reason = rejectReason.trim();
              if (reason === '') return;
              void act('reject:' + unit.unitId, () => apiCommand('unit.reject', { unitId: unit.unitId, reason: reason, ...(unit.sessionAvailable === false ? { sessionUnavailable: true } : {}) }));
            },
          }, '确认打回第 ' + round + ' 轮'),
        ) : null,
      ),
    );
  };

  const startBox = !writable ? null : h('section', { 'data-wb-start': 'box', style: WB_D_CARD },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('h3', { style: WB_D_SECTION_TITLE }, '开始这一轮'),
      h('span', { style: WB_D_MUTED }, startDisabledReason || '同一页只有这一个开工入口'),
    ),
    startDisabledReason
      ? h('span', { style: WB_D_MUTED, 'data-wb-start-disabled': 'reason' }, '禁用原因：' + startDisabledReason)
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', { value: goalDraft, placeholder: '本轮目标（可空）', onChange: (event) => setGoalDraft(event.target.value), style: Object.assign({}, WB_D_INPUT, { flex: '1 1 260px' }) }),
            h('button', {
              type: 'button',
              style: WB_D_BTN_PRIMARY,
              disabled: busyKey !== null,
              onClick: () => void act('start-ai', async () => {
                const result = await apiCommand('unit.startRound', { issueId: issueId, mode: 'ai', goal: goalDraft.trim() || undefined });
                setStartResult({ mode: 'ai', data: result && result.data ? result.data : null });
                setGoalDraft('');
              }),
            }, busyKey === 'start-ai' ? '正在开会话…' : '开始这一轮 · 让 AI 开'),
            h('button', {
              type: 'button',
              style: WB_D_BTN,
              disabled: busyKey !== null,
              onClick: () => void act('start-me', async () => {
                const result = await apiCommand('unit.startRound', { issueId: issueId, mode: 'me', goal: goalDraft.trim() || undefined });
                setStartResult({ mode: 'me', data: result && result.data ? result.data : null });
              }, true),
            }, '开始这一轮 · 我开对话'),
          ),
          startResult && startResult.mode === 'me'
            ? h('div', { 'data-wb-start': 'me-result', style: Object.assign({}, WB_D_SMALL_CARD, { gap: '6px' }) },
                h('span', { style: WB_D_MUTED }, '在 DSH 新开会话，回来后用「认领」把它挂成单元：'),
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('code', { style: { fontSize: '12px', wordBreak: 'break-all' } }, (startResult.data && startResult.data.cwd) || issue.workspacePath || '（无目录）'),
                  h('button', { type: 'button', style: WB_D_BTN, onClick: () => copyText((startResult.data && startResult.data.cwd) || issue.workspacePath || '', '目录') }, '复制目录'),
                ),
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('code', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, (startResult.data && startResult.data.promptSuggestion) || '（服务端未返回起始指令）'),
                  h('button', { type: 'button', style: WB_D_BTN, onClick: () => copyText((startResult.data && startResult.data.promptSuggestion) || '', '起始指令') }, '复制起始指令'),
                ),
                h('span', { style: WB_D_MUTED }, '「我开对话」不建单元：单元在你回来认领时才落库。'),
              )
            : null,
          startResult && startResult.mode === 'ai'
            ? h('div', { 'data-wb-start': 'ai-result', style: WB_D_SMALL_CARD },
                h('span', { style: { fontSize: '12px' } }, (startResult.data && startResult.data.sessionId ? '已开会话 ' + startResult.data.sessionId : '已落下待执行单元') + (startResult.data && startResult.data.setupIssue ? '，但：' + startResult.data.setupIssue : '')),
              )
            : null,
        ),
  );

  const finalBlock = terminalReview && !readOnly ? h('section', { 'data-wb-final': 'box', style: WB_D_CARD },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('h3', { style: WB_D_SECTION_TITLE }, '终验收'),
      h('span', { style: WB_D_MUTED }, '无待验收单元、无待执行单元才能出现；完成只能由人在这里写'),
      h('span', { style: { flex: '1 1 auto' } }),
    ),
    h('span', { style: WB_D_MUTED }, '验收标准 ' + acceptedCount + '/' + acceptance.length + ' 已勾' + (unmet > 0 ? '，还有 ' + unmet + ' 条未满足' : '，全部满足')),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('button', {
        type: 'button',
        'data-wb-final': 'accept',
        style: WB_D_BTN_PRIMARY,
        disabled: busyKey !== null || readOnly,
        onClick: () => {
          if (unmet > 0 && !finalConfirm) { setFinalConfirm(true); return; }
          void act('final-accept', () => apiCommand('issue.finalAccept', { issueId: issueId, acknowledgeUnmet: unmet > 0 }));
        },
      }, unmet > 0 ? (finalConfirm ? '确认：带 ' + unmet + ' 条未满足项完成' : '带 ' + unmet + ' 条未满足项完成') : '完成'),
      unmet > 0 && finalConfirm ? h('button', { type: 'button', style: WB_D_BTN, onClick: () => setFinalConfirm(false) }, '先不完成') : null,
    ),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('input', { value: returnReason, placeholder: '退回必须写一句原因', onChange: (event) => setReturnReason(event.target.value), style: Object.assign({}, WB_D_INPUT, { flex: '1 1 260px' }) }),
      h('button', {
        type: 'button',
        'data-wb-final': 'return',
        style: WB_D_BTN,
        disabled: busyKey !== null || readOnly || returnReason.trim() === '',
        onClick: () => {
          const reason = returnReason.trim();
          if (reason === '') return;
          void act('final-return', async () => {
            await apiCommand('issue.finalReturn', { issueId: issueId, reason: reason });
            setReturnReason('');
          });
        },
      }, '退回（议题回处理中）'),
    ),
  ) : null;

  const unitItems = units.map((unit, index) => unit.voided
    ? h('li', { key: unit.unitId, style: { listStyle: 'none' } },
        h('details', { 'data-wb-unit': unit.unitId, style: WB_D_SMALL_CARD },
          h('summary', { style: Object.assign({}, WB_D_MUTED, { cursor: 'pointer' }) }, '第 ' + (unit.roundNo || index + 1) + ' 轮 · ' + (WB_D_EXEC_LABEL[unit.execState] || unit.execState) + ' · ' + (WB_D_ACCEPT_LABEL[unit.acceptState] || unit.acceptState) + ' · 已作废（不计进度）'),
          h('span', { style: { fontSize: '12px', marginTop: '4px' } }, unit.goal || ''),
        )
      )
    : unitRow(unit, index));

  const activities = (issue.activities || []).slice(-50).reverse();

  return h('div', {
    'data-wb-issue-detail': code,
    style: { display: 'flex', flexDirection: 'column', gap: '14px', color: TOKENS.text },
  },
    h('header', { style: Object.assign({}, WB_D_CARD, { gap: '12px' }) },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
        h('button', { type: 'button', style: WB_D_BTN, onClick: () => wbDGo(props.navigate, 'progress') }, '← 工作台'),
        h('span', { style: { fontSize: '13px', color: TOKENS.textSecondary } }, code),
        titleEditing
          ? h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', flex: '1 1 320px' } },
              h('input', { value: titleDraft, maxLength: 240, onChange: (event) => setTitleDraft(event.target.value), style: Object.assign({}, WB_D_INPUT, { flex: '1 1 280px' }) }),
              h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null || titleDraft.trim() === '', onClick: () => void act('title', () => apiCommand('issue.update', { issueId: issueId, title: titleDraft.trim() })) }, '保存'),
              h('button', { type: 'button', style: WB_D_BTN, onClick: () => setTitleEditing(false) }, '取消'),
            )
          : h('h1', { style: { margin: 0, fontSize: '19px' } }, issue.title || '（无标题）'),
        readOnly ? null : h('button', { type: 'button', style: WB_D_BTN, onClick: () => { setTitleDraft(issue.title || ''); setTitleEditing(true); } }, '改标题'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', style: WB_D_BTN, onClick: () => copyText(window.location.origin + window.location.pathname + '?issue=' + encodeURIComponent(code), '深链') }, '复制深链'),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
        h('span', { style: WB_D_MUTED }, '状态'),
        status === 'done'
          ? h('span', { 'data-wb-status': 'done' }, wbDBadge('完成（不可从此处写入）', 'status'))
          : h('select', {
              'data-wb-status': 'select',
              value: status,
              disabled: busyKey !== null || readOnly,
              onChange: (event) => {
                const next = event.target.value;
                if (next === 'cancelled') { setConfirmCancel(true); return; }
                void act('status', () => apiCommand('issue.setStatus', { issueId: issueId, status: next }));
              },
              style: WB_D_INPUT,
            },
              h('option', { value: 'todo' }, '待认领'),
              h('option', { value: 'in_progress' }, '处理中'),
              h('option', { value: 'blocked' }, '遇到阻碍'),
              h('option', { value: 'in_review' }, '等你确认'),
              h('option', { value: 'cancelled' }, '取消（需确认，停掉在飞单元）'),
            ),
        wbDBadge('类别 ' + (issue.category || '—'), 'category'),
        h('span', { style: WB_D_MUTED }, '项目：' + (issue.projectName || issue.projectId || '—')),
        h('span', { style: { flex: '1 1 auto' } }),
        readOnly ? wbDBadge('已归档 · 只读', 'archived') : null,
        issue.archivedAt ? h('button', { type: 'button', style: WB_D_BTN, disabled: busyKey !== null, onClick: () => void act('unarchive', () => apiCommand('issue.setArchived', { issueId: issueId, archived: false })) }, '恢复议题') : null,
      ),
      confirmCancel ? h('div', { 'data-wb-status': 'cancel-confirm', style: WB_D_SMALL_CARD },
        h('span', { style: { fontSize: '12px' } }, '取消议题 = 明确不做了：会停掉在飞单元（内容保留、单元作废），不删除任何数据。'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'button', style: WB_D_BTN_PRIMARY, disabled: busyKey !== null, onClick: () => void act('cancel', () => apiCommand('issue.cancel', { issueId: issueId })) }, '确认取消议题'),
          h('button', { type: 'button', style: WB_D_BTN, onClick: () => setConfirmCancel(false) }, '再想想'),
        ),
      ) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
        h('span', { style: WB_D_MUTED }, '工作区'),
        readOnly || closing || rawUnits.length > 0
          ? h('span', { 'data-wb-workspace-locked': rawUnits.length > 0 ? 'units' : 'readonly', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              h('span', { style: { fontSize: '12px' } }, issue.workspacePath || '未指定工作区'),
              rawUnits.length > 0 && !readOnly && !closing
                ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '已开工：工作区不可更改（换目录请新开议题）')
                : null,
            )
          : h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
              h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
                h(WorkspaceField, {
                  value: workspaceDraft === '' ? (issue.workspacePath || null) : workspaceDraft,
                  onChange: (next) => setWorkspaceDraft(next || ''),
                  label: '议题工作区',
                  emptyLabel: '不指定工作区（不能开工）',
                }),
              ),
              h('button', {
                type: 'button',
                style: WB_D_BTN,
                disabled: busyKey !== null || rawUnits.length > 0,
                onClick: () => void act('workspace', () => apiCommand('issue.setWorkspace', { issueId: issueId, workspacePath: workspaceDraft.trim() || null })),
              }, '保存工作区'),
              rawUnits.length > 0 ? h('span', { style: WB_D_MUTED }, '已有单元，不能换工作区（C8）') : null,
            ),
        issue.workspacePath ? null : wbDBadge('未指定工作区 · 不能开工', 'no-workspace'),
      ),
      h('p', { style: { margin: 0, fontSize: '13px', color: TOKENS.textSecondary, whiteSpace: 'pre-wrap' } }, issue.description || '（没有描述）'),
      wbDLine(actionError, 'header'),
      notice ? h('div', { 'data-wb-notice': 'notice', style: WB_D_MUTED }, notice) : null,
    ),
    undoFresh && writable ? h('section', { 'data-wb-undo': 'box', style: Object.assign({}, WB_D_SMALL_CARD, { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }) },
      h('span', { style: { fontSize: '12px' } }, '最近一次自动变更：' + (WB_D_STATUS_LABEL[undo.from] || undo.from) + ' → ' + (WB_D_STATUS_LABEL[undo.to] || undo.to) + '（' + wbDTime(undo.at) + ' 系统写入）'),
      h('button', { type: 'button', style: WB_D_BTN_PRIMARY, disabled: busyKey !== null, onClick: () => void act('undo', () => apiCommand('issue.undoAutoStatus', { issueId: issueId })) }, '撤销自动变更'),
      h('span', { style: WB_D_MUTED }, '只在 24 小时内、最近 1 次有效'),
    ) : null,
    acceptanceBlock,
    h('section', { 'data-wb-units': 'list', style: WB_D_CARD },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
        h('h3', { style: WB_D_SECTION_TITLE }, '工作单元'),
        h('span', { style: WB_D_MUTED }, '共 ' + units.length + ' 轮 · 作废的默认折叠'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: WB_D_MUTED }, '作废单元不计入进度与验收队列'),
      ),
      unitItems.length === 0
        ? h('span', { style: WB_D_MUTED, 'data-wb-units': 'empty' }, '还没有工作单元：从下面「开始这一轮」或对话内「认领」开始。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' } }, unitItems),
    ),
    startBox,
    finalBlock,
    h('section', { 'data-wb-activities': 'list', style: WB_D_CARD },
      h('h3', { style: WB_D_SECTION_TITLE }, '活动流（最近 50 条）'),
      activities.length === 0
        ? h('span', { style: WB_D_MUTED }, '还没有活动。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '5px' } },
            activities.map((activity) => h('li', { key: String(activity.seq), 'data-wb-activity': String(activity.seq), style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px' } },
              h('span', { style: { color: TOKENS.textSecondary, minWidth: '104px' } }, wbDTime(activity.at)),
              wbDBadge(WB_D_ACTOR_LABEL[activity.actor] || activity.actor || '未知', 'activity-actor'),
              h('span', { style: { color: TOKENS.textSecondary, minWidth: '130px' } }, activity.type || ''),
              h('span', { style: { color: TOKENS.text } }, activity.text || ''),
            )),
          ),
    ),
  );
}
