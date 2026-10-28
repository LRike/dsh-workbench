/* ---- 31-projects.js：项目进度线（默认视图）+ 立项表单 ----
   ProjectProgressView props: { snapshot, reload, navigate }
   IssueCreateDialog  props: { open, onClose, onDone, presetProjectId, presetWorkspacePath, projects?, navigate? }
   navigate 约定（与 33/34/35 一致）：navigate(view, ref?, anchor?)；view: 'progress' | 'board' | 'inbox' | 'search' | 'issue' | 'triage'
   跳到议题 = navigate('issue', '<WB-12 | issueId>')；回默认视图 = navigate('progress')
   无 import/export/JSX；与其它 client-src 共享同一作用域，内部标识统一 wbP 前缀避免撞名。 */

const WB_P_STATUS_LABEL = {
  todo: '待认领', in_progress: '处理中', blocked: '遇到阻碍', in_review: '等你确认', done: '完成', cancelled: '取消',
};
const WB_P_ERROR_TEXT = {
  E_BAD_REQUEST: '参数不合法', E_FORBIDDEN: '来源校验失败', E_NOT_FOUND: '找不到对象',
  E_CONFLICT: '操作冲突（已有活跃单元 / 目录不匹配 / 已收尾）', E_LIMIT: '在跑已达上限（3/3），先收一轮',
  E_STATE: '当前状态不允许这个动作', E_ACCEPTANCE: '验收标准不合法',
  E_TEXT: '文本为空或超长（标题上限 240、验收标准上限 1000 字）', E_STORAGE: '写盘失败，数据未改动',
  E_LOCK_TIMEOUT: '数据正被另一个窗口写入，请重试', E_SCHEMA_TOO_NEW: '数据版本高于插件版本', E_INTERNAL: '内部错误',
};

const wbPErrText = (error) => {
  const code = error && error.code;
  const mapped = code ? WB_P_ERROR_TEXT[code] : null;
  const message = error && error.message ? String(error.message) : '';
  if (!mapped) return message || '操作失败';
  return message && message !== mapped ? mapped + '：' + message : mapped;
};
const wbPProjectId = (project) => project.projectId || project.id || '';
const wbPProjectPath = (project) => project.defaultWorkspacePath || project.workspacePath || null;
const wbPIssueRef = (issue) => issue.code || issue.id || issue.issueId || '';
const wbPIssueIdOf = (issue) => issue.issueId || issue.id || issue.code || '';
const wbPGo = (navigate, view, ref) => {
  if (typeof navigate !== 'function') return;
  try {
    navigate(view, ref === undefined ? null : ref);
  } catch (error) {
    /* shell 负责路由；跳转失败不影响本页数据 */
  }
};

