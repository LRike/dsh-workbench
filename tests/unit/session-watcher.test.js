import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWatcher } from '../../host/adapters/session-watcher.js';

// A macrotask boundary is what lets Node surface (or prove the absence of) an
// unhandled rejection.
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function makeHarness(options) {
  const throwSync = Boolean(options && options.throwSync);
  const handlers = new Map();
  const offs = [];
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler);
      const off = () => { offs.push(name); };
      return off;
    },
  };
  const warns = [];
  const logger = { warn: (message) => { warns.push(message); } };
  const ingests = [];
  const service = {
    ingestSessionEvent(payload) {
      ingests.push(payload);
      if (throwSync) throw new Error('E_SCHEMA_TOO_NEW');
      return Promise.reject(new Error('E_SCHEMA_TOO_NEW'));
    },
  };
  return { ctx, logger, service, handlers, offs, warns, ingests };
}

// The six ingest call sites the watcher owns (session/event carries two).
function fireAll(handlers) {
  handlers.get('session/created')({ id: 'session-1' });
  handlers.get('session/event')({ id: 'session-1' }, { type: 'turn/start', data: {} });
  handlers.get('session/event')({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  handlers.get('session/disposed')({ id: 'session-1' });
  handlers.get('agent/disposed')({ agent: { id: 'session-1' } });
  handlers.get('agent/status')({ agent: { id: 'session-1' }, status: 'idle' });
}

test('a rejecting ingestSessionEvent is logged instead of becoming an unhandled rejection', async () => {
  const harness = makeHarness();
  const watcher = createSessionWatcher(harness.ctx, harness.service, harness.logger);
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    fireAll(harness.handlers);
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    watcher.dispose();
  }
  assert.deepEqual(unhandled, [], 'a storage failure must not escape as an unhandled rejection');
  assert.deepEqual(harness.ingests.map((payload) => payload.kind),
    ['created', 'turn/start', 'turn/end', 'session/disposed', 'session/disposed', 'agent/status']);
  assert.equal(harness.warns.length, 6, 'each failed ingest is reported through warn()');
  for (const message of harness.warns) {
    assert.match(message, /^workbench: ingest \S+ failed: E_SCHEMA_TOO_NEW$/);
  }
});

test('a synchronous ingestSessionEvent throw is logged and swallowed too', () => {
  const harness = makeHarness({ throwSync: true });
  const watcher = createSessionWatcher(harness.ctx, harness.service, harness.logger);
  try {
    fireAll(harness.handlers);
  } finally {
    watcher.dispose();
  }
  assert.equal(harness.ingests.length, 6);
  assert.equal(harness.warns.length, 6);
});

test('dispose() runs every subscription off precisely once', () => {
  const harness = makeHarness();
  const watcher = createSessionWatcher(harness.ctx, harness.service, harness.logger);
  assert.deepEqual([...harness.handlers.keys()],
    ['session/created', 'session/event', 'session/disposed', 'agent/disposed', 'agent/status']);
  watcher.dispose();
  assert.deepEqual(harness.offs,
    ['session/created', 'session/event', 'session/disposed', 'agent/disposed', 'agent/status']);
});
