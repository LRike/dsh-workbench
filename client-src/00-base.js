/* Workbench client half: plain JS inside the browser module loader factory.
   React arrives from the host's module table; no imports, no JSX.

   Theme strategy: never hardcode light-theme colours. Everything derives from
   the inherited text colour via color-mix(), so light and dark both follow the
   host theme automatically. DSH's own variables are used when they exist, and a
   stylesheet injected once supplies the rest (plus layout-boundary rules). */
const h = React.createElement;
const API = '/workbench/api';
const POLL_MS = 1500;

/** ReactDOM is optional: only used to portal the modal out of clipped ancestors. */
const WB_REACT_DOM = (() => { try { const mod = require('react-dom'); return mod && typeof mod.createPortal === 'function' ? mod : null; } catch (error) { return null; } })();

const WB_STYLE_ID = 'wb-ui-style';
const WB_STYLE = [
  ':root{--wb-accent:#2f6feb;--wb-accent-strong:#1d4ed8;--wb-danger:#c62828;--wb-ok:#1b7f4b;--wb-warn:#9a6700;--wb-surface:#ffffff;--wb-surface-2:#f4f5f7;--wb-ink:#1f2329;--wb-surface-border:#d0d5dd}',
  '@media (prefers-color-scheme:dark){:root{--wb-accent:#7aa2ff;--wb-accent-strong:#4d7ef7;--wb-danger:#ff8a80;--wb-ok:#5bd394;--wb-warn:#f0b849;--wb-surface:#26262b;--wb-surface-2:#2f2f37;--wb-ink:#f2f3f5;--wb-surface-border:#41414a}}',
  '[data-wb-panel]{color:inherit;background:transparent;min-width:0;box-sizing:border-box;-webkit-app-region:no-drag}',
  '[data-wb-dialog] *{pointer-events:auto}',
  '[data-wb-panel] *{box-sizing:border-box;min-width:0}',
  '[data-wb-panel] input,[data-wb-panel] textarea,[data-wb-panel] select,[data-wb-dialog] input,[data-wb-dialog] textarea,[data-wb-dialog] select{color:inherit;background:color-mix(in srgb,currentColor 7%,transparent);border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;-webkit-app-region:no-drag;pointer-events:auto;user-select:text}',
  '[data-wb-panel] input:focus,[data-wb-panel] textarea:focus,[data-wb-panel] select:focus,[data-wb-dialog] input:focus,[data-wb-dialog] textarea:focus,[data-wb-dialog] select:focus{outline:2px solid var(--wb-accent);outline-offset:1px;border-color:transparent}',
  '[data-wb-panel] button,[data-wb-dialog] button{font:inherit;-webkit-app-region:no-drag;min-height:24px;min-width:24px}',
  '[data-wb-panel] button:hover:not(:disabled),[data-wb-dialog] button:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}',
  '[data-wb-panel] button:focus,[data-wb-dialog] button:focus{outline:2px solid var(--wb-accent);outline-offset:2px;box-shadow:0 0 0 3px color-mix(in srgb,var(--wb-accent) 30%,transparent)}',
  '[data-wb-panel] button:hover:not(:disabled){filter:brightness(1.18)}',
  '[data-wb-panel] input,[data-wb-panel] select,[data-wb-dialog] input,[data-wb-dialog] select{min-height:24px}',
  '[data-wb-panel] button:disabled{opacity:.5;cursor:not-allowed}',
  '[data-wb-panel] a{color:var(--wb-accent)}',
  '[data-wb-panel] ::-webkit-scrollbar{width:10px;height:10px}',
  '[data-wb-panel] ::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 25%,transparent);border-radius:8px}',
  '[data-wb-dialog]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;padding:min(6vh,48px) 16px;overflow:auto;background:rgba(0,0,0,.38);-webkit-app-region:no-drag}',
  '[data-wb-dialog-card]{width:min(720px,100%);max-height:88vh;overflow:auto;border-radius:14px;padding:20px 22px;box-shadow:0 18px 48px rgba(0,0,0,.28);background:light-dark(#fff,#1b1b1f);color:light-dark(#1f2329,#f2f3f5);-webkit-app-region:no-drag}',
  '@supports not (background:light-dark(#fff,#000)){[data-wb-dialog-card]{background:#fff;color:#1f2329}}',
  '[data-wb-panel] [data-wb-row]{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  '[data-wb-panel] [data-wb-ellipsis]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
  '[data-wb-panel] [data-wb-pre]{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}',
  '[data-wb-panel] [data-wb-scroll]{overflow:auto;max-height:46vh}',
  '@media (max-width:900px){[data-wb-dialog]{padding:12px 8px}[data-wb-dialog-card]{max-height:94vh;padding:16px}}',
].join('\n');

function wbEnsureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(WB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = WB_STYLE_ID;
  style.textContent = WB_STYLE;
  document.head.appendChild(style);
}