const WB_P_BTN = { padding: '4px 10px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: 'transparent', color: TOKENS.text, fontSize: '12px', lineHeight: 1.4, cursor: 'pointer' };
const WB_P_BTN_PRIMARY = { padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + TOKENS.accent, background: 'transparent', color: TOKENS.accent, fontSize: '12px', fontWeight: 600, lineHeight: 1.4, cursor: 'pointer' };
const WB_P_INPUT = { padding: '5px 8px', borderRadius: '6px', border: '1px solid ' + TOKENS.border, background: TOKENS.bg, color: TOKENS.text, fontSize: '12px', lineHeight: 1.5, minWidth: 0 };
const WB_P_MUTED = { fontSize: '12px', color: TOKENS.textSecondary };
const WB_P_PANEL = { border: '1px solid ' + TOKENS.border, borderRadius: '8px', background: TOKENS.bgSecondary, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' };

function wbPErrorLine(error, scope) {
  if (!error) return null;
  return h('div', { 'data-wb-inline-error': scope || 'projects', style: { fontSize: '12px', color: TOKENS.text, borderLeft: '3px solid ' + TOKENS.border, paddingLeft: '8px' } }, wbPErrText(error));
}

function wbPBadge(status) {
  return h('span', {
    'data-wb-status-badge': status || 'unknown',
    style: { padding: '1px 8px', borderRadius: '999px', border: '1px solid ' + TOKENS.border, color: TOKENS.textSecondary, fontSize: '11px', whiteSpace: 'nowrap' },
  }, WB_P_STATUS_LABEL[status] || status || '未知');
}

/** 项目设置：改名 / 默认目录 / 解绑 / 归档恢复（FR-01/02/04）。 */
function wbPProjectSettings(props) {
  const project = props.project;
  const projectId = wbPProjectId(project);
  const [name, setName] = React.useState(String(project.name || ''));
  const [path, setPath] = React.useState(wbPProjectPath(project) || '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const run = React.useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (props.reload) props.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }, [props.reload]);

  const saveName = () => void run(() => apiCommand('project.rename', { projectId: projectId, name: name.trim() }));
  const savePath = () => void run(() => apiCommand('project.setDefaultWorkspace', { projectId: projectId, defaultWorkspacePath: path.trim() || null, workspacePath: path.trim() || null }));
  const setArchived = (archived) => void run(() => apiCommand('project.setArchived', { projectId: projectId, archived: archived }));

  return h('div', { 'data-wb-project-settings': projectId, style: WB_P_PANEL },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('span', { style: WB_P_MUTED }, '项目名'),
      h('input', { value: name, maxLength: 240, onChange: (event) => setName(event.target.value), style: Object.assign({}, WB_P_INPUT, { flex: '1 1 160px' }) }),
      h('button', { type: 'button', disabled: busy || name.trim() === '', onClick: saveName, style: WB_P_BTN }, '保存名称'),
    ),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('span', { style: WB_P_MUTED }, '默认目录'),
      h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
        h(WorkspaceField, { value: path, onChange: (next) => setPath(next || ''), label: '项目默认目录', emptyLabel: '不绑定目录' }),
      ),
      h('button', { type: 'button', disabled: busy, onClick: savePath, style: WB_P_BTN }, '保存目录'),
      h('button', { type: 'button', disabled: busy || !wbPProjectPath(project), onClick: () => void run(() => apiCommand('project.setDefaultWorkspace', { projectId: projectId, defaultWorkspacePath: null, workspacePath: null })), style: WB_P_BTN }, '解绑'),
    ),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      wbPProjectPath(project)
        ? h('span', { style: WB_P_MUTED }, '当前目录：' + wbPProjectPath(project))
        : h('span', { style: WB_P_MUTED }, '未绑定目录（新建议题需手选工作区）'),
      h('button', { type: 'button', disabled: busy, onClick: () => setArchived(!project.archived), style: WB_P_BTN }, project.archived ? '恢复项目' : '归档项目'),
      h('button', { type: 'button', disabled: busy, onClick: () => props.onClose && props.onClose(), style: WB_P_BTN }, '收起'),
    ),
    wbPErrorLine(error, 'project-settings'),
  );
}

/** 新建项目（可内联在立项表单里用）：{ name, path } → project.create。 */
function wbPNewProjectForm(props) {
  const [name, setName] = React.useState('');
  const [path, setPath] = React.useState(props.presetWorkspacePath || '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const defaultPath = path.trim() || null;
      const result = await apiCommand('project.create', {
        name: name.trim(),
        defaultWorkspacePath: defaultPath,
        workspacePath: defaultPath,
      });
      if (props.onCreated) props.onCreated(result && result.data ? result.data : null);
      setName('');
      setPath('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return h('div', { 'data-wb-new-project': 'form', style: WB_P_PANEL },
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      h('span', { style: WB_P_MUTED }, '新建项目'),
      h('input', { 'data-wb-new-project': 'name', value: name, maxLength: 240, placeholder: '项目名（必填）', onChange: (event) => setName(event.target.value), style: Object.assign({}, WB_P_INPUT, { flex: '1 1 140px' }) }),
      h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
        h(WorkspaceField, { value: path, onChange: (next) => setPath(next || ''), label: '项目默认目录', emptyLabel: '不绑定目录' }),
      ),
      h('button', { type: 'button', disabled: busy || name.trim() === '', onClick: () => void submit(), style: WB_P_BTN_PRIMARY }, busy ? '创建中…' : '创建项目'),
      props.onCancel ? h('button', { type: 'button', disabled: busy, onClick: props.onCancel, style: WB_P_BTN }, '取消') : null,
    ),
    wbPErrorLine(error, 'new-project'),
  );
}

