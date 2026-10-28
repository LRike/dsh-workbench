/* 搜索与深链（PRD FR-62）：输入 200ms 防抖，结果分三组（议题 / TODO / 项目），
   无结果时给「用这个标题记一条 TODO」。文件末尾的 parseWorkbenchHash 是纯函数，
   供 shell 路由复用（无副作用，可单测）。 */

const WB_SEARCH_DEBOUNCE_MS = 200;
const WB_SEARCH_LIMIT = 20;

/** 结果分组：容错命名（宿主字段名以 API.md 4.5 为准，允许单数/缺失）。 */
function searchGroups(body) {
  const data = (body && body.data) || {};
  const pick = (plural, singular) => {
    if (Array.isArray(data[plural])) return data[plural];
    if (Array.isArray(data[singular])) return data[singular];
    return [];
  };
  return {
    issues: pick('issues', 'issue'),
    todos: pick('todos', 'todo'),
    projects: pick('projects', 'project'),
  };
}

function searchItemKey(prefix, item, index) {
  return prefix + ':' + String((item && (item.issueId || item.projectId || item.id)) || index);
}

function searchRow(label, onOpen, action) {
  return h('li', { key: label.key, style: { padding: '6px 8px', border: '1px solid ' + TOKENS.border, borderRadius: '6px' } },
    h('button', {
      type: 'button',
      onClick: onOpen,
      'data-wb-action': action,
      style: { width: '100%', textAlign: 'left', padding: 0, border: 'none', background: 'transparent', color: TOKENS.text, cursor: 'pointer', font: 'inherit', fontSize: '12px' },
    }, label.text),
  );
}

/**
 * 搜索视图。
 * @param {{ snapshot?: any, reload?: () => any, navigate?: (view: string, ref?: any, anchor?: string) => void }} props
 */
