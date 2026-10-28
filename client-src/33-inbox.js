/* 收件箱（PRD FR-40）：两个决策分区 + 一个待立项记录区。
   本文件同时定义 wb* 小助手（错误文案 / 导航 / 时间 / 编号轮次），
   34-board.js 与 35-search.js 复用；共享作用域，无 import/export。 */

/** 待拍板项的 4 类 kind（concepts §5.4 / PRD FR-40）。 */
const WB_DECISION_KIND_LABELS = {
  unit_abnormal: '单元异常结束',
  issue_no_workspace: '没有工作区，无法开工',
  ai_decision: 'AI 请求决策',
  issue_zombie: '僵尸处理中',
};

/** error.code → 中文（API.md §3）。 */
const WB_ERROR_TEXT = {
  E_BAD_REQUEST: '请求有误，请检查输入',
  E_FORBIDDEN: '本地接口拒绝了这个请求（来源校验失败）',
  E_NOT_FOUND: '这条记录已不存在',
  E_CONFLICT: '当前状态不允许该操作',
  E_LIMIT: '在跑已满 3 个，先收一轮',
  E_STATE: '当前状态不允许该操作',
  E_ACCEPTANCE: '验收标准不合法',
  E_TEXT: '文本为空或超长（标题上限 240、验收标准上限 1000 字）',
  E_STORAGE: '保存失败，未改动',
  E_LOCK_TIMEOUT: '另一个窗口正在写入，请重试',
  E_SCHEMA_TOO_NEW: '数据版本比插件新，无法写入',
  E_INTERNAL: '本地接口内部错误',
};

/** @param {any} error */
function wbErrorText(error) {
  if (!error) return '';
  const mapped = error.code ? WB_ERROR_TEXT[error.code] : undefined;
  return mapped || String(error.message || error);
}

/** 调 shell 的 navigate；shell 未接线时静默降级为不跳转。 */
function wbNavigate(props, view, ref, anchor) {
  const navigate = props ? props.navigate : undefined;
  if (typeof navigate !== 'function') return;
  try { navigate(view, ref === undefined ? null : ref, anchor); } catch { /* shell 负责路由 */ }
}

/** 议题引用：优先可读编号（WB-12），回退内部 id。 */
function wbIssueRef(row) {
  if (!row) return '';
  return String(row.code || row.issueId || '');
}

/** 第 N 轮：宿主给 roundNo（DATA-MODEL）或 round（API.md 4.3），缺省按第 1 轮。 */
function wbRoundNo(row) {
  const value = row ? (row.roundNo !== undefined ? row.roundNo : row.round) : undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** 相对时间（最近活动）；解析失败回退原串。 */
function wbTimeAgo(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return String(iso);
  const delta = Math.max(0, Date.now() - then);
  const minute = 60000;
  if (delta < minute) return '刚刚';
  if (delta < 60 * minute) return Math.floor(delta / minute) + ' 分钟前';
  if (delta < 24 * 60 * minute) return Math.floor(delta / (60 * minute)) + ' 小时前';
  return Math.floor(delta / (24 * 60 * minute)) + ' 天前';
}

/** 绝对时间（延后到点）：MM-DD HH:mm。 */
function wbDateTime(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
}

/** 按钮样式：mini = 次要入口（不用深色主强调，FR-40）。 */
function wbButtonStyle(tone) {
  const base = { borderRadius: '6px', cursor: 'pointer', font: 'inherit', lineHeight: 1.4, whiteSpace: 'nowrap' };
  if (tone === 'mini') return { ...base, padding: '2px 8px', fontSize: '11px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: TOKENS.textSecondary };
  if (tone === 'link') return { ...base, padding: '2px 0', fontSize: '12px', border: 'none', background: 'transparent', color: TOKENS.accent };
  return { ...base, padding: '4px 10px', fontSize: '12px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: TOKENS.text };
}

/** 统一按钮：忙碌时禁用。 */
function wbButton(options) {
  const style = wbButtonStyle(options.tone);
  if (options.disabled) { style.opacity = 0.5; style.cursor = 'not-allowed'; }
  return h('button', {
    type: 'button',
    onClick: options.disabled ? undefined : options.onClick,
    disabled: Boolean(options.disabled),
    title: options.title,
    'data-wb-action': options.action,
    style,
  }, options.label);
}

function wbRowNote(text) {
  return h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, text);
}

function wbBanner(text, tone) {
  const error = tone === 'error';
  return h('div', {
    ...(error ? { 'data-wb-error': 'inbox' } : { 'data-wb-notice': 'inbox' }),
    style: {
      padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
      background: error ? 'color-mix(in srgb, ' + TOKENS.danger + ' 12%, transparent)' : 'color-mix(in srgb, ' + TOKENS.accent + ' 12%, transparent)',
      color: error ? TOKENS.danger : TOKENS.accent,
    },
  }, text);
}

function inboxSectionTitle(text, extra) {
  return h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' } },
    h('h2', { style: { margin: 0, fontSize: '15px' } }, text),
    extra ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, extra) : null,
  );
}

