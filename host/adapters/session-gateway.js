/**
 * DSH session gateway: the only place that calls sessionController and
 * workspaceRegistry. Failures are tagged with the phase they happened in.
 */
export function createSessionGateway(ctx, logger) {
  const warn = (message) => { try { logger && logger.warn && logger.warn('workbench: ' + message); } catch {} };

  async function resolveWorkspaceId(workspacePath) {
    const registry = ctx.workspaceRegistry;
    const existing = registry.list().find((workspace) => { try { return workspace.path === workspacePath; } catch { return false; } });
    if (existing) return existing.id;
    const created = await registry.create(workspacePath);
    return created.id;
  }

  function sessionInfo(session) {
    let cwd = null;
    let title = null;
    try { cwd = session.header && session.header.cwd ? session.header.cwd : null; } catch {}
    try { title = session.title || null; } catch {}
    return { sessionId: session.id, cwd, title };
  }

  return {
    async list() {
      const response = await ctx.sessionController.list({});
      const items = Array.isArray(response.items) ? response.items : [];
      return items.map((row) => ({
        sessionId: row.sessionId,
        cwd: row.cwd || null,
        title: row.title || null,
        running: row.running === true,
        blank: row.blank === true,
        endedAt: row.running === true ? null : (row.updatedAt ? new Date(row.updatedAt).toISOString() : null),
        hasOutput: row.blank !== true && ((row.projections && row.projections.values && row.projections.values.turnOutline && row.projections.values.turnOutline.length > 0) || row.blank === false),
        agentAvailable: row.agentAvailable === true,
      }));
    },

    async listWorkspaces() {
      const registry = ctx.workspaceRegistry;
      return registry.list().map((workspace) => ({
        workspaceId: workspace.id,
        path: (() => { try { return workspace.path; } catch { return null; } })(),
        title: (() => { try { return workspace.title; } catch { return null; } })(),
        sessionCount: (() => { try { return workspace.sessionIds.length; } catch { return 0; } })(),
      }));
    },

    async startRound({ workspacePath, sessionId, title, prompt }) {
      const workspaceId = await resolveWorkspaceId(workspacePath);
      try {
        await ctx.sessionController.create({ workspaceId, sessionId });
      } catch (error) {
        throw tag(error, 'create');
      }
      try { await ctx.sessionController.rename({ sessionId, title }); } catch (error) { warn('rename failed: ' + String(error)); }
      try {
        const controller = new AbortController();
        await ctx.sessionController.prompt({ sessionId, requestId: 'wb-start-' + sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, controller.signal);
      } catch (error) {
        throw tag(error, 'prompt');
      }
      return { sessionId };
    },

    async sendMessage(sessionId, text) {
      const controller = new AbortController();
      await ctx.sessionController.prompt({ sessionId, requestId: 'wb-msg-' + Date.now().toString(36), mode: 'queue', content: [{ type: 'text', text }] }, controller.signal);
    },

    async cancel(sessionId) {
      try { await ctx.sessionController.cancel({ sessionId }); } catch (error) { warn('cancel failed: ' + String(error)); }
    },

    sessions: {
      cancel(sessionId) { void ctx.sessionController.cancel({ sessionId }).catch((error) => warn('cancel failed: ' + String(error))); },
    },
  };
}

function tag(error, phase) {
  const tagged = /** @type {any} */ (error instanceof Error ? error : new Error(String(error)));
  tagged.phase = phase;
  return tagged;
}
