function WorkbenchIcon(props) {
  const size = props && props.size ? props.size : 16;
  return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
    h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
    h('path', { d: 'M4.5 5.5h7M4.5 8h7M4.5 10.5h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    h('circle', { cx: 11.6, cy: 10.9, r: 2.1, fill: 'currentColor' }),
  );
}

return {
  inject: ['slots'],
  apply(ctx) {
    try { wbEnsureStyles(); } catch (error) { /* styles are best-effort */ }
    // Capture the shell layout service: layout.selectPanel is the official way to
    // switch the main panel, which is what "open the conversation" needs.
    try {
      WB_RUNTIME.ctx = ctx;
      if (WB_DEBUG) { try { window.__WB_CTX__ = ctx; } catch (error) { /* not a browser */ } }
      const layout = typeof ctx.get === 'function' ? ctx.get('layout') : null;
      wbAdoptLayout(layout);
      // the layout service may mount later than this plugin: capture it reactively
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (inner) => {
          const late = inner && inner.layout ? inner.layout : null;
          wbAdoptLayout(late);
        });
      }
    } catch (error) { /* older shell without the service */ }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench' }, Panel));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'workbench', order: -1, label: '工作台' }, WorkbenchIcon));
    try { if (typeof registerClaimDock === 'function') registerClaimDock(ctx); } catch (error) { /* the composer dock is optional */ }
  },
};
