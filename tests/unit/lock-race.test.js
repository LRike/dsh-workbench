import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLockSync, LockTimeoutError } from '../../host/store/lock.js';

const lockAt = () => join(mkdtempSync(join(tmpdir(), 'wb-lock2-')), 'doc.json.lock');

test('an empty (partially created) lock is respected until it ages out', () => {
  const path = lockAt();
  writeFileSync(path, '');
  assert.throws(() => acquireLockSync(path, { waitMs: 150, pollMs: 10 }), (error) => error instanceof LockTimeoutError);
  assert.ok(existsSync(path), 'a fresh empty lock must not be deleted');
});

test('an empty lock older than staleMs is taken over', () => {
  const path = lockAt();
  writeFileSync(path, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  const lock = acquireLockSync(path, { waitMs: 300, staleMs: 10_000 });
  assert.ok(existsSync(path));
  lock.release();
});
