import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI = resolve(ROOT, 'bin', 'kbx.js');
const FIXTURE_ROOT = resolve(ROOT, 'tests', 'fixtures', 'kb-explore');
const EXPECTED_SHOW = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, 'explore-show.expected.json'), 'utf8'));

function ensureBuild() {
  const distCli = resolve(ROOT, 'dist', 'cli.js');
  if (existsSync(distCli)) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function runExplore(args = []) {
  ensureBuild();
  return spawnSync(process.execPath, [CLI, 'explore', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function normalizeShow(payload) {
  return {
    command: payload.command,
    node: {
      id: payload.node.id,
      title: payload.node.title,
      cluster: payload.node.cluster,
    },
    neighbors: payload.neighbors
      .map(({ id, title, cluster }) => ({ id, title, cluster }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    related: payload.related
      .map(({ id, title, cluster }) => ({ id, title, cluster }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('explore command (end-to-end fixture CLI)', () => {
  it('loads the fixture KB in non-interactive JSON mode', () => {
    const result = runExplore([FIXTURE_ROOT, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.engine.name, '@anokye-labs/kbexplorer-engine');
    assert.equal(payload.command, 'ls');
    assert.equal(payload.currentNodeId, 'home');
    assert.ok(payload.clusters.some((cluster) => cluster.id === 'entry'));
    assert.ok(payload.types.some((type) => type.name === 'unknown'));
  });

  it('emits a stable JSON payload for show commands', () => {
    const result = runExplore([FIXTURE_ROOT, 'show', 'home', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(normalizeShow(payload), EXPECTED_SHOW);
  });
});
