import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { isTemplateRepo, hasSubmodule } = await import('../../src/lib/detect-repo.js');

describe('isTemplateRepo', () => {
  it('returns true for kbexplorer package name', () => {
    const dir = join(tmpdir(), `kbe-test-detect-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"kbexplorer"}');
    assert.strictEqual(isTemplateRepo(dir), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true for kbexplorer-template name', () => {
    const dir = join(tmpdir(), `kbe-test-detect2-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"kbexplorer-template"}');
    assert.strictEqual(isTemplateRepo(dir), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for other repos', () => {
    const dir = join(tmpdir(), `kbe-test-detect3-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"my-project"}');
    assert.strictEqual(isTemplateRepo(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no package.json', () => {
    const dir = join(tmpdir(), `kbe-test-detect4-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(isTemplateRepo(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('hasSubmodule', () => {
  it('returns false when no .kbexplorer dir', () => {
    const dir = join(tmpdir(), `kbe-test-sub-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(hasSubmodule(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });
});
