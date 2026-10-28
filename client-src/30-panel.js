/* Shell: navigation, counters and the four workbench views.
   Views live in 31-35 and share this factory scope; all are optional so the
   shell still renders while a view file is missing. */
const NAV = [
  { view: 'progress', label: '项目进度线' },
  { view: 'board', label: '看板' },
  { view: 'inbox', label: '收件箱' },
  { view: 'search', label: '搜索' },
];

function useRoute() {
  const read = () => (typeof parseWorkbenchHash === 'function' ? parseWorkbenchHash(window.location.hash) : { view: 'progress', ref: null, anchor: null });
  const [route, setRoute] = React.useState(read);
  React.useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

function navigate(view, ref, anchor) {
  const target = view === 'issue'
    ? '#/issue/' + encodeURIComponent(ref || '') + (anchor || '')
    : view === 'triage'
      ? '#/triage/' + encodeURIComponent(ref || '')
      : view === 'search'
        ? '#/search' + (ref ? '?q=' + encodeURIComponent(ref) : '')
        : '#/' + view;
  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = target;
}

function CounterChip(props) {
  return h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: '6px', padding: '4px 10px', borderRadius: '999px', border: '1px solid ' + TOKENS.border, background: TOKENS.bgSecondary, fontSize: '12px', color: TOKENS.textSecondary } },
    h('strong', { style: { fontSize: '13px', color: TOKENS.text } }, String(props.value)),
    props.label,
  );
}

/** Triage an existing TODO: project, workspace and at least one criterion. */
function TriageExistingView(props) {
  const { issueRef, snapshot, reload } = props;
  const [state, setState] = React.useState({ phase: 'loading', detail: null, error: null });
  const [projectId, setProjectId] = React.useState('');
  const [workspacePath, setWorkspacePath] = React.useState('');
  const [criteria, setCriteria] = React.useState(['']);
  const [busy, setBusy] = React.useState(false);
  const projects = snapshot ? snapshot.projects : [];

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await apiGet('/issue?id=' + encodeURIComponent(issueRef));
        if (!live) return;
        setState({ phase: 'ready', detail: body.data, error: null });
        setProjectId(body.data.issue.projectId || (projects[0] ? projects[0].projectId : ''));
        setWorkspacePath(body.data.issue.workspacePath || '');
      } catch (error) {
        if (live) setState({ phase: 'error', detail: null, error: String(error.message || error) });
      }
    })();
    return () => { live = false; };
  }, [issueRef]);

  const submit = async () => {
    setBusy(true);
    try {
      const acceptance = criteria.map((text) => text.trim()).filter(Boolean).map((text) => ({ text }));
      await apiCommand('issue.triage', { issueId: issueRef, projectId, workspacePath: workspacePath.trim() || null, acceptance });
      reload();
      navigate('issue', issueRef);
    } catch (error) {
      setState((previous) => ({ ...previous, error: String(error.message || error) }));
    } finally { setBusy(false); }
  };

  if (state.phase === 'loading') return h('div', { 'data-wb-triage': 'triage', style: { padding: '32px', color: TOKENS.textSecondary } }, '加载中…');
  if (state.phase === 'error') return h('div', { 'data-wb-triage': 'triage', style: { padding: '32px', color: TOKENS.danger } }, '加载失败：' + state.error);
  const issue = state.detail.issue;
  const field = { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' };
  const input = { padding: '7px 10px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: TOKENS.text, fontSize: '13px' };
  return h('div', { 'data-wb-triage': 'triage', style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '28px 32px', maxWidth: '760px' } },
    h('h1', { style: { margin: 0, fontSize: '22px' } }, '立项 · ' + issue.title),
    h('label', { style: field }, '项目（必填）',
      h('select', { 'data-wb-triage-project': 'project', value: projectId, onChange: (event) => setProjectId(event.target.value), style: input },
        h('option', { value: '' }, '请选择项目'),
        projects.map((project) => h('option', { key: project.projectId, value: project.projectId }, project.name)),
      ),
    ),
    h('div', { style: field }, '工作区目录（从 DSH 当前工作区里选；留空则不能开工）',
      h(WorkspaceField, { value: workspacePath, onChange: (next) => setWorkspacePath(next || ''), label: '议题工作区', triageAttr: 'workspace' }),
    ),
    h('div', { style: field }, '验收标准（至少 1 条）',
      criteria.map((text, index) => h('div', { key: index, style: { display: 'flex', gap: '8px' } },
        h('input', { 'data-wb-triage-criterion': 'criterion', value: text, placeholder: '怎么算完成', onChange: (event) => setCriteria(criteria.map((value, i) => (i === index ? event.target.value : value))), style: { ...input, flex: 1 } }),
        criteria.length > 1 ? h('button', { type: 'button', onClick: () => setCriteria(criteria.filter((_, i) => i !== index)), style: { ...input, cursor: 'pointer' } }, '删除') : null,
      )),
      h('button', { type: 'button', 'data-wb-triage-add': 'add', onClick: () => setCriteria(criteria.concat([''])), style: { ...input, cursor: 'pointer', alignSelf: 'flex-start' } }, '＋ 加一条'),
    ),
    state.error ? h('div', { style: { color: TOKENS.danger, fontSize: '13px' } }, state.error) : null,
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { type: 'button', 'data-wb-triage-submit': 'submit', disabled: busy, onClick: submit, style: { padding: '8px 16px', borderRadius: '6px', border: 'none', background: TOKENS.accent, color: '#fff', cursor: 'pointer' } }, '立项'),
      h('button', { type: 'button', onClick: () => navigate('progress'), style: { ...input, cursor: 'pointer' } }, '取消'),
    ),
  );
}

