/**
 * Workbench host half.
 *
 * apply() always runs (only profileContext is injected) so a profile without a
 * web surface still loads the plugin and its host logic. The HTTP route, session
 * watcher and reconciliation are mounted from a nested injection once the web
 * and session services are available; when they never appear (headless), the
 * plugin stays loaded but exposes no route — the documented headless behaviour.
 */
import { join } from 'node:path';
import { createRepository, SchemaTooNewError } from './host/store/repository.js';
import { createService } from './host/service/workbench.js';
import { createHttpApi } from './host/adapters/http-api.js';
import { createSessionGateway } from './host/adapters/session-gateway.js';
import { createSessionWatcher } from './host/adapters/session-watcher.js';
import { registerWorkbenchTools, TOOL_NAMES } from './host/adapters/tools.js';
import { API_PREFIX, PLUGIN_ID } from './host/util/constants.js';

export const inject = ['profileContext'];

/** Services needed to expose the browser surface; absent in headless. */
const WEB_SERVICES = ['webServer', 'connection', 'sessionController', 'workspaceRegistry', 'sessions', 'tools'];

/**
 * @param {any} ctx
 * @param {{file?: string, apiPrefix?: string, clockMs?: () => number}} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const home = ctx.profileContext.home;
  const file = config.file || join(home, 'workbench', 'workbench.json');
  const apiPrefix = config.apiPrefix || API_PREFIX;

  const baseClockMs = typeof config.clockMs === 'function' ? config.clockMs : () => Date.now();
  let seamBaseMs = null;
  const clock = {
    nowMs: () => (seamBaseMs === null ? baseClockMs() : seamBaseMs),
    now: () => new Date(clock.nowMs()).toISOString(),
    setClock: (ms) => { seamBaseMs = Number(ms); },
    advance: (ms) => { seamBaseMs = (seamBaseMs === null ? Date.now() : seamBaseMs) + Number(ms); },
  };

  const repository = createRepository({ file, logger, now: clock.now });
  let degraded = false;
  let schemaTooNew = false;
  try {
    repository.load();
    logger && logger.info && logger.info('workbench: store loaded at ' + file);
  } catch (error) {
    degraded = true;
    if (error instanceof SchemaTooNewError) { schemaTooNew = true; logger && logger.warn && logger.warn('workbench: ' + error.message); }
    else logger && logger.warn && logger.warn('workbench: store load failed: ' + String(error && error.stack ? error.stack : error));
  }

  /** @type {any} */
  const ports = {};
  // Runtime diagnostics surfaced through the test seam (phase-3 acceptance uses it).
  const diagnostics = { toolsRegistered: false, toolNames: [] };
  const service = createService({
    repository, logger, ports, clock, diagnostics,
    storeProblem: () => (schemaTooNew ? 'the document was written by a newer workbench version; update the plugin' : null),
  });
  if (typeof ctx.provide === 'function') { try { ctx.provide('workbench', service); } catch {} }
  logger && logger.info && logger.info('workbench: host half loaded (' + (degraded ? 'degraded' : 'ok') + ')');

  try {
    ctx.inject(WEB_SERVICES, (scoped) => {
      const gateway = createSessionGateway(scoped, logger);
      ports.sessions = gateway;

      const authenticate = (req) => {
        try {
          const connection = scoped.connection;
          if (connection && typeof connection.requestRejection === 'function') return connection.requestRejection({ headers: req.headers });
        } catch (error) { logger && logger.warn && logger.warn('workbench: trust check failed: ' + String(error)); }
        return undefined;
      };

      const handler = createHttpApi({ prefix: apiPrefix, service, logger, authenticate });
      let disposeRoute;
      try {
        disposeRoute = scoped.webServer.register({ kind: 'prefix', path: apiPrefix, handler });
        logger && logger.info && logger.info('workbench: API mounted at ' + apiPrefix);
      } catch (error) { logger && logger.warn && logger.warn('workbench: API route registration failed: ' + String(error)); }
      if (disposeRoute) scoped.effect(() => () => { try { disposeRoute(); } catch {} });

      const watcher = createSessionWatcher(scoped, service, logger);
      scoped.effect(() => () => { try { watcher.dispose(); } catch {} });

      try {
        const disposeTools = registerWorkbenchTools(scoped, service, logger);
        diagnostics.toolsRegistered = true;
        diagnostics.toolNames = Array.isArray(TOOL_NAMES) ? TOOL_NAMES.slice() : [];
        if (typeof disposeTools === 'function') scoped.effect(() => () => { try { disposeTools(); diagnostics.toolsRegistered = false; } catch {} });
      } catch (error) { logger && logger.warn && logger.warn('workbench: tool registration failed: ' + String(error)); }

      setTimeout(() => {
        void (async () => {
          try {
            const doc = repository.document;
            const writerPid = doc.meta && doc.meta.writer && doc.meta.writer.pid;
            if (writerPid && writerPid !== process.pid) {
              logger && logger.info && logger.info('workbench: skipping reconcile (another instance is the writer)');
              return;
            }
            const rows = await gateway.list();
            const { corrections } = await service.reconcile(rows);
            if (corrections && corrections.length > 0) logger && logger.info && logger.info('workbench: reconciled ' + corrections.length + ' unit(s) after startup');
          } catch (error) { logger && logger.warn && logger.warn('workbench: startup reconcile failed: ' + String(error)); }
        })();
      }, 900).unref?.();
    });
  } catch (error) {
    logger && logger.warn && logger.warn('workbench: web services unavailable, host-only mode: ' + String(error));
  }
}
