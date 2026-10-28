import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLockSync, withLockSync, LockTimeoutError } from '../../host/store/lock.js';

const lockAt = () => join(mkdtempSync(join(tmpdir(), 'wb-lock-')), 'doc.json.lock');

test('acquire then release removes the lock file', () => {
  const path = lockAt();
  const lock = acquireLockSync(path);
  assert.ok(existsSync(path));
  lock.release();
  assert.equal(existsSync(path), false);
});

test('a held fresh lock makes a second acquire time out', () => {
  const path = lockAt();
  const lock = acquireLockSync(path);
  try {
    assert.throws(() => acquireLockSync(path, { waitMs: 120, pollMs: 10 }),
      (error) => error instanceof LockTimeoutError && error.details.lockPath === path);
  } finally { lock.release(); }
});

test('a stale lock is taken over', () => {
  const path = lockAt();
  writeFileSync(path, JSON.stringify({ pid: 999999, ts: Date.now() - 60000, token: 'old' }));
  const lock = acquireLockSync(path, { waitMs: 300 });
  assert.notEqual(lock.token, 'old');
  lock.release();
});

test('a lock whose pid is gone is taken over even when its timestamp is fresh', () => {
  const path = lockAt();
  writeFileSync(path, JSON.stringify({ pid: 999999, ts: Date.now(), token: 'dead' }));
  const lock = acquireLockSync(path, { waitMs: 300, staleMs: 60000 });
  assert.ok(existsSync(path));
  lock.release();
});

test('a former owner cannot delete a lock it no longer holds', () => {
  const path = lockAt();
  const first = acquireLockSync(path);
  writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'someone-else' }));
  first.release();
  assert.ok(existsSync(path), 'release must not remove a foreign lock');
});

test('withLockSync releases on success and on throw', () => {
  const path = lockAt();
  assert.equal(withLockSync(path, () => 42), 42);
  assert.equal(existsSync(path), false);
  assert.throws(() => withLockSync(path, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(path), false);
});
