/* ---- 36-claim.js：FR-30 认领入口（conversation.composer.dock） ----
   组件 ClaimDock(props)：一个「⊞ 认领」按钮 + 浮层（未归属会话 + 议题选择）。
   注册由 90-register.js 调 registerClaimDock(ctx)（本文件只导出该函数，不自行注册）。
   无 import/export/JSX；内部标识统一 wbC 前缀，避免与其它 client-src 撞名。 */

const WB_C_STATUS_LABEL = { todo: '待认领', in_progress: '处理中', blocked: '遇到阻碍', in_review: '等你确认', done: '完成', cancelled: '取消' };
const WB_C_ERROR_TEXT = {
  E_BAD_REQUEST: '参数不合法（缺 sessionId/issueId）',
  E_FORBIDDEN: '来源校验失败',
  E_NOT_FOUND: '找不到会话或议题',
  E_CONFLICT: '认领被拒：会话目录与议题工作区不一致（C2），或该议题已有活跃单元（R1）',
  E_LIMIT: '在跑已达上限（登记本身不受限，但该议题已有活跃单元）',
  E_STATE: '议题未立项 / 已收尾 / 已归档，不能认领',
  E_STORAGE: '写盘失败，数据未改动',
  E_LOCK_TIMEOUT: '数据正被另一个窗口写入，请重试',
  E_SCHEMA_TOO_NEW: '数据版本高于插件版本',
  E_INTERNAL: '内部错误',
};
const wbCErrText = (error) => {
  const code = error && error.code;
  const mapped = code ? WB_C_ERROR_TEXT[code] : null;
  const message = error && error.message ? String(error.message) : '';
  if (!mapped) return message || '认领失败';
  return message && message !== mapped ? mapped + '：' + message : mapped;
};

