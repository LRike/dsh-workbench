/* 状态看板（PRD FR-60）：只显示 4 个活跃列，空列隐藏，卡片按最近活动倒序。
   没有「完成」列，也不提供拖拽到完成——验收只走单元验收与议题终验收。 */

const WB_BOARD_STATUS_LABELS = {
  todo: '待认领',
  in_progress: '处理中',
  blocked: '遇到阻碍',
  in_review: '等你确认',
};

/** 项目名：宿主可能只给 projectId（queries.buildBoard），从 snapshot.projects 补名。 */
function boardProjectName(item, props) {
  if (item && typeof item.projectName === 'string' && item.projectName.length > 0) return item.projectName;
  const projects = props && props.snapshot && Array.isArray(props.snapshot.projects) ? props.snapshot.projects : [];
  if (!item || !item.projectId) return '';
  const hit = projects.find((project) => String(project.projectId) === String(item.projectId));
  return hit && hit.name ? String(hit.name) : '';
}

/**
 * 看板视图。
 * @param {{ snapshot?: any, reload?: () => any, navigate?: (view: string, ref?: any, anchor?: string) => void }} props
 */
function BoardView(props) {
  const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const body = await apiGet('/board');
      setState({ phase: 'ready', data: body.data || {}, error: null });
    } catch (error) {
      setState((previous) => ({ phase: previous.data ? 'ready' : 'error', data: previous.data, error: wbErrorText(error) }));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    await load();
    if (props && typeof props.reload === 'function') { try { await props.reload(); } catch { /* 计数刷新失败不影响看板 */ } }
    setBusy(false);
  };

  const data = state.data || {};
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const maxPerColumn = Number.isInteger(data.maxPerColumn) && data.maxPerColumn > 0 ? data.maxPerColumn : 20;

  return h('div', {
    'data-wb-board': 'board',
    style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px 28px', height: '100%', boxSizing: 'border-box', overflow: 'auto', color: TOKENS.text, background: TOKENS.bg },
  },
    h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h1', { style: { margin: 0, fontSize: '22px', lineHeight: 1.25 } }, '看板'),
        h('p', { style: { margin: 0, fontSize: '12px', color: TOKENS.textSecondary } }, '只显示 4 个活跃列（待认领 / 处理中 / 遇到阻碍 / 等你确认）；空列自动隐藏'),
      ),
      wbButton({ tone: 'plain', label: '刷新', action: 'refresh', disabled: busy, onClick: () => { void refresh(); } }),
    ),
    h('div', {
      'data-wb-board-note': 'no-done',
      style: { padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: TOKENS.bgSecondary, color: TOKENS.textSecondary },
    }, '没有「完成」列，也不能拖拽到完成：完成必须经「单元验收 → 议题终验收」写入，看板只做状态纠正。完成 / 取消是收尾状态，在收件箱与项目视图里查。'),
    state.error ? h('div', {
      'data-wb-error': 'board',
      style: { padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: 'color-mix(in srgb, ' + TOKENS.danger + ' 12%, transparent)', color: TOKENS.danger },
    }, '看板读取失败：' + state.error) : null,

    columns.length === 0
      ? h('div', {
          'data-wb-empty': 'board',
          style: { padding: '28px', border: '1px dashed ' + TOKENS.border, borderRadius: '10px', textAlign: 'center', color: TOKENS.textSecondary, fontSize: '12px' },
        }, state.phase === 'loading' ? '正在读取看板…' : '看板暂无活跃议题（完成 / 取消不进看板）。')
      : h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', overflowX: 'auto', paddingBottom: '6px' } },
          columns.map((column) => {
            const items = Array.isArray(column.items) ? column.items : [];
            const scroll = items.length > maxPerColumn;
            return h('section', {
              key: String(column.status),
              'data-wb-board-column': String(column.status),
              style: { flex: '1 0 220px', minWidth: '220px', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: '1px solid ' + TOKENS.border, borderRadius: '10px', background: TOKENS.bgSecondary },
            },
              h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
                h('h2', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, WB_BOARD_STATUS_LABELS[column.status] || String(column.status)),
                h('span', { style: { fontSize: '11px', color: TOKENS.textSecondary } }, String(items.length)),
              ),
              h('ul', {
                style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: scroll ? '460px' : 'none', overflowY: scroll ? 'auto' : 'visible' },
              },
                items.map((item) => {
                  const projectName = boardProjectName(item, props);
                  return h('li', {
                    key: String(item.issueId),
                    'data-wb-board-card': String(item.code || item.issueId),
                    style: { padding: '8px 10px', border: '1px solid ' + TOKENS.border, borderRadius: '8px', background: TOKENS.bg, display: 'flex', flexDirection: 'column', gap: '4px' },
                  },
                    h('button', {
                      type: 'button',
                      onClick: () => wbNavigate(props, 'issue', wbIssueRef(item)),
                      'data-wb-action': 'open-issue',
                      style: { textAlign: 'left', padding: 0, border: 'none', background: 'transparent', color: TOKENS.text, cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 500 },
                    }, (item.code ? String(item.code) + ' · ' : '') + String(item.title || '')),
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11px', color: TOKENS.textSecondary } },
                      projectName ? h('span', null, projectName) : null,
                      item.lastActivityAt ? h('span', null, '最近活动 ' + wbTimeAgo(item.lastActivityAt)) : null,
                    ),
                  );
                }),
              ),
              scroll ? h('div', { style: { fontSize: '10px', color: TOKENS.textSecondary } }, '列内滚动（共 ' + items.length + ' 张，超过 ' + maxPerColumn + '）') : null,
            );
          }),
        ),
  );
}
