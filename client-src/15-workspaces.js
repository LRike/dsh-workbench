/* Workspace picking: the host already knows which directories DSH has opened,
   so nobody should have to type a path. The field lists them and keeps an
   explicit "手动输入" escape hatch for directories DSH has not seen yet. */

const WB_WS_FALLBACK = { list: [], loading: true, error: null };

function useWorkspaces() {
  const [state, setState] = React.useState(WB_WS_FALLBACK);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await apiGet('/workspaces');
        const list = body && body.data && Array.isArray(body.data.workspaces) ? body.data.workspaces : [];
        if (live) setState({ list, loading: false, error: null });
      } catch (error) {
        if (live) setState({ list: [], loading: false, error: String(error && error.message ? error.message : error) });
      }
    })();
    return () => { live = false; };
  }, []);
  return state;
}

/** A <select> of DSH workspaces plus "不绑定" and "手动输入" options. */
function WorkspaceField(props) {
  const options = useWorkspaces();
  const value = props.value === undefined || props.value === null ? '' : String(props.value);
  const [manual, setManual] = React.useState(false);
  const knownPath = options.list.some((item) => item.path === value);
  const listReady = !options.loading;
  // Never fall back to typing on our own: a stored-but-unregistered path (e.g. an
  // old issue pointing at a directory DSH no longer lists) stays selectable in the
  // dropdown as its own option. Typing is only ever the explicit "手动输入" choice.
  const showInput = manual;
  const selectValue = showInput ? '__manual__' : value;
  const base = {
    color: 'inherit',
    background: 'color-mix(in srgb, currentColor 7%, transparent)',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    borderRadius: '8px',
    padding: '7px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
    minWidth: '0',
  };
  return React.createElement('div', { 'data-wb-workspace-field': 'field', style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
      React.createElement('select', {
        'data-wb-workspace-select': 'select',
        'aria-label': props.label || '工作区目录',
        value: selectValue,
        disabled: props.disabled === true,
        onChange: (event) => {
          const next = event.target.value;
          if (next === '__manual__') { setManual(true); props.onChange(value); return; }
          setManual(false);
          props.onChange(next === '' ? null : next);
        },
        style: Object.assign({}, base, { flex: '1 1 220px', minWidth: '0' }),
      },
        React.createElement('option', { value: '' }, props.emptyLabel || '不绑定目录（可稍后设置）'),
        options.list.filter((item) => item.path).map((item) => React.createElement('option', {
          key: item.workspaceId || item.path,
          value: item.path,
        }, (item.title ? item.title + ' · ' : '') + item.path)),
        value !== '' && !knownPath ? React.createElement('option', { value: value }, '（当前值，DSH 未登记）' + value) : null,
        React.createElement('option', { value: '__manual__' }, '手动输入路径…'),
      ),
      props.allowManual === false ? null : React.createElement('button', {
        type: 'button',
        'data-wb-workspace-manual': 'toggle',
        onClick: () => { setManual(!showInput); if (showInput) props.onChange(null); },
        style: Object.assign({}, base, { cursor: 'pointer', flex: '0 0 auto' }),
      }, showInput ? '从 DSH 工作区选' : '手动输入'),
    ),
    showInput ? h('input', {
      'data-wb-workspace-input': 'input',
      'data-wb-triage': props.triageAttr || undefined,
      value: value,
      placeholder: '/绝对路径/项目目录',
      disabled: props.disabled === true,
      onChange: (event) => props.onChange(event.target.value === '' ? null : event.target.value),
      style: Object.assign({}, base, { width: '100%' }),
    }) : null,
    options.error ? h('span', { style: { fontSize: '12px', color: TOKENS.danger } }, '无法读取 DSH 工作区：' + options.error) : null,
    !showInput && listReady && value !== '' && !knownPath
      ? h('span', { 'data-wb-workspace-unknown': 'unknown', style: { fontSize: '12px', color: TOKENS.textSecondary } }, '该目录不在 DSH 当前工作区列表里（历史值已保留，可改选或保持）')
      : null,
    !options.error && listReady && options.list.length === 0 && !showInput
      ? h('span', { 'data-wb-workspace-empty': 'empty', style: { fontSize: '12px', color: TOKENS.textSecondary } }, 'DSH 里还没有打开过工作区：可先「手动输入」，或先在会话里打开一个目录。')
      : null,
    props.hint ? h('span', { style: { fontSize: '12px', color: TOKENS.textSecondary } }, props.hint) : null,
  );
}
