import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { classifyRef, readSourceRecord, writeSourceRecord, SOURCE_FILE } =
  await import('../../src/lib/source.ts');

function tmp(label) {
  const dir = join(tmpdir(), `kbe-src-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('classifyRef', () => {
  it('treats no ref as release', () => {
    assert.strictEqual(classifyRef(null), 'release');
    assert.strictEqual(classifyRef(undefined), 'release');
    assert.strictEqual(classifyRef(''), 'release');
  });

  it('treats semver-like refs as pinned tags', () => {
    assert.strictEqual(classifyRef('v1.2.3'), 'tag');
    assert.strictEqual(classifyRef('1.2.3'), 'tag');
  });

  it('treats everything else as a branch', () => {
    assert.strictEqual(classifyRef('main'), 'branch');
    assert.strictEqual(classifyRef('feature/foo'), 'branch');
    assert.strictEqual(classifyRef('release-candidate'), 'branch');
  });
});

describe('source record round-trip', () => {
  it('writes and reads back a record', () => {
    const dir = tmp('rt');
    const record = {
      template: 'https://github.com/x/y.git',
      ref: 'v1.0.0',
      refType: 'tag',
      resolvedCommit: 'a'.repeat(40),
      mode: 'vendor',
    };
    const file = writeSourceRecord(dir, record);
    assert.ok(file.endsWith(SOURCE_FILE));
    assert.deepStrictEqual(readSourceRecord(dir), record);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no record exists', () => {
    const dir = tmp('missing');
    assert.strictEqual(readSourceRecord(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a corrupt record', () => {
    const dir = tmp('corrupt');
    writeFileSync(join(dir, SOURCE_FILE), '{ not json');
    assert.strictEqual(readSourceRecord(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
