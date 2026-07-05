import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { isTemplateRepo, hasSubmodule, hasTemplate, isSubmoduleInstall, getSubmoduleUrl } = await import('../../src/lib/detect-repo.ts');

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

describe('hasTemplate / isSubmoduleInstall', () => {
  it('hasTemplate mirrors hasSubmodule (present when package.json exists)', () => {
    const dir = join(tmpdir(), `kbe-test-tmpl-${Date.now()}`);
    mkdirSync(join(dir, '.kbx'), { recursive: true });
    writeFileSync(join(dir, '.kbx', 'package.json'), '{"name":"kbx"}');
    assert.strictEqual(hasTemplate(dir), true);
    // vendored copy has no inner .git
    assert.strictEqual(isSubmoduleInstall(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('isSubmoduleInstall is true when .kbx/.git exists', () => {
    const dir = join(tmpdir(), `kbe-test-sm-${Date.now()}`);
    mkdirSync(join(dir, '.kbx'), { recursive: true });
    writeFileSync(join(dir, '.kbx', 'package.json'), '{"name":"kbx"}');
    writeFileSync(join(dir, '.kbx', '.git'), 'gitdir: ../.git/modules/.kbexplorer');
    assert.strictEqual(isSubmoduleInstall(dir), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('getSubmoduleUrl', () => {
  it('returns null when no .gitmodules', () => {
    const dir = join(tmpdir(), `kbe-test-gm0-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(getSubmoduleUrl(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the .kbx submodule url', () => {
    const dir = join(tmpdir(), `kbe-test-gm1-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.gitmodules'),
      '[submodule ".kbx"]\n\tpath = .kbx\n\turl = https://github.com/my-org/my-template.git\n',
    );
    assert.strictEqual(getSubmoduleUrl(dir), 'https://github.com/my-org/my-template.git');
    rmSync(dir, { recursive: true, force: true });
  });
});

