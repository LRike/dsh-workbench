/**
 * DSH event subscription. Every event is normalized into the session-state
 * vocabulary and handed to the service; the same entry point serves the test
 * seams, so tests and production exercise one code path.
 */
export function createSessionWatcher(ctx, service, logger) {
  const warn = (message) => { try { logger && logger.warn && logger.warn('workbench: ' + message); } catch {} };
  const offs = [];
  const now = () => new Date().toISOString();
  const on = (name, handler) => {
    try { const off = ctx.on(name, handler); if (typeof off === 'function') offs.push(off); }
    catch (error) { warn('subscribe ' + name + ' failed: ' + String(error)); }
  };
  const describe = (error) => String(error && error.message ? error.message : error);
  /**
   * Hand one normalized event to the service without ever letting a rejection
   * escape: ingestSessionEvent is async and writes the document, so a storage
   * failure (E_SCHEMA_TOO_NEW / E_LOCK_TIMEOUT / ENOSPC) used to become an
   * unhandled rejection and take the whole DSH host down. Failures are logged
   * and dropped; the event vocabulary and the synchronous ordering stay as-is.
   */
  const ingest = (payload) => {
    const failed = (error) => warn('ingest ' + payload.kind + ' failed: ' + describe(error));
    try {
      const pending = service.ingestSessionEvent(payload);
      if (pending && typeof pending.catch === 'function') pending.catch(failed);
    } catch (error) { failed(error); }
  };

  on('session/created', (session) => {
    if (!session || !session.id) return;
    ingest({ sessionId: session.id, kind: 'created', at: now() });
  });
  on('session/event', (session, event) => {
    if (!session || !session.id || !event) return;
    if (event.type === 'turn/start') ingest({ sessionId: session.id, kind: 'turn/start', at: now() });
    else if (event.type === 'turn/end') ingest({ sessionId: session.id, kind: 'turn/end', reason: event.data && event.data.reason ? event.data.reason : { kind: 'completed' }, at: now() });
  });
  on('session/disposed', (session) => {
    if (!session || !session.id) return;
    ingest({ sessionId: session.id, kind: 'session/disposed', at: now() });
  });
  on('agent/disposed', (payload) => {
    const agent = payload && payload.agent ? payload.agent : payload;
    if (!agent || !agent.id) return;
    ingest({ sessionId: agent.id, kind: 'session/disposed', at: now() });
  });
  on('agent/status', (payload) => {
    const agent = payload && payload.agent ? payload.agent : payload;
    if (!agent || !agent.id) return;
    ingest({ sessionId: agent.id, kind: 'agent/status', at: now() });
  });

  return { dispose() { for (const off of offs) { try { off(); } catch {} } } };
}
