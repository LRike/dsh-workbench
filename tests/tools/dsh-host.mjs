/**
 * Integration-test fixture: boot a real DSH web host with the workbench plugin
 * installed, in a throwaway DSH_HOME, and hand back everything a test needs to
 * talk to it over HTTP.
 *
 * Zero dependencies: node:child_process + global fetch (Node >= 22).
 *
 * Usage:
 *   const host = await startHost();                 // profile 'it'
 *   host.base                                       // http://127.0.0.1:<port>
 *   host.tokenUrl                                   // base + '/?token=...'
 *   host.cookieHeader                               // 'name=value; ...' from the token handshake
 *   await host.stop();                              // kill the process + remove the temp home
 *
 * The plugin's own API route is not token-fenced (phase 0 R1 probe), so most
 * calls work without a cookie; we still capture the cookie because the official
 * requestRejection fence may start guarding routes (authMode), and because the
 * page itself needs it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** workbench-plugin/ */
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
/**
 * The DSH CLI ships inside the plugin now (tools/dsh-cli.sh), so tests do not need
 * a separate workspace; WB_WORKSPACE only redirects where gate output is written.
 */
export const REPO_ROOT = process.env.WB_WORKSPACE && process.env.WB_WORKSPACE.length > 0
  ? resolve(process.env.WB_WORKSPACE)
  : PLUGIN_ROOT;
export const DSH_CLI = join(PLUGIN_ROOT, 'tools', 'dsh-cli.sh');
export const DSH_APP_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** True when this machine can actually boot a DSH host. */
export function isDshAvailable() {
  return existsSync(DSH_CLI) && existsSync(DSH_APP_BIN);
}