/** 默认视图：每项目一行，行内议题 + 单元进度（FR-03 / FR-04 / FR-61）。 */
function ProjectProgressView(props) {
  const snapshot = props.snapshot || {};
  const allProjects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const activeProjects = allProjects.filter((project) => !project.archived);
  const archivedProjects = allProjects.filter((project) => project.archived);
  const [settingsFor, setSettingsFor] = React.useState(null);
  const [creatingProject, setCreatingProject] = React.useState(false);
  const [dialog, setDialog] = React.useState(null);

  const openCreateIssue = (project) => setDialog({
    presetProjectId: project ? wbPProjectId(project) : undefined,
    presetWorkspacePath: project ? (wbPProjectPath(project) || undefined) : undefined,
  });

  const dialogNode = h(IssueCreateDialog, {
    open: Boolean(dialog),
    presetProjectId: dialog ? dialog.presetProjectId : undefined,
    presetWorkspacePath: dialog ? dialog.presetWorkspacePath : undefined,
    projects: allProjects,
    navigate: props.navigate,
    reload: props.reload,
    onClose: () => setDialog(null),
    onDone: () => setDialog(null),
  });

  const projectRow = (project) => {
    const projectId = wbPProjectId(project);
    const issues = Array.isArray(project.issues) ? project.issues : [];
    const progress = project.progress || { passed: 0, total: 0 };
    return h('li', {
      key: projectId,
      'data-wb-project': projectId,
      style: { listStyle: 'none', border: '1px solid ' + TOKENS.border, borderRadius: '10px', background: TOKENS.bg, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
        h('strong', { style: { fontSize: '15px', color: TOKENS.text } }, project.name || '未命名项目'),
        h('span', { style: WB_P_MUTED }, wbPProjectPath(project) || '未绑定目录'),
        h('span', { style: WB_P_MUTED, 'data-wb-project-progress': projectId }, (progress.passed || 0) + '/' + (progress.total || 0) + ' 单元通过'),
        project.archived ? h('span', { style: WB_P_MUTED }, '已归档') : null,
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', style: WB_P_BTN_PRIMARY, 'data-wb-open-triage': projectId, onClick: () => openCreateIssue(project) }, '＋新建议题'),
        h('button', { type: 'button', style: WB_P_BTN, 'data-wb-project-settings-toggle': projectId, onClick: () => setSettingsFor(settingsFor === projectId ? null : projectId) }, settingsFor === projectId ? '收起设置' : '项目设置'),
      ),
      settingsFor === projectId ? h(wbPProjectSettings, { project: project, reload: props.reload, onClose: () => setSettingsFor(null) }) : null,
      issues.length === 0
        ? h('div', { 'data-wb-empty': 'issues', style: Object.assign({}, WB_P_MUTED, { padding: '6px 0' }) }, '还没有议题。')
        : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
            issues.map((issue) => {
              const issueRef = wbPIssueRef(issue);
              const units = issue.units || { total: 0, passed: 0 };
              return h('li', {
                key: wbPIssueIdOf(issue) || issueRef,
                'data-wb-issue': issueRef,
                style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', padding: '6px 10px', border: '1px solid ' + TOKENS.border, borderRadius: '8px' },
              },
                h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, issueRef),
                h('button', {
                  type: 'button',
                  onClick: () => wbPGo(props.navigate, 'issue', issueRef),
                  style: { border: 'none', background: 'transparent', color: TOKENS.accent, fontSize: '13px', padding: 0, cursor: 'pointer', textAlign: 'left' },
                }, issue.title || '（无标题）'),
                wbPBadge(issue.status),
                h('span', { style: WB_P_MUTED }, (units.passed || 0) + '/' + (units.total || 0) + ' 轮通过'),
                issue.terminalReview ? h('span', { style: WB_P_MUTED, 'data-wb-terminal-review': issueRef }, '待终验收') : null,
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { type: 'button', style: WB_P_BTN, 'data-wb-open-issue': issueRef, onClick: () => wbPGo(props.navigate, 'issue', issueRef) }, '打开'),
              );
            }),
          ),
    );
  };

  return h('section', { 'data-wb-project-progress': 'view', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('h2', { style: { margin: 0, fontSize: '15px', color: TOKENS.text } }, '项目进度'),
      h('span', { style: WB_P_MUTED }, '每个项目一行，行内是它的议题与单元进度'),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', { type: 'button', 'data-wb-new-project': 'open', style: WB_P_BTN_PRIMARY, onClick: () => setCreatingProject(!creatingProject) }, '＋新建项目'),
      h('button', { type: 'button', style: WB_P_BTN, onClick: () => openCreateIssue(null) }, '＋新建议题（选项目）'),
    ),
    creatingProject
      ? h(wbPNewProjectForm, {
          presetWorkspacePath: props.presetWorkspacePath,
          onCancel: () => setCreatingProject(false),
          onCreated: () => { setCreatingProject(false); if (props.reload) props.reload(); },
        })
      : null,
    activeProjects.length === 0
      ? h('div', { 'data-wb-empty': 'projects', style: { padding: '28px', border: '1px dashed ' + TOKENS.border, borderRadius: '10px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' } },
          h('span', { style: WB_P_MUTED }, '还没有项目。先建一个项目，之后每件事都落在项目里。'),
          h('button', { type: 'button', 'data-wb-new-project': 'empty', style: WB_P_BTN_PRIMARY, onClick: () => setCreatingProject(true) }, '＋新建项目'),
        )
      : h('ul', { 'data-wb-projects': 'list', style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' } },
          activeProjects.map(projectRow),
        ),
    archivedProjects.length > 0
      ? h('details', { 'data-wb-archived-projects': 'archived', style: { border: '1px solid ' + TOKENS.border, borderRadius: '8px', padding: '8px 12px' } },
          h('summary', { style: Object.assign({}, WB_P_MUTED, { cursor: 'pointer' }) }, '已归档项目 · ' + archivedProjects.length + ' 个'),
          h('ul', { style: { listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
            archivedProjects.map((project) => h('li', { key: wbPProjectId(project), 'data-wb-project': wbPProjectId(project), style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              h('span', { style: { fontSize: '12px' } }, project.name || '未命名项目'),
              h('span', { style: WB_P_MUTED }, '已归档'),
              h('button', { type: 'button', style: WB_P_BTN, onClick: () => void (async () => {
                try {
                  await apiCommand('project.setArchived', { projectId: wbPProjectId(project), archived: false });
                  if (props.reload) props.reload();
                } catch (caught) { window.alert(wbPErrText(caught)); }
              })() }, '恢复项目'),
            )),
          ),
        )
      : null,
    dialogNode,
  );
}

/** 立项表单（FR-11）：标题 / 描述 / 项目（必填，可内联新建）/ 工作区（可空）/ 验收标准（≥1）。 */
function IssueCreateDialog(props) {
  const open = Boolean(props.open);
  const draft = wbDraft('issue-create', { title: '', description: '', workspacePath: '', criteria: [{ key: 'c0', text: '' }] });
  const [title, setTitle] = React.useState(draft.title || '');
  const [description, setDescription] = React.useState(draft.description || '');
  const [projectId, setProjectId] = React.useState(props.presetProjectId || '');
  const [workspacePath, setWorkspacePath] = React.useState(props.presetWorkspacePath || '');
  const [criteria, setCriteria] = React.useState(() => {
    const saved = wbDraft('issue-create', null);
    return saved && Array.isArray(saved.criteria) && saved.criteria.length > 0 ? saved.criteria : [{ key: 'c0', text: '' }];
  });
  const [projects, setProjects] = React.useState(Array.isArray(props.projects) ? props.projects : []);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [fieldError, setFieldError] = React.useState({});
  const nextKey = React.useRef(1);
  const cardRef = React.useRef(null);

  const loadProjects = React.useCallback(async () => {
    if (Array.isArray(props.projects)) return;
    try {
      const body = await apiGet('/snapshot');
      const list = body && body.data && Array.isArray(body.data.projects) ? body.data.projects : [];
      setProjects(list);
    } catch (caught) {
      setError(caught);
    }
  }, [props.projects]);

  // Initialise exactly once per open session. The previous version listed
  // loadProjects in the deps, and loadProjects is rebuilt whenever props.projects
  // changes identity — which happens on every poll. That reset the form (title,
  // description, criteria) on every render, so typed text vanished.
  const openedFor = React.useRef(null);
  // Keyboard users must get their focus back where it was when the dialog opened.
  const returnFocusRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) {
      openedFor.current = null;
      wbClearDraft('issue-create');
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back) setTimeout(() => wbFocus(back), 20);
      return;
    }
    if (!returnFocusRef.current && typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body) {
      returnFocusRef.current = document.activeElement;
    }
    const signature = String(props.presetProjectId || '') + '|' + String(props.presetWorkspacePath || '');
    if (openedFor.current === signature) return;
    openedFor.current = signature;
    const saved = wbDraft('issue-create', null);
    setTitle(saved && saved.title ? saved.title : '');
    setDescription(saved && saved.description ? saved.description : '');
    setProjectId(props.presetProjectId || '');
    setWorkspacePath(props.presetWorkspacePath || (saved && saved.workspacePath ? saved.workspacePath : ''));
    setCriteria(saved && Array.isArray(saved.criteria) && saved.criteria.length > 0 ? saved.criteria : [{ key: 'c0', text: '' }]);
    setError(null);
    setFieldError({});
    setNewProjectOpen(false);
    nextKey.current = (saved && saved.criteria ? saved.criteria.length : 1) + 1;
    void loadProjects();
  }, [open, props.presetProjectId, props.presetWorkspacePath]);

  // Persist the in-progress form outside React state so a host-driven remount
  // cannot drop what the user already typed.
  React.useEffect(() => {
    if (!open) return;
    wbSetDraft('issue-create', { title: title, description: description, workspacePath: workspacePath, criteria: criteria });
  }, [open, title, description, workspacePath, criteria]);

  // The dialog owns focus while it is open: focusing on mount also defeats
  // host-level focus traps that otherwise swallow keystrokes.
  const titleRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => wbFocus(titleRef.current), 30);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const addCriterion = () => {
    if (criteria.length >= 20) return;
    setCriteria(criteria.concat([{ key: 'c' + nextKey.current, text: '' }]));
    nextKey.current += 1;
  };
  const updateCriterion = (key, text) => setCriteria(criteria.map((item) => (item.key === key ? { key: key, text: text } : item)));
  const removeCriterion = (key) => setCriteria(criteria.filter((item) => item.key !== key));

  const submit = async () => {
    const trimmedTitle = title.trim();
    const texts = criteria.map((item) => item.text.trim()).filter((text) => text !== '');
    const nextFieldError = {};
    if (trimmedTitle === '') nextFieldError.title = '标题必填（≤240 字）';
    if (trimmedTitle.length > 240) nextFieldError.title = '标题最多 240 字';
    if (!projectId) nextFieldError.projectId = '立项必须指定项目';
    if (texts.length === 0) nextFieldError.acceptance = '至少写 1 条验收标准，否则不算想清楚“怎么算完”';
    if (texts.length > 20) nextFieldError.acceptance = '验收标准最多 20 条';
    setFieldError(nextFieldError);
    if (Object.keys(nextFieldError).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      let issueId = props.issueId;
      if (!issueId) {
        const created = await apiCommand('todo.create', {
          title: trimmedTitle,
          description: description.trim() || undefined,
          projectId: projectId || undefined,
        });
        const data = created && created.data ? created.data : {};
        issueId = data.issueId || data.id || (data.issue && (data.issue.issueId || data.issue.id)) || null;
      }
      if (!issueId) throw Object.assign(new Error('无法确定新记录的 issueId'), { code: 'E_INTERNAL' });
      const triaged = await apiCommand('issue.triage', {
        issueId: issueId,
        projectId: projectId,
        workspacePath: workspacePath.trim() || null,
        acceptance: texts.map((text) => ({ text: text })),
      });
      const resultData = triaged && triaged.data ? triaged.data : {};
      if (props.onDone) props.onDone(resultData);
      if (props.reload) props.reload();
      const issueRef = resultData.code || resultData.issueId || issueId;
      wbPGo(props.navigate, 'issue', issueRef);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  // The dialog mounts before the first snapshot arrives, so its own state can be
  // empty forever. Prefer the live props every render; fall back to local state
  // only when the caller does not pass projects at all.
  const liveProjects = Array.isArray(props.projects) && props.projects.length > 0 ? props.projects : projects;
  const projectOptions = liveProjects.filter((project) => !project.archived);

  const stopHostHandlers = (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); };
  const focusFirstField = (event) => {
    const target = event && event.target;
    if (!target || target === event.currentTarget) {
      const card = event && event.currentTarget;
      const first = card && card.querySelector && card.querySelector('input, textarea, select');
      if (first) wbFocus(first);
    }
  };
  // Runs in the capture phase: it must handle Escape and Tab itself, because
  // stopPropagation() here prevents the bubble-phase handler from ever firing.
  const onDialogKeyDown = (event) => {
    if (!event) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!busy && props.onClose) props.onClose();
      return;
    }
    if (event.key === 'Tab' && cardRef.current) {
      const focusables = [...cardRef.current.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (focusables.length > 0) {
        const first = focusables[0]; const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); return; }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); return; }
      }
    }
    event.stopPropagation();
  };
  const overlay = h('div', {
    'data-wb-triage': 'dialog',
    'data-wb-dialog': 'issue-create',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '立项',
    onMouseDown: stopHostHandlers,
    onKeyDown: onDialogKeyDown,
    onKeyDownCapture: onDialogKeyDown,
  },
    h('div', { 'data-wb-dialog-card': 'issue-create', ref: cardRef, onMouseDown: focusFirstField, style: { display: 'flex', flexDirection: 'column', gap: '14px', border: '1px solid ' + TOKENS.border } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('h3', { style: { margin: 0, fontSize: '17px' } }, '立项'),
        h('span', { style: WB_P_MUTED }, '立项 = 决定要做：必须选项目，并写清怎么算完'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', style: WB_P_BTN, disabled: busy, onClick: () => props.onClose && props.onClose() }, '关闭'),
      ),
      h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('span', { style: WB_P_MUTED }, '标题（必填，≤240 字）'),
        h('input', { 'data-wb-triage': 'title', ref: titleRef, value: title, maxLength: 240, onChange: (event) => setTitle(event.target.value), style: WB_P_INPUT }),
        fieldError.title ? h('span', { style: WB_P_MUTED }, fieldError.title) : null,
      ),
      h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('span', { style: WB_P_MUTED }, '描述（可选）'),
        h('textarea', { value: description, rows: 3, onChange: (event) => setDescription(event.target.value), style: Object.assign({}, WB_P_INPUT, { resize: 'vertical', fontFamily: 'inherit' }) }),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
        h('span', { style: WB_P_MUTED }, '项目（必填）'),
        h('select', {
          'data-wb-triage': 'project',
          value: projectId,
          onChange: (event) => setProjectId(event.target.value),
          style: Object.assign({}, WB_P_INPUT, { flex: '1 1 200px' }),
        },
          h('option', { value: '' }, '请选择项目'),
          projectOptions.map((project) => h('option', { key: wbPProjectId(project), value: wbPProjectId(project) }, project.name + (wbPProjectPath(project) ? ' · ' + wbPProjectPath(project) : ' · 未绑定目录'))),
        ),
        h('button', { type: 'button', 'data-wb-new-project': 'inline', style: WB_P_BTN, onClick: () => setNewProjectOpen(!newProjectOpen) }, '＋新建项目'),
        fieldError.projectId ? h('span', { style: WB_P_MUTED }, fieldError.projectId) : null,
      ),
      (() => {
        const selected = projectOptions.find((item) => wbPProjectId(item) === projectId);
        if (!selected) return null;
        return h('div', { 'data-wb-triage': 'project-hint', style: Object.assign({}, WB_P_MUTED, { display: 'flex', gap: '6px', alignItems: 'center' }) },
          h('span', { style: { color: TOKENS.ok } }, '✓'),
          '已选项目：' + selected.name,
        );
      })(),
      newProjectOpen
        ? h(wbPNewProjectForm, {
            onCancel: () => setNewProjectOpen(false),
            onCreated: (data) => {
              setNewProjectOpen(false);
              if (props.reload) props.reload();
              const created = data && (data.projectId || (data.project && data.project.projectId));
              if (created) setProjectId(created);
              void loadProjects();
            },
          })
        : null,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('span', { style: WB_P_MUTED }, '工作区目录（从 DSH 当前工作区里选；留空则能立项但不能开工）'),
        h(WorkspaceField, { value: workspacePath, onChange: (next) => setWorkspacePath(next || ''), label: '议题工作区', triageAttr: 'workspace' }),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: WB_P_MUTED, 'data-wb-triage': 'acceptance' }, '验收标准（必填 ≥1 条，≤20 条）'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { type: 'button', style: WB_P_BTN, disabled: criteria.length >= 20, onClick: addCriterion }, '＋加一条'),
        ),
        criteria.map((item) => h('div', { key: item.key, style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { value: item.text, placeholder: '怎么算完？例如：接口返回 200 且数据落盘', onChange: (event) => updateCriterion(item.key, event.target.value), style: Object.assign({}, WB_P_INPUT, { flex: '1 1 auto' }) }),
          h('button', { type: 'button', style: WB_P_BTN, disabled: criteria.length <= 1, onClick: () => removeCriterion(item.key) }, '删除'),
        )),
        fieldError.acceptance ? h('span', { style: WB_P_MUTED }, fieldError.acceptance) : null,
      ),
      wbPErrorLine(error, 'triage'),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px' } },
        h('button', { type: 'button', style: WB_P_BTN, disabled: busy, onClick: () => props.onClose && props.onClose() }, '取消'),
        h('button', { type: 'button', 'data-wb-triage': 'submit', style: WB_P_BTN_PRIMARY, disabled: busy, onClick: () => void submit() }, busy ? '立项中…' : '确认立项'),
      ),
    ),
  );
  // Portal out of the panel: host ancestors use overflow:hidden and app-region
  // drag areas, which used to clip the modal and eat clicks in the desktop app.
  const host = typeof document !== 'undefined' ? document.body : null;
  return WB_REACT_DOM && host ? WB_REACT_DOM.createPortal(overlay, host) : overlay;
}