// Opaque surfaces: the button sits on the composer, where a transparent
// background makes it look like plain text. Colours come from the injected
// theme variables so light and dark both stay solid.
const WB_C_BTN = { padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--wb-surface-border)', background: 'var(--wb-surface)', color: 'var(--wb-ink)', fontSize: '12px', lineHeight: 1.4, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' };
const WB_C_BTN_PRIMARY = { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--wb-accent)', background: 'var(--wb-surface)', color: 'var(--wb-accent)', fontSize: '12px', fontWeight: 600, lineHeight: 1.4, cursor: 'pointer' };
const WB_C_INPUT = { padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--wb-surface-border)', background: 'var(--wb-surface)', color: 'var(--wb-ink)', fontSize: '12px', lineHeight: 1.5, width: '100%', boxSizing: 'border-box' };
const WB_C_MUTED = { fontSize: '11px', color: TOKENS.textSecondary };
const WB_C_ROW = { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', border: '1px solid var(--wb-surface-border)', borderRadius: '6px', background: 'var(--wb-surface)', cursor: 'pointer', textAlign: 'left', width: '100%', boxSizing: 'border-box', color: 'var(--wb-ink)' };
const WB_C_ROW_ACTIVE = Object.assign({}, WB_C_ROW, { border: '1px solid ' + TOKENS.accent, background: 'var(--wb-surface-2)' });

/** 会话短标识：前 8 位（会话 id 是 session-<uuid>，去掉前缀再截）。 */
const wbCShortSession = (sessionId) => {
  const text = String(sessionId || '');
  const bare = text.indexOf('session-') === 0 ? text.slice(8) : text;
  return bare.slice(0, 8);
};
const wbCEndedLabel = (session) => {
  if (session && session.running) return '在跑';
  if (session && session.endedAt) return '已结束 ' + String(session.endedAt).slice(5, 16).replace('T', ' ');
  return '未在跑';
};
/** 从 slot props 里尽量取当前会话（不同版本 shell 的字段名可能不同）。 */
const wbCCurrentSession = (props) => {
  if (!props) return null;
  const direct = props.sessionId || props.sessionID;
  if (direct) return { sessionId: direct, cwd: props.cwd || props.workspacePath || null, running: true };
  const session = props.session;
  if (session && typeof session === 'object') {
    const id = session.sessionId || session.id;
    if (id) {
      const cwd = session.cwd || session.workspacePath
        || (session.projections && session.projections.workingDirectory) || null;
      return { sessionId: id, cwd: cwd, running: session.running !== false };
    }
  }
  const context = props.context;
  if (context && typeof context === 'object' && (context.sessionId || context.session)) {
    const nested = context.session;
    return { sessionId: context.sessionId || (nested && (nested.sessionId || nested.id)) || null,
             cwd: context.cwd || (nested && nested.cwd) || null, running: true };
  }
  return null;
};

function ClaimDock(props) {
  const { state, reload } = useSnapshot();
  const snapshot = state ? state.snapshot : null;
  const [open, setOpen] = React.useState(false);
  const [pickedSessionId, setPickedSessionId] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [pickedIssueId, setPickedIssueId] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [claimed, setClaimed] = React.useState(null);
  const [remoteIssues, setRemoteIssues] = React.useState([]);
  const [creating, setCreating] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState('');
  const [newProjectId, setNewProjectId] = React.useState('');
  const [newWorkspace, setNewWorkspace] = React.useState(null);
  const [newCriterion, setNewCriterion] = React.useState('');

  const current = wbCCurrentSession(props);
  const lockedSession = current && current.sessionId ? current : null;

  const unassigned = snapshot && Array.isArray(snapshot.unassignedSessions) ? snapshot.unassignedSessions : [];
  const sessions = React.useMemo(() => {
    const rows = unassigned.map((row) => ({
      sessionId: row.sessionId || row.id,
      cwd: row.cwd || row.workspacePath || null,
      running: row.running === true,
      endedAt: row.endedAt || null,
      title: row.title || null,
    })).filter((row) => row.sessionId);
    if (current && current.sessionId && !rows.some((row) => row.sessionId === current.sessionId)) {
      rows.unshift({ sessionId: current.sessionId, cwd: current.cwd, running: current.running !== false, endedAt: null, title: '当前会话' });
    }
    return rows;
  }, [unassigned, current && current.sessionId, current && current.cwd, current && current.running]);

  /* 议题候选：快照里的已立项议题，只留 todo / in_progress（PRD FR-30 的候选口径）。 */
  const localIssues = React.useMemo(() => {
    const projects = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const rows = [];
    for (const project of projects) {
      if (project.archived) continue;
      const issues = Array.isArray(project.issues) ? project.issues : [];
      for (const issue of issues) {
        if (issue.status !== 'todo' && issue.status !== 'in_progress') continue;
        rows.push({
          issueId: issue.issueId,
          title: issue.title,
          status: issue.status,
          projectName: project.name,
          workspacePath: issue.workspacePath || project.defaultWorkspacePath || null,
        });
      }
    }
    return rows;
  }, [snapshot]);

  const candidates = React.useMemo(() => {
    const text = query.trim().toLowerCase();
    const merged = localIssues.slice();
    for (const issue of remoteIssues) {
      if (issue.status !== 'todo' && issue.status !== 'in_progress') continue;
      if (!merged.some((row) => row.issueId === issue.issueId)) {
        merged.push({ issueId: issue.issueId, title: issue.title, status: issue.status, projectName: null, workspacePath: null });
      }
    }
    const filtered = text
      ? merged.filter((row) => String(row.issueId).toLowerCase().indexOf(text) >= 0 || String(row.title || '').toLowerCase().indexOf(text) >= 0)
      : merged;
    return filtered.slice(0, 12);
  }, [localIssues, remoteIssues, query]);

  /* 本地候选为空且有输入时，补一次 /search（失败静默：搜索只是锦上添花）。 */
  React.useEffect(() => {
    const text = query.trim();
    if (!open || text === '') return;
    let live = true;
    const timer = setTimeout(() => {
      apiGet('/search?q=' + encodeURIComponent(text)).then((body) => {
        if (!live) return;
        const issues = body && body.data && Array.isArray(body.data.issues) ? body.data.issues : [];
        setRemoteIssues(issues);
      }).catch(() => { if (live) setRemoteIssues([]); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [open, query]);

  const pickedSession = sessions.filter((row) => row.sessionId === pickedSessionId)[0] || null;
  const pickedIssue = candidates.filter((row) => row.issueId === pickedIssueId)[0]
    || localIssues.filter((row) => row.issueId === pickedIssueId)[0] || null;

  const openDialog = () => {
    setOpen(true);
    setError(null);
    setQuery('');
    setRemoteIssues([]);
    setPickedIssueId(null);
    setCreating(false);
    setNewTitle('');
    setNewCriterion('');
    const projects = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects.filter((p) => !p.archived) : [];
    setNewProjectId(projects.length > 0 ? projects[0].projectId : '');
    setNewWorkspace(lockedSession && lockedSession.cwd ? lockedSession.cwd : null);
    // The button lives in this conversation's composer: claim THIS session.
    setPickedSessionId(lockedSession ? lockedSession.sessionId : (sessions.length > 0 ? sessions[0].sessionId : null));
  };
  const closeDialog = () => { setOpen(false); setError(null); };

  const submit = async () => {
    if (!pickedSessionId) { setError({ code: 'E_BAD_REQUEST', message: '先选一个会话' }); return; }
    if (!pickedIssueId) { setError({ code: 'E_BAD_REQUEST', message: '先选一个议题' }); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = { issueId: pickedIssueId, sessionId: pickedSessionId };
      if (pickedSession && pickedSession.cwd) payload.cwd = pickedSession.cwd;
      if (pickedSession && pickedSession.running === false) payload.sessionEnded = true;
      const result = await apiCommand('unit.claim', payload);
      const data = result && result.data ? result.data : {};
      setClaimed({ issueRef: pickedIssueId, unitId: data.unitId || null });
      setOpen(false);
      if (reload) reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const createAndClaim = async () => {
    const title = newTitle.trim();
    if (title === '') { setError({ code: 'E_BAD_REQUEST', message: '先写议题标题' }); return; }
    if (!newProjectId) { setError({ code: 'E_BAD_REQUEST', message: '先选项目' }); return; }
    if (newCriterion.trim() === '') { setError({ code: 'E_ACCEPTANCE', message: '至少写 1 条验收标准' }); return; }
    if (!pickedSessionId) { setError({ code: 'E_BAD_REQUEST', message: '无法确定当前会话' }); return; }
    setBusy(true);
    setError(null);
    try {
      // The slot props do not always carry the session cwd; the host knows it.
      let sessionCwd = newWorkspace || (lockedSession && lockedSession.cwd) || null;
      if (!sessionCwd) {
        try {
          const fresh = await apiGet('/snapshot');
          const rows = fresh && fresh.data && Array.isArray(fresh.data.unassignedSessions) ? fresh.data.unassignedSessions : [];
          const row = rows.filter((item) => (item.sessionId || item.id) === pickedSessionId)[0];
          if (row && row.cwd) sessionCwd = row.cwd;
        } catch (ignored) { /* fall through: the host will reject with a clear code */ }
      }
      const created = await apiCommand('todo.create', { title: title, projectId: newProjectId });
      const createdData = created && created.data ? created.data : {};
      const issueId = createdData.issueId || null;
      if (!issueId) throw Object.assign(new Error('无法确定新议题编号'), { code: 'E_INTERNAL' });
      await apiCommand('issue.triage', {
        issueId: issueId,
        projectId: newProjectId,
        workspacePath: sessionCwd || null,
        acceptance: [{ text: newCriterion.trim() }],
      });
      const claimPayload = { issueId: issueId, sessionId: pickedSessionId };
      if (sessionCwd) claimPayload.cwd = sessionCwd;
      const result = await apiCommand('unit.claim', claimPayload);
      const data = result && result.data ? result.data : {};
      setClaimed({ issueRef: issueId, unitId: data.unitId || null });
      setOpen(false);
      if (reload) reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const buttonLabel = claimed ? '⊞ 已认领 ' + claimed.issueRef : '⊞ 认领';

  return h('span', {
    'data-wb-claim': claimed ? 'claimed' : 'idle',
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' },
  },
    h('button', {
      type: 'button',
      'data-wb-claim': 'button',
      title: claimed ? '已认领 ' + claimed.issueRef : '把这个会话挂到某个议题上',
      disabled: busy,
      onClick: () => { if (open) closeDialog(); else openDialog(); },
      style: claimed ? Object.assign({}, WB_C_BTN, { border: '1px solid ' + TOKENS.accent, color: TOKENS.accent }) : WB_C_BTN,
    }, buttonLabel),
    claimed ? h('button', {
      type: 'button',
      'data-wb-claim': 'unassign-hint',
      title: '解绑请到议题详情的工作单元行',
      onClick: () => setClaimed(null),
      style: Object.assign({}, WB_C_MUTED, { border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }),
    }, '×') : null,
    open ? h('div', {
      'data-wb-claim-dialog': 'dialog',
      role: 'dialog',
      'aria-label': '认领会话',
      style: {
        position: 'absolute', bottom: '100%', left: 0, marginBottom: '8px', width: '340px', maxHeight: '60vh', overflow: 'auto',
        border: '1px solid var(--wb-surface-border)', borderRadius: '10px', background: 'var(--wb-surface)', color: 'var(--wb-ink)',
        padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: 60, boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('strong', { style: { fontSize: '13px' } }, '认领会话'),
        h('span', { style: WB_C_MUTED }, '把一个已存在的会话登记成议题的工作单元'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', style: WB_C_BTN, disabled: busy, onClick: closeDialog }, '关闭'),
      ),
      lockedSession
        ? h('div', { 'data-wb-claim-session-fixed': lockedSession.sessionId, style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', border: '1px solid ' + TOKENS.border, borderRadius: '8px' } },
            h('span', { style: WB_C_MUTED }, '本次会话（按钮就在这个对话里，默认认领它）'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
              h('span', { style: { fontFamily: 'monospace', fontSize: '11px' } }, wbCShortSession(lockedSession.sessionId)),
              h('span', { style: Object.assign({}, WB_C_MUTED, { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, lockedSession.cwd || '（目录未知，认领时会取会话的真实目录）'),
            ),
          )
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('span', { style: WB_C_MUTED }, '无法确认当前会话，手动选一个未归属会话'),
            sessions.length === 0
              ? h('span', { style: WB_C_MUTED, 'data-wb-claim': 'no-session' }, '现在没有未归属会话。')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflow: 'auto' } },
                  sessions.map((row) => h('button', {
                    key: row.sessionId,
                    type: 'button',
                    'data-wb-claim-session': row.sessionId,
                    onClick: () => setPickedSessionId(row.sessionId),
                    style: row.sessionId === pickedSessionId ? WB_C_ROW_ACTIVE : WB_C_ROW,
                  },
                    h('span', { style: { fontFamily: 'monospace', fontSize: '11px' } }, wbCShortSession(row.sessionId)),
                    h('span', { style: Object.assign({}, WB_C_MUTED, { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, row.cwd || '（未知目录）'),
                    h('span', { style: WB_C_MUTED }, wbCEndedLabel(row)),
                  )),
                ),
          ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('span', { style: WB_C_MUTED }, '议题（只列待认领 / 处理中）'),
        h('input', {
          'data-wb-claim': 'search',
          value: query,
          placeholder: '按编号或标题搜索议题',
          onChange: (event) => setQuery(event.target.value),
          style: WB_C_INPUT,
        }),
        candidates.length === 0
          ? h('span', { style: WB_C_MUTED }, query.trim() ? '没有匹配的议题。' : '当前没有可认领的议题。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '170px', overflow: 'auto' } },
              candidates.map((row) => h('button', {
                key: row.issueId,
                type: 'button',
                'data-wb-claim-issue': row.issueId,
                onClick: () => setPickedIssueId(row.issueId),
                style: row.issueId === pickedIssueId ? WB_C_ROW_ACTIVE : WB_C_ROW,
              },
                h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary, minWidth: '46px' } }, row.issueId),
                h('span', { style: { fontSize: '12px', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || '（无标题）'),
                h('span', { style: WB_C_MUTED }, WB_C_STATUS_LABEL[row.status] || row.status),
              )),
            ),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid ' + TOKENS.border, paddingTop: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: WB_C_MUTED }, '没有合适的议题？新建一个并直接认领'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            'data-wb-claim': 'create-toggle',
            style: WB_C_BTN,
            disabled: busy,
            onClick: () => { setCreating(!creating); setError(null); },
          }, creating ? '收起新建' : '＋新建议题并认领'),
        ),
        creating ? h('div', { 'data-wb-claim-create': 'form', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('input', {
            'data-wb-claim': 'create-title',
            value: newTitle,
            placeholder: '议题标题（必填）',
            onChange: (event) => setNewTitle(event.target.value),
            style: WB_C_INPUT,
          }),
          h('select', {
            'data-wb-claim': 'create-project',
            value: newProjectId,
            onChange: (event) => setNewProjectId(event.target.value),
            style: WB_C_INPUT,
          },
            h('option', { value: '' }, '选择项目（必填）'),
            (snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : []).filter((project) => !project.archived).map((project) => h('option', { key: project.projectId, value: project.projectId }, project.name)),
          ),
          h(WorkspaceField, {
            value: newWorkspace,
            onChange: (next) => setNewWorkspace(next),
            label: '议题工作区',
            emptyLabel: '不绑定目录（本次会话的目录会作为工作区）',
          }),
          h('input', {
            'data-wb-claim': 'create-criterion',
            value: newCriterion,
            placeholder: '怎么算完成（至少 1 条，必填）',
            onChange: (event) => setNewCriterion(event.target.value),
            style: WB_C_INPUT,
          }),
          h('button', {
            type: 'button',
            'data-wb-claim': 'create-submit',
            style: WB_C_BTN_PRIMARY,
            disabled: busy,
            onClick: () => void createAndClaim(),
          }, busy ? '创建并认领中…' : '创建议题并认领'),
        ) : null,
      ),
      error ? h('div', { 'data-wb-claim-error': (error && error.code) || 'error', style: { fontSize: '12px', borderLeft: '3px solid ' + TOKENS.border, paddingLeft: '8px' } }, wbCErrText(error)) : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: WB_C_MUTED }, pickedIssue && pickedSession ? '将把当前会话 ' + wbCShortSession(pickedSession.sessionId) + ' 认领到 ' + pickedIssue.issueId : (pickedSession ? '选一个议题，或新建一个' : '先确定会话')),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', style: WB_C_BTN, disabled: busy, onClick: closeDialog }, '取消'),
        h('button', {
          type: 'button',
          'data-wb-claim': 'submit',
          style: WB_C_BTN_PRIMARY,
          disabled: busy || !pickedSessionId || !pickedIssueId,
          onClick: () => void submit(),
        }, busy ? '认领中…' : '确认认领'),
      ),
      h('span', { style: WB_C_MUTED }, '认领是登记，不新起执行：在跑数 n 不变；目录必须等于议题工作区（C2）。'),
    ) : null,
  );
}

/** 由 90-register.js 在 apply(ctx) 里调用。 */
function registerClaimDock(ctx) {
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
  try {
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock', id: 'wb-claim', order: 5,
    }, ClaimDock));
  } catch (error) {
    /* 该 slot 在旧版 client 不存在：静默降级，不影响工作台面板 */
  }
}
