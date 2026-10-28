/**
 * The plugin HTTP surface: one named route on the DSH web server, JSON in and
 * JSON out. Authentication prefers the official Connection trust check
 * (ctx.connection.requestRejection) and falls back to loopback + same-origin
 * checks when that service is absent.
 */
import { API_PREFIX } from '../util/constants.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const hostOf = (req) => {
  const raw = String(req.headers.host || '');
  if (raw.startsWith('[')) { const end = raw.indexOf(']'); return end > 0 ? raw.slice(0, end + 1) : raw; }
  return raw.split(':')[0];
};
const sendJson = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const readBody = (req, limit = 256 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const ERROR_STATUS = {
  E_BAD_REQUEST: 400, E_FORBIDDEN: 403, E_NOT_FOUND: 404, E_CONFLICT: 409, E_LIMIT: 409,
  E_SCHEMA_TOO_NEW: 409, E_STATE: 422, E_ACCEPTANCE: 422, E_STORAGE: 500, E_LOCK_TIMEOUT: 503, E_INTERNAL: 500,
};
export const statusForCode = (code) => ERROR_STATUS[code] || 500;

function fallbackCheck(req, write) {
  if (!LOOPBACK.has(hostOf(req))) return { status: 403, message: 'workbench API is loopback-only' };
  if (req.headers.origin) {
    let parsed;
    try { parsed = new URL(req.headers.origin); } catch { return { status: 403, message: 'invalid Origin' }; }
    if (parsed.host !== String(req.headers.host || '')) return { status: 403, message: 'Origin does not match Host' };
  } else if (write) return { status: 403, message: 'missing Origin on a write request' };
  if (write) {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return { status: 403, message: 'cross-site write refused' };
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return { status: 403, message: 'writes require application/json' };
  }
  return undefined;
}

/** @param {{prefix?: string, service: any, logger?: any, authenticate?: (req: any) => (401|403|undefined)}} options */
export function createHttpApi(options) {
  const prefix = options.prefix || API_PREFIX;
  const service = options.service;
  const logger = options.logger;
  const authenticate = options.authenticate;

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    const apiVersion = service.apiVersion;
    if (!path.startsWith(prefix)) { sendJson(res, 404, { ok: false, apiVersion, error: { code: 'E_NOT_FOUND', message: 'unknown path' } }); return; }
    const route = path.slice(prefix.length) || '/';
    const write = req.method === 'POST';

    const rejection = typeof authenticate === 'function' ? authenticate(req) : undefined;
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, apiVersion, error: { code: 'E_FORBIDDEN', message: 'request rejected by the host trust check' } });
      return;
    }
    if (typeof authenticate !== 'function') {
      const check = fallbackCheck(req, write);
      if (check) { sendJson(res, check.status, { ok: false, apiVersion, error: { code: 'E_FORBIDDEN', message: check.message } }); return; }
    } else if (write && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      sendJson(res, 403, { ok: false, apiVersion, error: { code: 'E_FORBIDDEN', message: 'writes require application/json' } });
      return;
    }

    try {
      if (req.method === 'GET') {
        const since = url.searchParams.get('since');
        const response = await readRoute(route, url);
        if (response === undefined) { sendJson(res, 404, { ok: false, apiVersion, error: { code: 'E_NOT_FOUND', message: 'unknown route ' + route } }); return; }
        if (since !== null && String(response.version) === since) { sendJson(res, 200, { ok: true, apiVersion, unchanged: true, version: response.version }); return; }
        const { version, ...data } = response;
        sendJson(res, 200, { ok: true, apiVersion, version, data });
        return;
      }
      if (req.method === 'POST' && route === '/command') {
        const text = await readBody(req);
        let body;
        try { body = JSON.parse(text); } catch { sendJson(res, 400, { ok: false, apiVersion, error: { code: 'E_BAD_REQUEST', message: 'invalid JSON body' } }); return; }
        const isTest = typeof body.type === 'string' && body.type.startsWith('test.');
        const result = isTest ? await service.executeTest(body) : await service.execute(body);
        sendJson(res, 200, { ok: true, apiVersion, version: result.version, data: result });
        return;
      }
      sendJson(res, 404, { ok: false, apiVersion, error: { code: 'E_NOT_FOUND', message: 'unknown route ' + route } });
    } catch (error) {
      const code = (error && error.code) || 'E_INTERNAL';
      if (code === 'E_INTERNAL') { try { logger && logger.warn && logger.warn('workbench http: ' + String(error && error.stack ? error.stack : error)); } catch {} }
      sendJson(res, statusForCode(code), { ok: false, apiVersion, error: { code, message: String((error && error.message) || error), details: (error && error.details) || undefined } });
    }
  };

  async function readRoute(route, url) {
    if (route === '/snapshot') return service.snapshot();
    if (route === '/inbox') return service.inbox();
    if (route === '/board') return service.board();
    if (route === '/search') return service.search(url.searchParams.get('q') || '');
    if (route === '/issue') {
      const detail = service.issueDetail(url.searchParams.get('id') || '');
      if (detail === undefined) throw Object.assign(new Error('issue not found'), { code: 'E_NOT_FOUND' });
      return detail;
    }
    if (route === '/project') {
      const detail = service.projectDetail(url.searchParams.get('id') || '');
      if (detail === undefined) throw Object.assign(new Error('project not found'), { code: 'E_NOT_FOUND' });
      return detail;
    }
    if (route === '/activity') return service.activity(url.searchParams.get('issueId') || '', Number(url.searchParams.get('before') || NaN) || undefined, Number(url.searchParams.get('limit') || 50));
    if (route === '/workspaces') return service.workspaces();
    if (route === '/archived') return service.archived();
    return undefined;
  }
}
