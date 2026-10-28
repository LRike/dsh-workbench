/**
 * Cross-process write lock for the single JSON document.
 *
 * A lock is a sibling file created with 'wx'. Its content records the holder
 * pid, acquisition time and a random token. A holder that stops refreshing
 * (a crashed process) is taken over after staleMs; a holder whose pid is known
 * to be gone is taken over immediately. Release is token-checked, so a process
 * that lost the lock to a takeover cannot delete the new holder's lock file.
 */
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Raised when the lock cannot be acquired within the wait budget. */
export class LockTimeoutError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'E_LOCK_TIMEOUT';
    this.details = details;
  }
}

const sleepSync = (ms) => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
};

const readHolder = (path) => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch { return undefined; }
};

/**
 * Age of the lock file itself. A lock created but not yet filled (the tiny
 * window between open('wx') and write) must never be treated as stale, so an
 * unreadable or empty holder is aged by mtime instead of a zero timestamp.
 */
const lockAgeMs = (path, now) => {
  try { return now - statSync(path).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
};

const holderIsGone = (pid) => {
  if (typeof pid !== 'number' || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
};

/**
 * Acquire the lock at lockPath, waiting up to waitMs.
 * @param {string} lockPath
 * @param {{waitMs?: number, staleMs?: number, pollMs?: number, now?: () => number}} [options]
 * @returns {{path: string, token: string, release: () => void, refresh: () => void}}
 */
export function acquireLockSync(lockPath, options = {}) {
  const waitMs = options.waitMs === undefined ? 3000 : options.waitMs;
  const staleMs = options.staleMs === undefined ? 10000 : options.staleMs;
  const pollMs = options.pollMs === undefined ? 20 : options.pollMs;
  const now = options.now === undefined ? Date.now : options.now;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now() + waitMs;
  const token = randomBytes(8).toString('hex');

  for (;;) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: now(), token }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const path = lockPath;
      let released = false;
      return {
        path,
        token,
        refresh() {
          const holder = readHolder(path);
          if (!holder || holder.token !== token) return;
          try {
            const f = openSync(path, 'w', 0o600);
            writeSync(f, JSON.stringify({ pid: process.pid, ts: now(), token }));
            fsyncSync(f);
            closeSync(f);
          } catch {}
        },
        release() {
          if (released) return;
          released = true;
          const holder = readHolder(path);
          // An unreadable/partial lock is left to the stale-timeout takeover: deleting
          // it here could remove a competitor's brand-new lock.
          if (!holder) return;
          if (holder.token !== token) return;
          try { unlinkSync(path); } catch {}
        },
      };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const holder = readHolder(lockPath);
    const parsedTs = holder && typeof holder.ts === 'number' ? holder.ts : undefined;
    // An unparsable/partial lock is aged by its mtime: it is never "stale at 0".
    const ageMs = parsedTs === undefined ? lockAgeMs(lockPath, now()) : now() - parsedTs;
    if (holderIsGone(holder && holder.pid) || ageMs > staleMs) {
      try { unlinkSync(lockPath); } catch {}
      continue;
    }
    if (now() >= deadline) {
      throw new LockTimeoutError('workbench document is locked by another process', {
        lockPath, holderPid: holder && holder.pid, retryAfterMs: pollMs,
      });
    }
    sleepSync(pollMs);
  }
}

/** Acquire, run, release. */
export function withLockSync(lockPath, fn, options) {
  const lock = acquireLockSync(lockPath, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}
