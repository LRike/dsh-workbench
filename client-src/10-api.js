/** Same-origin JSON client for the workbench host route. */
async function apiGet(path) {
  const response = await fetch(API + path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error && body.error.message ? body.error.message : 'request failed'), { code: body.error && body.error.code });
  return body;
}

/** Commands in flight, keyed by type+payload: a double/triple click reuses the
 *  same promise instead of firing N writes (the host would create N rows). */
const WB_INFLIGHT = new Map();

async function apiCommand(type, payload) {
  const key = type + '|' + JSON.stringify(payload || {});
  const running = WB_INFLIGHT.get(key);
  if (running) return running;
  const task = apiCommandOnce(type, payload);
  WB_INFLIGHT.set(key, task);
  try {
    return await task;
  } finally {
    WB_INFLIGHT.delete(key);
  }
}

async function apiCommandOnce(type, payload) {
  const requestId = 'c_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
  const response = await fetch(API + '/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ type, payload: payload || {}, clientRequestId: requestId }),
  });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error && body.error.message ? body.error.message : 'command failed'), { code: body.error && body.error.code, status: response.status });
  // The host wraps command results in { result, version }; callers read fields
  // (issueId, cwd, sessionId…) directly, so unwrap once here instead of at
  // every call site.
  const data = body.data && typeof body.data === 'object' && body.data.result !== undefined
    ? Object.assign({}, body.data.result, { version: body.data.version })
    : body.data;
  return Object.assign({}, body, { data: data });
}