/** Tail of a log file/string, for error messages. */
function tail(text, lines = 40) {
  const all = String(text || '').trimEnd().split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

function runCli(args, env) {
  const result = spawnSync(DSH_CLI, args, { env, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw new Error('dsh-cli failed to start: ' + result.error.message);
  if (result.status !== 0) {
    throw new Error('dsh-cli ' + args.join(' ') + ' exited ' + result.status + '\n' + tail(result.stderr || result.stdout));
  }
  return result.stdout || '';
}

/**
 * Append a profile patch layer (e.g. to override the plugin config / authMode).
 * The file is the profile's cordis.patch.yml; call this before booting, or use
 * startHost({ patchYaml }) which applies it in the right place.
 * @param {string} profileDir
 * @param {string} patchYaml
 */
export function installView(profileDir, patchYaml) {
  if (typeof patchYaml !== 'string' || patchYaml.trim().length === 0) throw new Error('patchYaml must be a non-empty string');
  mkdirSync(profileDir, { recursive: true });
  const file = join(profileDir, 'cordis.patch.yml');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = existing.trim().length === 0 ? patchYaml.trimEnd() + '\n' : existing.replace(/\n*$/, '\n') + patchYaml.trimEnd() + '\n';
  writeFileSync(file, next);
  return file;
}

/** Pull cookie pairs out of a fetch response (303 from the token handshake). */
function cookiesOf(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  const pairs = [];
  for (const line of raw) {
    const pair = String(line).split(';')[0].trim();
    if (pair.includes('=')) pairs.push(pair);
  }
  return pairs.join('; ');
}

/**
 * @param {{pluginDir?: string, homeDir?: string, profile?: string, patchYaml?: string, keepHome?: boolean, bootTimeoutMs?: number, seams?: boolean, prepareData?: (homeDir: string) => void}} [options]
 */
export async function startHost(options = {}) {
  if (!isDshAvailable()) throw new Error('DSH host is not available: ' + DSH_CLI + ' / ' + DSH_APP_BIN);
  const pluginDir = resolve(options.pluginDir || PLUGIN_ROOT);
  const profile = options.profile || 'it';
  const homeDir = options.homeDir || mkdtempSync(join(tmpdir(), 'wb-it-'));
  const logPath = join(homeDir, 'host.log');
  const env = { ...process.env, DSH_HOME: homeDir };
  delete env.DSH_PROFILE;
  delete env.DSH_PROFILE_DIR;
  if (options.seams === true) env.WORKBENCH_TEST_SEAMS = '1';
  else delete env.WORKBENCH_TEST_SEAMS;
  writeFileSync(logPath, '');

  // 1) profile from the shipped web template (base + web-app: workspace/controllers/UI)
  runCli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env);
  const profileDir = join(homeDir, 'profiles', profile);

  // 2) install the plugin the way a user would (offline, file: copy)
  runCli(['plugin', '--profile', profile, 'add', '--offline', 'file:' + pluginDir], env);

  // 3) optional profile patch layer (authMode / plugin config overrides)
  if (options.patchYaml) installView(profileDir, options.patchYaml);

  // 3b) optional data seeding: lets a test craft a corrupt / too-new document
  // (or any fixture) before the plugin ever loads it.
  if (typeof options.prepareData === 'function') options.prepareData(homeDir);

  // 4) boot the web host on an ephemeral port
  const child = spawn(DSH_CLI, ['--profile', profile, '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => {
    const text = chunk.toString();
    output += text;
    try { writeFileSync(logPath, text, { flag: 'a' }); } catch {}
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exited = false;
  let exitInfo = '';
  child.on('exit', (code, signal) => { exited = true; exitInfo = 'exit code=' + code + ' signal=' + signal; });

  let stopRequested = false;
  const stop = async () => {
    if (stopRequested) return;
    stopRequested = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(100);
    try { if (!exited) child.kill('SIGKILL'); } catch {}
    if (!options.keepHome) { try { rmSync(homeDir, { recursive: true, force: true }); } catch {} }
  };

  // 5) wait for the boot line that carries the real port + token
  const bootTimeoutMs = options.bootTimeoutMs || 60_000;
  const deadline = Date.now() + bootTimeoutMs;
  let tokenUrl = '';
  while (Date.now() < deadline) {
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/[^\s]*token=[^\s]+/);
    if (match) { tokenUrl = match[0]; break; }
    if (exited) break;
    await sleep(400);
  }
  if (!tokenUrl) {
    await stop();
    throw new Error('host did not print a web URL (' + exitInfo + ')\n--- host log tail ---\n' + tail(output || readFileSync(logPath, 'utf8')));
  }

  const base = tokenUrl.split('?')[0].replace(/\/+$/, '');

  // 6) token handshake: 303 + set-cookie, same as a browser opening the page
  let cookieHeader = '';
  for (let attempt = 0; attempt < 4 && !cookieHeader; attempt += 1) {
    try {
      const response = await fetch(tokenUrl, { redirect: 'manual' });
      cookieHeader = cookiesOf(response);
      if (!cookieHeader) await sleep(250);
    } catch (error) {
      if (attempt === 3) {
        await stop();
        throw new Error('token handshake failed: ' + String(error) + '\n--- host log tail ---\n' + tail(output));
      }
      await sleep(250);
    }
  }

  /** fetch against the plugin API; same-origin headers by default. */
  const apiFetch = async (path, init = {}) => {
    const headers = { accept: 'application/json', ...(init.headers || {}) };
    if (init.body !== undefined) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      headers.origin = headers.origin || base;
      headers['sec-fetch-site'] = headers['sec-fetch-site'] || 'same-origin';
    }
    if (cookieHeader && !headers.cookie) headers.cookie = cookieHeader;
    return fetch(base + path, { ...init, headers });
  };

  /** GET a JSON route and return {status, body}. */
  const get = async (path) => {
    const response = await apiFetch(path);
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { parseError: true, text }; }
    return { status: response.status, body };
  };

  let requestSeq = 0;
  /** POST one command; returns {status, body}. */
  const command = async (type, payload = {}, extra = {}) => {
    requestSeq += 1;
    const body = JSON.stringify({
      type,
      clientRequestId: 'c_it_' + process.pid + '_' + requestSeq,
      payload,
      ...extra,
    });
    const response = await apiFetch('/workbench/api/command', { method: 'POST', body });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { parseError: true, text }; }
    return { status: response.status, body: parsed };
  };

  return {
    base,
    /** Alias kept for readability in tests: the origin the fixture talks to. */
    url: base,
    tokenUrl,
    cookieHeader,
    env,
    profile,
    profileDir,
    homeDir,
    logPath,
    /** Path of the plugin's single JSON document. */
    dataFile: join(homeDir, 'workbench', 'workbench.json'),
    /** Directory that holds the document (chmod / permission tests). */
    dataDir: join(homeDir, 'workbench'),
    /** Sibling lock file the store uses (I-LOCK-01). */
    lockFile: join(homeDir, 'workbench', 'workbench.json.lock'),
    /** True when the test seams env switch was injected. */
    seams: options.seams === true,
    apiFetch,
    get,
    command,
    logs: () => output,
    stop,
    /** Raw PID, for kill -9 style reconciliation tests. */
    get pid() { return child.pid; },
    /** SIGKILL the host without cleanup (restart/reconcile tests). */
    sigkill() { try { child.kill('SIGKILL'); } catch {} },
  };
}