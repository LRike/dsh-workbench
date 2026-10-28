import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync, readFileSyncIfExists, ensureDirSync } from '../../host/store/atomic-file.js';

const dir = () => mkdtempSync(join(tmpdir(), 'wb-atomic-'));

test('writes the complete content and leaves no temp file', () => {
  const d = dir();
  const file = join(d, 'doc.json');
  writeFileAtomicSync(file, '{"a":1}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  assert.deepEqual(readdirSync(d), ['doc.json']);
});

test('replaces existing content and keeps mode 0600 by default', () => {
  const d = dir();
  const file = join(d, 'doc.json');
  writeFileAtomicSync(file, 'old');
  writeFileAtomicSync(file, 'new-and-longer');
  assert.equal(readFileSync(file, 'utf8'), 'new-and-longer');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('creates missing parent directories', () => {
  const d = dir();
  const file = join(d, 'a', 'b', 'doc.json');
  writeFileAtomicSync(file, 'x');
  assert.equal(readFileSync(file, 'utf8'), 'x');
});

test('accepts Uint8Array content', () => {
  const d = dir();
  const file = join(d, 'bin');
  writeFileAtomicSync(file, new TextEncoder().encode('bytes'));
  assert.equal(readFileSync(file, 'utf8'), 'bytes');
});

test('a failing rename leaves the previous file intact', () => {
  const d = dir();
  const file = join(d, 'doc.json');
  writeFileAtomicSync(file, 'keep-me');
  const badTarget = join(d, 'dir-as-file');
  ensureDirSync(badTarget);
  assert.throws(() => writeFileAtomicSync(badTarget, 'nope'));
  assert.equal(readFileSync(file, 'utf8'), 'keep-me');
});

test('readFileSyncIfExists returns undefined for a missing file and text otherwise', () => {
  const d = dir();
  assert.equal(readFileSyncIfExists(join(d, 'missing.json')), undefined);
  writeFileSync(join(d, 'present.json'), 'ok');
  assert.equal(readFileSyncIfExists(join(d, 'present.json')), 'ok');
});
