import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, SchemaTooNewError } from '../../host/store/repository.js';
import { SCHEMA_VERSION } from '../../host/store/document.js';

const freshFile = () => join(mkdtempSync(join(tmpdir(), 'wb-repo-')), 'workbench.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('first load creates the document file with schemaVersion 1', () => {
  const file = freshFile();
  const repo = createRepository({ file });
  repo.load();
  assert.ok(existsSync(file));
  const doc = readJson(file);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(doc.projects, []);
  assert.equal(typeof doc.meta.nextIssueNo, 'number');
});

test('mutate persists data and a second repository reads it back', () => {
  const file = freshFile();
  const first = createRepository({ file });
  first.load();
  first.mutate((doc) => { doc.projects.push({ projectId: 'p1', name: 'Demo', createdAt: 'now' }); });
  assert.equal(readJson(file).projects[0].name, 'Demo');
  const second = createRepository({ file });
  second.load();
  assert.equal(second.document.projects[0].name, 'Demo');
});

test('a throwing mutator changes neither disk nor rev', () => {
  const file = freshFile();
  const repo = createRepository({ file });
  repo.load();
  repo.mutate((doc) => { doc.projects.push({ projectId: 'p1', name: 'Keep', createdAt: 'now' }); });
  const before = readFileSync(file, 'utf8');
  const rev = repo.rev;
  assert.throws(() => repo.mutate((doc) => { doc.projects[0].name = 'Changed'; throw new Error('nope'); }), /nope/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(repo.rev, rev);
});

test('invalid JSON is quarantined and a fresh document starts', () => {
  const file = freshFile();
  writeFileSync(file, '{not json');
  const repo = createRepository({ file });
  repo.load();
  const corrupt = readdirSync(join(file, '..')).filter((name) => name.includes('.corrupt-'));
  assert.equal(corrupt.length, 1);
  assert.equal(readJson(file).schemaVersion, SCHEMA_VERSION);
  assert.ok(repo.corruptPath && existsSync(repo.corruptPath));
});

test('a newer schemaVersion refuses to load', () => {
  const file = freshFile();
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, meta: { createdAt: 'x', updatedAt: 'x', nextIssueNo: 1, nextActivitySeq: 1 }, projects: [], issues: [], units: [], decisions: [] }));
  const repo = createRepository({ file });
  assert.throws(() => repo.load(), (error) => error instanceof SchemaTooNewError && error.code === 'E_SCHEMA_TOO_NEW');
});

test('refresh adopts a newer document written by another process', () => {
  const file = freshFile();
  const repo = createRepository({ file });
  repo.load();
  const current = readJson(file);
  current.projects.push({ projectId: 'external', name: 'From other process' });
  writeFileSync(file, JSON.stringify(current));
  repo.refresh();
  assert.equal(repo.document.projects[0].projectId, 'external');
});

test('activities are capped per issue on write', () => {
  const file = freshFile();
  const repo = createRepository({ file });
  repo.load();
  repo.mutate((doc) => {
    doc.issues.push({ issueId: 'WB-1', isTriaged: false, title: 't', activities: Array.from({ length: 520 }, (_, index) => ({ seq: index, at: 'x', actor: 'human', type: 'a', text: 't' })) });
  });
  assert.equal(readJson(file).issues[0].activities.length, 500);
  assert.equal(readJson(file).issues[0].activities[0].seq, 20);
});