function SearchView(props) {
  const initialQuery = props && typeof props.initialQuery === 'string' ? props.initialQuery : '';
  const [query, setQuery] = React.useState(initialQuery);
  const [state, setState] = React.useState({ phase: 'idle', groups: null, error: null });
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const inputRef = React.useRef(null);
  const composingRef = React.useRef(false);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus();
  }, []);

  const runSearch = React.useCallback(async (text) => {
    const trimmed = String(text || '').trim();
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    if (trimmed.length === 0) { setState({ phase: 'idle', groups: null, error: null }); return; }
    setState((previous) => ({ phase: 'loading', groups: previous.groups, error: null }));
    try {
      const body = await apiGet('/search?q=' + encodeURIComponent(trimmed));
      if (requestRef.current !== ticket) return;
      setState({ phase: 'ready', groups: searchGroups(body), error: null });
    } catch (error) {
      if (requestRef.current !== ticket) return;
      setState((previous) => ({ phase: previous.groups ? 'ready' : 'error', groups: previous.groups, error: wbErrorText(error) }));
    }
  }, []);

  /* 200ms 防抖；输入法组字期间不触发（PRD FR-62）。 */
  React.useEffect(() => {
    if (composingRef.current) return undefined;
    const timer = setTimeout(() => { void runSearch(query); }, WB_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const createTodoFromQuery = async () => {
    const title = String(query || '').trim();
    if (!title) return;
    setBusy(true); setNotice(null);
    try {
      const body = await apiCommand('todo.create', { title });
      const issueId = body && body.data ? body.data.issueId : undefined;
      setNotice('已记下 TODO：' + title);
      if (props && typeof props.reload === 'function') { try { await props.reload(); } catch { /* 计数刷新失败不影响结果 */ } }
      if (issueId) wbNavigate(props, 'triage', issueId);
    } catch (error) {
      setState((previous) => ({ ...previous, error: wbErrorText(error) }));
    } finally { setBusy(false); }
  };

  const groups = state.groups;
  const totals = groups ? groups.issues.length + groups.todos.length + groups.projects.length : 0;
  const hasQuery = String(query || '').trim().length > 0;

  const groupSection = (title, items, renderItem) => {
    if (!items || items.length === 0) return null;
    return h('section', { key: title, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      h('h2', { style: { margin: 0, fontSize: '12px', fontWeight: 600, color: TOKENS.textSecondary } }, title + ' · ' + items.length),
      h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' } }, items.slice(0, WB_SEARCH_LIMIT).map(renderItem)),
    );
  };

  return h('div', {
    'data-wb-search': 'search',
    style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '24px 28px', height: '100%', boxSizing: 'border-box', overflow: 'auto', color: TOKENS.text, background: TOKENS.bg },
  },
    h('header', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      h('h1', { style: { margin: 0, fontSize: '22px', lineHeight: 1.25 } }, '搜索'),
      h('p', { style: { margin: 0, fontSize: '12px', color: TOKENS.textSecondary } }, '搜议题 / TODO / 项目（标题、描述、编号）；停止输入 200ms 后出结果'),
    ),
    h('input', {
      ref: inputRef,
      type: 'search',
      value: query,
      placeholder: '输入关键词…',
      'data-wb-search-input': 'query',
      'aria-label': '搜索议题、TODO、项目',
      onCompositionStart: () => { composingRef.current = true; },
      onCompositionEnd: (event) => { composingRef.current = false; setQuery(event.target.value); },
      onChange: (event) => setQuery(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !composingRef.current) { void runSearch(query); } },
      style: { width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid ' + TOKENS.border, borderRadius: '8px', background: TOKENS.bg, color: TOKENS.text, boxSizing: 'border-box' },
    }),
    state.error ? h('div', {
      'data-wb-error': 'search',
      style: { padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: 'color-mix(in srgb, ' + TOKENS.danger + ' 12%, transparent)', color: TOKENS.danger },
    }, '搜索失败：' + state.error) : null,
    notice ? h('div', {
      'data-wb-notice': 'search',
      style: { padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: 'rgba(31,111,235,0.08)', color: TOKENS.accent },
    }, notice) : null,

    h('div', { 'data-wb-search-results': 'results', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      !hasQuery
        ? h('div', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '输入关键词开始搜索。')
        : (state.phase === 'loading' && totals === 0
            ? h('div', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, '正在搜索…')
            : null),
      hasQuery && state.phase !== 'loading' && state.phase !== 'idle' && totals === 0
        ? h('div', { 'data-wb-search-empty': 'no-match', style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start', padding: '16px', border: '1px dashed ' + TOKENS.border, borderRadius: '8px' } },
            h('span', { style: { fontSize: '13px' } }, '没有匹配项'),
            h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, '搜的就是"想记但没记"的东西？直接记下来。'),
            wbButton({ tone: 'plain', label: '用这个标题记一条 TODO', action: 'create-todo', disabled: busy, onClick: () => { void createTodoFromQuery(); } }),
          )
        : null,
      groups ? groupSection('议题', groups.issues, (item, index) => searchRow(
        { key: searchItemKey('issue', item, index), text: (item.code ? String(item.code) + ' · ' : '') + String(item.title || '') + (item.projectName ? ' · ' + String(item.projectName) : '') },
        () => wbNavigate(props, 'issue', wbIssueRef(item)),
        'open-issue',
      )) : null,
      groups ? groupSection('TODO', groups.todos, (item, index) => searchRow(
        { key: searchItemKey('todo', item, index), text: String(item.title || '') + (item.projectName ? ' · ' + String(item.projectName) : '') },
        () => wbNavigate(props, 'triage', item.issueId),
        'open-triage',
      )) : null,
      groups ? groupSection('项目', groups.projects, (item, index) => searchRow(
        { key: searchItemKey('project', item, index), text: String(item.name || item.title || '') },
        () => wbNavigate(props, 'progress', item.projectId),
        'open-project',
      )) : null,
    ),
  );
}

/**
 * 解析工作台 hash 路由（纯函数，无副作用）。
 * 支持：#/progress、#/board、#/inbox、#/search?q=…、#/issue/WB-12、#/issue/WB-12#finalBox、
 * 以及旧式查询串 #/progress?issue=WB-12#finalBox、?triage=<issueId>。
 * @param {string} hash
 * @returns {{ view: 'progress'|'board'|'inbox'|'search'|'issue'|'triage', ref: string|null, anchor: string }}
 */
function parseWorkbenchHash(hash) {
  const out = { view: 'progress', ref: null, anchor: '' };
  if (typeof hash !== 'string') return out;
  let rest = hash.trim();
  if (rest.startsWith('#')) rest = rest.slice(1);

  const anchorAt = rest.indexOf('#');
  if (anchorAt >= 0) { out.anchor = rest.slice(anchorAt + 1); rest = rest.slice(0, anchorAt); }

  let query = '';
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) { query = rest.slice(queryAt + 1); rest = rest.slice(0, queryAt); }
  if (rest.startsWith('/')) rest = rest.slice(1);

  const params = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    let decodedKey = key;
    let decodedValue = value;
    try { decodedKey = decodeURIComponent(key); } catch { /* 保持原串 */ }
    try { decodedValue = decodeURIComponent(value); } catch { /* 保持原串 */ }
    params[decodedKey] = decodedValue;
  }

  const segments = rest.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const head = segments[0] || '';
  const known = {
    progress: 'progress', projects: 'progress', home: 'progress',
    board: 'board', inbox: 'inbox', search: 'search', issue: 'issue', triage: 'triage',
  };

  if (!known[head]) {
    if (params.issue) { out.view = 'issue'; out.ref = params.issue; return out; }
    if (params.triage) { out.view = 'triage'; out.ref = params.triage; return out; }
    if (params.q !== undefined) { out.view = 'search'; out.ref = params.q; return out; }
    return out;
  }

  out.view = known[head];
  /* 旧式深链（PRD FR-40 的 ?issue=<编号>#finalBox）：查询串优先于页面段。 */
  if (params.issue && out.view !== 'issue') { out.view = 'issue'; out.ref = params.issue; return out; }
  if (params.triage && out.view !== 'triage') { out.view = 'triage'; out.ref = params.triage; return out; }
  const second = segments.length > 1 ? segments[1] : null;
  if (out.view === 'issue') out.ref = second || params.issue || null;
  else if (out.view === 'triage') out.ref = second || params.triage || null;
  else if (out.view === 'search') out.ref = params.q !== undefined ? params.q : second;
  else out.ref = second;
  return out;
}