/** Theme-agnostic tokens: every colour follows the inherited (themed) text colour. */
const TOKENS = {
  text: 'inherit',
  textSecondary: 'color-mix(in srgb, currentColor 62%, transparent)',
  textMuted: 'color-mix(in srgb, currentColor 46%, transparent)',
  bg: 'transparent',
  bgSecondary: 'color-mix(in srgb, currentColor 6%, transparent)',
  bgRaised: 'color-mix(in srgb, currentColor 10%, transparent)',
  border: 'color-mix(in srgb, currentColor 20%, transparent)',
  borderStrong: 'color-mix(in srgb, currentColor 34%, transparent)',
  accent: 'var(--wb-accent)',
  accentStrong: 'var(--wb-accent-strong)',
  danger: 'var(--wb-danger)',
  ok: 'var(--wb-ok)',
  warn: 'var(--wb-warn)',
  radius: '10px',
  gap: '10px',
};

/** Host services captured in apply(), usable from any view (e.g. panel switching). */
const WB_RUNTIME = { layout: null, ctx: null };

/** Debug seams are opt-in (add ?wbDebug=1): never expose shell services by default. */
const WB_DEBUG = (() => {
  try {
    if (typeof window !== 'undefined' && window.__WB_DEBUG__ === true) return true;
    return typeof location !== 'undefined' && /(?:^|[?&])wbDebug=1(?:&|$)/.test(String(location.search || ''));
  }
  catch (error) { return false; }
})();

/** Adopt the shell layout service (the only official panel/session switch). */
function wbAdoptLayout(layout) {
  if (!layout || typeof layout.selectPanel !== 'function') return null;
  WB_RUNTIME.layout = layout;
  // Probe seam: the shell bundle is minified, so runtime inspection is the only
  // way to learn which session-switching methods this build actually exposes.
  if (WB_DEBUG) { try { window.__WB_LAYOUT__ = layout; } catch (error) { /* not a browser */ } }
  return layout;
}

/** Resolve the shell layout service lazily: apply() may run before it exists. */
function wbResolveLayout() {
  if (WB_RUNTIME.layout && typeof WB_RUNTIME.layout.selectPanel === 'function') return WB_RUNTIME.layout;
  try {
    const ctx = WB_RUNTIME.ctx;
    const found = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
    const adopted = wbAdoptLayout(found);
    if (adopted) return adopted;
  } catch (error) { /* service not mounted */ }
  return null;
}

/** Last resort when the layout service is unavailable: click the shell's 对话 panel button. */
function wbClickConversationTab() {
  if (typeof document === 'undefined') return false;
  try {
    const buttons = [...document.querySelectorAll('button, [role=tab], [role=button]')];
    const hit = buttons.find((el) => {
      if (el.closest('[data-wb-panel]')) return false;
      const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      return label === '对话' || label === '会话' || label === '新会话';
    });
    if (!hit) return false;
    hit.click();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Open the conversation of ONE specific session. The shell exposes this on the
 * uiWorkspace service (openSession(sessionId)); layout.selectPanel alone only
 * switches the panel and leaves whatever session was active — that was the bug
 * behind 「打开对话」 showing the wrong conversation.
 */
function wbOpenSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (id === '') return false;
  try {
    const ctx = WB_RUNTIME.ctx;
    const uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
    if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
      uiWorkspace.openSession(id);
      return true;
    }
  } catch (error) { /* older shell without the service */ }
  // Fallback: at least switch to the conversation panel (better than nothing).
  return wbSelectConversation();
}

/** Switch the shell's main panel back to the conversation view (official service). */
function wbSelectConversation() {
  try {
    const layout = wbResolveLayout();
    if (layout) {
      layout.selectPanel('conversation');
      return true;
    }
  } catch (error) { /* fall through to the DOM fallback */ }
  return wbClickConversationTab();
}


/** Draft storage that survives a host-driven remount (kept in module scope). */
const WB_DRAFTS = typeof window !== 'undefined' ? (window.__wbDrafts = window.__wbDrafts || {}) : {};
function wbDraft(key, initial) {
  if (!(key in WB_DRAFTS)) WB_DRAFTS[key] = initial;
  return WB_DRAFTS[key];
}
function wbSetDraft(key, value) { WB_DRAFTS[key] = value; }
function wbClearDraft(key) { delete WB_DRAFTS[key]; }

/** Focus helper: retry a few frames and beat host-level focus traps. */
function wbFocus(node, attempt) {
  if (!node || typeof node.focus !== 'function') return;
  const tries = typeof attempt === 'number' ? attempt : 0;
  try { node.focus({ preventScroll: false }); } catch (error) { try { node.focus(); } catch (error2) { /* ignore */ } }
  if (tries < 6) {
    setTimeout(() => {
      if (document.activeElement !== node) wbFocus(node, tries + 1);
    }, 40 * (tries + 1));
  }
}
