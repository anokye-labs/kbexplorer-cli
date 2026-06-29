import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI = resolve(ROOT, 'bin', 'cli.js');
const FIXTURES = resolve(ROOT, 'tests', 'fixtures', 'content-model');

function runValidate(args) {
  return spawnSync(process.execPath, [CLI, 'validate', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
}

describe('validate command (end-to-end CLI exit codes)', () => {
  it('exits 0 on the clean fixture tree', () => {
    const r = runValidate(['--content-model', resolve(FIXTURES, 'clean')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Content model is valid/);
  });

  it('exits 1 on the broken fixture tree', () => {
    const r = runValidate(['--content-model', resolve(FIXTURES, 'broken')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /broken-ref/);
  });

  it('emits machine-readable JSON with findings and exits 1', () => {
    const r = runValidate(['--content-model', resolve(FIXTURES, 'broken'), '--json']);
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.summary.errors > 0);
    assert.ok(Array.isArray(parsed.findings));
    const rules = new Set(parsed.findings.map((f) => f.rule));
    assert.ok(rules.has('broken-ref'));
    assert.ok(rules.has('duplicate-id'));
  });

  it('emits clean JSON with zero errors and exits 0', () => {
    const r = runValidate(['--content-model', resolve(FIXTURES, 'clean'), '--json']);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.summary.errors, 0);
    assert.equal(parsed.findings.length, 0);
  });

  it('exits 0 when the content-model directory is absent', () => {
    const r = runValidate(['--content-model', resolve(FIXTURES, 'nope-missing')]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to validate/i);
  });

  it('prints help with --help', () => {
    const r = runValidate(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /kbx validate/);
  });
});