function inboxEmpty(text) {
  return h('div', {
    'data-wb-empty': 'inbox',
    style: { padding: '20px', border: '1px dashed ' + TOKENS.border, borderRadius: '8px', textAlign: 'center', color: TOKENS.textSecondary, fontSize: '12px' },
  }, text);
}

/**
 * 收件箱视图。
 * @param {{ snapshot?: any, reload?: () => any, navigate?: (view: string, ref?: any, anchor?: string) => void }} props
 */
function InboxView(props) {
  const snapshot = props ? props.snapshot : null;
  const counters = snapshot && snapshot.counters ? snapshot.counters : null;
  const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
  const [selected, setSelected] = React.useState({});
  const [rejecting, setRejecting] = React.useState(null);
  const [reason, setReason] = React.useState('');
  const [confirmBatch, setConfirmBatch] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [todosOpen, setTodosOpen] = React.useState(true);
  const [formError, setFormError] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const body = await apiGet('/inbox');
      setState({ phase: 'ready', data: body.data || {}, error: null });
    } catch (error) {
      setState((previous) => ({ phase: previous.data ? 'ready' : 'error', data: previous.data, error: wbErrorText(error) }));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const refresh = React.useCallback(async () => {
    await load();
    if (props && typeof props.reload === 'function') { try { await props.reload(); } catch { /* 计数刷新失败不影响列表 */ } }
  }, [load, props]);

  const run = React.useCallback(async (tag, work) => {
    setBusy(tag); setFormError(null);
    try { await work(); await refresh(); }
    catch (error) { setFormError(wbErrorText(error)); }
    finally { setBusy(null); }
  }, [refresh]);

  const inbox = state.data || {};
  /* 兼容两种形状：API.md §4.3 的嵌套式（pendingReview/pendingDecision）与
     宿主 buildInbox 的扁平式（reviewUnits/terminalReviews/decisions + counts）。 */
  const review = inbox.pendingReview;
  const unitRows = Array.isArray(review && review.units) ? review.units : (Array.isArray(inbox.reviewUnits) ? inbox.reviewUnits : []);
  const terminalRows = Array.isArray(review && review.terminalReviews) ? review.terminalReviews : (Array.isArray(inbox.terminalReviews) ? inbox.terminalReviews : []);
  const wrapupRows = Array.isArray(inbox.wrapupUnits) ? inbox.wrapupUnits : [];
  const suggestionRows = Array.isArray(inbox.suggestedUnits) ? inbox.suggestedUnits : [];
  const decisionRows = Array.isArray(inbox.pendingDecision) ? inbox.pendingDecision : (Array.isArray(inbox.decisions) ? inbox.decisions : []);
  const todoRows = Array.isArray(inbox.todos) ? inbox.todos : [];
  const inboxCounts = inbox.counts && typeof inbox.counts === 'object' ? inbox.counts : null;
  const counter = (key, fallback) => {
    if (counters && counters[key] !== undefined) return counters[key];
    if (inboxCounts && inboxCounts[key] !== undefined) return inboxCounts[key];
    return fallback;
  };
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  const toggleSelected = (unitId) => {
    setSelected((previous) => ({ ...previous, [unitId]: !previous[unitId] }));
    setConfirmBatch(false);
  };

  const acceptUnit = (unitId, round) => run('accept:' + unitId, async () => {
    await apiCommand('unit.accept', { unitId });
    setSelected((previous) => { const next = { ...previous }; delete next[unitId]; return next; });
    setNotice('已通过单元 #' + round + ' —— 只写单元，不改议题状态');
  });

  const submitReject = (unitId) => {
    const text = String(reason || '').trim();
    if (!text) { setFormError('打回必须填一句原因'); return; }
    void run('reject:' + unitId, async () => {
      const row = unitRows.find((item) => item.unitId === unitId);
      await apiCommand('unit.reject', { unitId, reason: text, ...(row && row.sessionAvailable === false ? { sessionUnavailable: true } : {}) });
      setRejecting(null); setReason(''); setNotice('已打回：同一单元回到执行中继续（不新建、不作废）');
    });
  };

  const batchAccept = () => run('batch', async () => {
    const failed = [];
    for (const unitId of selectedIds) {
      try { await apiCommand('unit.accept', { unitId }); }
      catch (error) { failed.push(String(unitId) + '：' + wbErrorText(error)); }
    }
    setSelected({}); setConfirmBatch(false);
    if (failed.length > 0) throw Object.assign(new Error(failed.join('；')), { code: 'E_PARTIAL' });
    setNotice('已通过选中的 ' + selectedIds.length + ' 个单元（只写单元，不改议题状态）');
  });

  const restoreDecision = (row) => run('restore:' + row.kind + '|' + row.subjectRef, async () => {
    await apiCommand('decision.restore', { kind: row.kind, subjectRef: row.subjectRef });
    setNotice('已恢复这条待拍板项');
  });

  const openSession = (sessionId) => {
    if (!sessionId) { setFormError('这个单元没有绑定会话'); return; }
    if (wbOpenSession(sessionId)) return;
    setFormError('打不开会话：当前 shell 没有暴露 uiWorkspace.openSession');
  };

  return h('div', {
    'data-wb-inbox': 'inbox',
    style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '24px 28px', height: '100%', boxSizing: 'border-box', overflow: 'auto', color: TOKENS.text, background: TOKENS.bg },
  },
    h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h1', { style: { margin: 0, fontSize: '22px', lineHeight: 1.25 } }, '收件箱'),
        h('p', { style: { margin: 0, fontSize: '12px', color: TOKENS.textSecondary } }, '只装需要我做决定的事：两个决策分区 + 一个待立项记录区'),
      ),
      wbButton({ tone: 'plain', label: '刷新', action: 'refresh', disabled: busy !== null, onClick: () => { void refresh(); } }),
    ),
    state.error ? wbBanner('收件箱读取失败：' + state.error, 'error') : null,
    formError ? wbBanner(formError, 'error') : null,
    notice ? wbBanner(notice, 'notice') : null,
    h('section', {
      'data-wb-inbox-counters': 'counters',
      style: { display: 'flex', flexWrap: 'wrap', gap: '24px', padding: '12px 16px', border: '1px solid ' + TOKENS.border, borderRadius: '10px', background: TOKENS.bgSecondary },
    },
      h('span', { style: { fontSize: '12px' } }, '待验收（单元口径）' + '：' + String(counter('pendingReviewUnits', unitRows.length))),
      h('span', { 'data-wb-counter-wrapup': 'wrapup', style: { fontSize: '12px', color: counter('pendingWrapupUnits', wrapupRows.length) > 0 ? TOKENS.warn : undefined } }, '待收尾' + '：' + String(counter('pendingWrapupUnits', wrapupRows.length))),
      h('span', { style: { fontSize: '12px' } }, '等你拍板（未延后）' + '：' + String(counter('pendingDecisions', decisionRows.length))),
      h('span', { style: { fontSize: '12px' } }, '待立项（记录区）' + '：' + String(counter('todoCount', todoRows.length))),
      h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '口径：counters 只算未延后的待拍板项；待终验收与待立项不计入等待'),
    ),

    /* ---------- 决策分区 1：待验收（单元级 + 议题级） ---------- */
    h('section', { 'data-wb-inbox-review': 'review', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      inboxSectionTitle('待验收', unitRows.length + ' 个单元'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
        wbRowNote('详细验收在议题详情；行内这对是次要入口'),
        selectedIds.length >= 2 ? wbButton({ tone: 'plain', label: '批量通过选中单元', action: 'batch-accept', disabled: busy !== null, onClick: () => setConfirmBatch(true) }) : null,
        selectedIds.length >= 2 && confirmBatch ? h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', color: TOKENS.textSecondary } },
          '确认通过选中的 ' + selectedIds.length + ' 个单元？',
          wbButton({ tone: 'mini', label: '确认', action: 'batch-confirm', disabled: busy !== null, onClick: () => { void batchAccept(); } }),
          wbButton({ tone: 'mini', label: '取消', action: 'batch-cancel', disabled: busy !== null, onClick: () => setConfirmBatch(false) }),
        ) : null,
      ),
      unitRows.length === 0
        ? inboxEmpty('没有待验收的单元。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' } },
            unitRows.map((row) => {
              const round = wbRoundNo(row);
              const unitId = row.unitId;
              const selectedRow = Boolean(selected[unitId]);
              return h('li', {
                key: unitId,
                'data-wb-review-unit': unitId,
                style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', border: '1px solid ' + TOKENS.border, borderRadius: '8px' },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h('input', { type: 'checkbox', checked: selectedRow, 'aria-label': '选中 ' + wbIssueRef(row) + ' 第 ' + round + ' 轮', onChange: () => toggleSelected(unitId) }),
                  h('span', { style: { fontSize: '13px', fontWeight: 500 } }, wbIssueRef(row)),
                  h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.issueTitle || row.title || ''),
                  h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '第 ' + round + ' 轮'),
                  row.endedAt ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '结束于 ' + wbTimeAgo(row.endedAt)) : null,
                  h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, row.hasHandover ? '有交接' : '无交接（系统将合成草稿）'),
                  row.hasDiff ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '有 diff') : null,
                  row.sessionId ? wbButton({ tone: 'link', label: '会话入口', action: 'session-open', onClick: () => { void openSession(row.sessionId); } }) : wbRowNote('无会话'),
                ),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                  wbButton({ tone: 'mini', label: '就地通过第 ' + round + ' 轮（不读交接）', action: 'accept', disabled: busy !== null, onClick: () => { void acceptUnit(unitId, round); } }),
                  wbButton({ tone: 'mini', label: '就地打回第 ' + round + ' 轮（作废，不新建）', action: 'reject', disabled: busy !== null, onClick: () => { setRejecting(rejecting === unitId ? null : unitId); setReason(''); setFormError(null); } }),
                ),
                rejecting === unitId ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('input', {
                    type: 'text', value: reason, placeholder: '打回原因（必填一句）', 'data-wb-reject-reason': unitId,
                    onChange: (event) => setReason(event.target.value),
                    style: { flex: '1 1 220px', minWidth: '200px', padding: '4px 8px', fontSize: '12px', border: '1px solid ' + TOKENS.border, borderRadius: '6px', background: TOKENS.bg, color: TOKENS.text },
                  }),
                  wbButton({ tone: 'mini', label: '确认打回', action: 'reject-confirm', disabled: busy !== null, onClick: () => submitReject(unitId) }),
                  wbButton({ tone: 'mini', label: '取消', action: 'reject-cancel', disabled: busy !== null, onClick: () => { setRejecting(null); setReason(''); } }),
                ) : null,
              );
            }),
          ),

      /* AI 建议收尾：只是建议，必须人点开确认，所以只做导航 */
      suggestionRows.length === 0 ? null : h('div', { 'data-wb-inbox-suggested': 'suggested', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { fontSize: '13px', fontWeight: 500 } }, 'AI 建议收尾 · ' + suggestionRows.length + ' 件'),
        h('div', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, 'AI 只写建议，不会自己收尾；去详情写四段交接才算结束'),
        h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
          suggestionRows.map((row) => h('li', {
            key: String(row.unitId),
            'data-wb-suggested-unit': String(row.unitId),
            style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', border: '1px solid ' + TOKENS.border, borderRadius: '8px', flexWrap: 'wrap' },
          },
            h('span', { style: { fontSize: '12px', fontWeight: 500 } }, wbIssueRef(row)),
            h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '单元 #' + String(row.roundNo) + ' · ' + String(row.turnCount || 0) + ' 轮'),
            row.note ? h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.note) : null,
            wbButton({ tone: 'plain', label: '去收尾 →', action: 'go-suggested', onClick: () => wbNavigate(props, 'issue', wbIssueRef(row)) }),
          )),
        ),
      ),

      /* 待收尾：会话没了但没人收尾——只导航到详情，写交接必须在详情页完成 */
      h('div', { 'data-wb-inbox-wrapup': 'wrapup', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { fontSize: '13px', fontWeight: 500 } }, '待收尾 · ' + wrapupRows.length + ' 件'),
        h('div', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '会话已结束或空闲但还没收尾：去详情写四段交接，再进等你确认'),
        wrapupRows.length === 0
          ? h('div', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '没有待收尾的单元。')
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
              wrapupRows.map((row) => h('li', {
                key: String(row.unitId),
                'data-wb-wrapup-unit': String(row.unitId),
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', border: '1px dashed ' + TOKENS.warn, borderRadius: '8px', flexWrap: 'wrap' },
              },
                h('span', { style: { fontSize: '12px', fontWeight: 500 } }, wbIssueRef(row)),
                h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '单元 #' + String(row.roundNo) + ' · ' + String(row.turnCount || 0) + ' 轮'),
                h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.issueTitle || ''),
                wbButton({ tone: 'plain', label: '去收尾 →', action: 'go-wrapup', onClick: () => wbNavigate(props, 'issue', wbIssueRef(row)) }),
              )),
            ),
      ),

      /* 议题级小节：只导航、不写状态，不计入顶部计数，不参与批量 */
      h('div', { 'data-wb-inbox-terminal': 'terminal', style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
        h('div', { style: { fontSize: '13px', fontWeight: 500 } }, '待终验收 · ' + terminalRows.length + ' 件'),
        h('div', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '不计入顶部「待验收」（那是单元口径），也不参与勾选与批量'),
        terminalRows.length === 0
          ? h('div', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '没有待终验收的议题。')
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
              terminalRows.map((row) => h('li', {
                key: String(row.issueId),
                'data-wb-terminal-review': String(row.issueId),
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', border: '1px dashed ' + TOKENS.border, borderRadius: '8px' },
              },
                h('span', { style: { fontSize: '12px', fontWeight: 500 } }, wbIssueRef(row)),
                h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.issueTitle || ''),
                (row.acceptanceUnmet || row.unmet) ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '未满足 ' + String(row.acceptanceUnmet || row.unmet) + ' 条验收标准') : null,
                wbButton({ tone: 'plain', label: '去终验收 →', action: 'go-final', onClick: () => wbNavigate(props, 'issue', wbIssueRef(row), '#finalBox') }),
              )),
            ),
      ),
    ),

    /* ---------- 决策分区 2：等你拍板（只放跳转型按钮） ---------- */
    h('section', { 'data-wb-inbox-decisions': 'decisions', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      inboxSectionTitle('等你拍板', decisionRows.length + ' 条'),
      h('div', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '写操作统一在议题详情完成；本页每条只显示摘要与「去详情处置 →」'),
      decisionRows.length === 0
        ? inboxEmpty('没有等你拍板的事。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' } },
            decisionRows.map((row) => {
              const key = String(row.kind) + '|' + String(row.subjectRef);
              const snoozed = Boolean(row.snoozeUntil) && Date.parse(row.snoozeUntil) > Date.now();
              return h('li', {
                key,
                'data-wb-decision-kind': String(row.kind),
                style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', border: '1px solid ' + TOKENS.border, borderRadius: '8px' },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '11px', padding: '1px 6px', borderRadius: '10px', background: TOKENS.bgSecondary, border: '1px solid ' + TOKENS.border, color: TOKENS.textSecondary } }, WB_DECISION_KIND_LABELS[row.kind] || String(row.kind)),
                  h('span', { style: { fontSize: '13px', fontWeight: 500 } }, wbIssueRef(row)),
                  h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.issueTitle || ''),
                  snoozed ? h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '已延后至 ' + wbDateTime(row.snoozeUntil)) : null,
                ),
                h('div', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, row.reason || '（无原因）'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  wbButton({ tone: 'plain', label: '去详情处置 →', action: 'go-issue', onClick: () => wbNavigate(props, 'issue', wbIssueRef(row)) }),
                  snoozed ? wbButton({
                    tone: 'mini', label: '立即恢复', action: 'restore', disabled: busy !== null,
                    onClick: () => { void restoreDecision(row); },
                  }) : null,
                ),
              );
            }),
          ),
    ),

    /* ---------- 记录区：待立项（可折叠，不计入等待） ---------- */
    h('section', { 'data-wb-todos': 'todos', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      inboxSectionTitle('待立项 · ' + todoRows.length + ' 条', '记录区：不是决策项，不计入「等你拍板」'),
      h('div', null, wbButton({
        tone: 'mini',
        label: todosOpen ? '收起' : '展开',
        action: 'todos-toggle',
        onClick: () => setTodosOpen((open) => !open),
      })),
      todosOpen
        ? (todoRows.length === 0
            ? inboxEmpty('还没有记下的 TODO。')
            : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
                todoRows.map((row) => h('li', {
                  key: String(row.issueId),
                  'data-wb-todo': String(row.issueId),
                  style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', border: '1px solid ' + TOKENS.border, borderRadius: '8px' },
                },
                  h('span', { style: { fontSize: '12px', flex: '1 1 auto' } }, row.title || '（无标题）'),
                  row.hasAiSuggestion ? h('span', { style: { fontSize: '10px', padding: '1px 6px', borderRadius: '10px', background: 'rgba(31,111,235,0.10)', color: TOKENS.accent } }, 'AI 建议立项') : null,
                  wbButton({ tone: 'plain', label: '立项', action: 'triage', onClick: () => wbNavigate(props, 'triage', row.issueId) }),
                )),
              ))
        : null,
    ),
  );
}