function Panel() {
  const { state, reload } = useSnapshot();
  const route = useRoute();
  const snapshot = state.snapshot;
  const counters = snapshot ? snapshot.counters : null;
  const view = route.view || 'progress';

  let body;
  if (view === 'issue' && typeof IssueDetailView === 'function') body = h(IssueDetailView, { issueRef: route.ref, refreshKey: snapshot ? snapshot.version : 0, reload, navigate });
  else if (view === 'triage' && route.ref) body = h(TriageExistingView, { issueRef: route.ref, snapshot, reload });
  else if (view === 'inbox' && typeof InboxView === 'function') body = h(InboxView, { snapshot, reload, navigate });
  else if (view === 'board' && typeof BoardView === 'function') body = h(BoardView, { snapshot, reload, navigate });
  else if (view === 'search' && typeof SearchView === 'function') body = h(SearchView, { snapshot, reload, navigate, initialQuery: route.ref || '' });
  else if (typeof ProjectProgressView === 'function') body = h(ProjectProgressView, { snapshot, reload, navigate });
  else body = h('div', { style: { padding: '32px', color: TOKENS.textSecondary } }, '视图加载中…');

  // The host manages focus for its own notices; if a click lands on one of our
  // fields, take focus back so typing cannot be swallowed.
  const reclaimFocus = (event) => {
    const target = event && event.target;
    if (!target || typeof target.tagName !== 'string') return;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      setTimeout(() => { if (document.activeElement !== target) wbFocus(target); }, 0);
    }
  };
  return h('div', {
    'data-wb-panel': 'workbench',
    'data-wb-build': WB_BUILD,
    onMouseDown: reclaimFocus,
    style: { display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', color: TOKENS.text, background: TOKENS.bg },
  },
    h('header', { style: { display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 24px', borderBottom: '1px solid ' + TOKENS.border, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '16px', fontWeight: 600 } }, '个人工作台'),
      h('nav', { 'data-wb-nav': 'nav', style: { display: 'flex', gap: '4px' } },
        NAV.map((item) => h('button', {
          key: item.view, type: 'button', 'data-wb-nav-item': item.view,
          onClick: () => navigate(item.view),
          style: { padding: '5px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', background: view === item.view ? TOKENS.bgSecondary : 'transparent', color: view === item.view ? TOKENS.text : TOKENS.textSecondary, fontWeight: view === item.view ? 600 : 400 },
        }, item.label)),
      ),
      h('div', { 'data-wb-counters': 'counters', style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
        h(CounterChip, { value: counters ? counters.pendingReviewUnits : 0, label: '待验收单元' }),
        h(CounterChip, { value: counters ? counters.pendingWrapupUnits : 0, label: '待收尾' }),
        h(CounterChip, { value: counters ? counters.pendingDecisions : 0, label: '等你拍板' }),
        h(CounterChip, { value: counters ? counters.running : 0, label: '在跑' }),
        h(CounterChip, { value: counters ? counters.todoCount : 0, label: '待立项' }),
      ),
      h('button', { type: 'button', 'data-wb-refresh': 'refresh', onClick: reload, style: { padding: '5px 10px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' } }, '刷新'),
    ),
    state.error ? h('div', { 'data-wb-error': 'error', style: { padding: '10px 24px', background: 'color-mix(in srgb, ' + TOKENS.danger + ' 12%, transparent)', color: TOKENS.danger, fontSize: '13px' } }, '本地数据接口不可用：' + state.error) : null,
    h('main', { 'data-wb-main': 'main', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 24px 28px' } }, body),
  );
}
