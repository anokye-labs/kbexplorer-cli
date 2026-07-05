/**
 * Tests for the doctor Plugin section (PE1-F1 / #145).
 *
 * Exercises the real `checkPlugin` against the shipped package assets, plus the
 * full `doctor --json` document to confirm the Plugin section is wired in.
 *
 * The full-`doctor()` test stubs `spawnSync` (git/gh/copilot all "available")
 * and saves/restores `process.exitCode`, mirroring the hermetic pattern used
 * throughout tests/commands/doctor.test.js. Without the stub, this test's
 * result depends on whether the `copilot` binary happens to be on the host's
 * PATH: when it isn't, the real Runtime check fails, `doctor()` sets
 * `process.exitCode = 1`, and that leaks out as the whole test file's exit
 * code even though every assertion here passes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const doctorMod = await import('../../src/commands/doctor.ts');
const doctor = doctorMod.default;
const { checkPlugin } = doctorMod;

function byId(checks) {
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

/** spawnSync that simulates a binary being available, returning a version line. */
function fakeSpawnAvailable(binary, version = '1.0.0') {
  return (_cmd, _args, _opts) => ({
    status: 0,
    stdout: `${binary} version ${version}`,
    stderr: '',
    error: null,
  });
}

/** spawnSync that routes by binary name; unknown binaries report as missing. */
function fakeSpawnRouter(routes) {
  return (cmd, args, opts) => {
    const handler = routes[cmd];
    if (handler) return handler(cmd, args, opts);
    return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
  };
}

describe('checkPlugin', () => {
  it('passes manifest, gist-share, agents, skill, commands and scope against shipped assets', () => {
    const checks = checkPlugin({ cwd: '/repo' });
    const map = byId(checks);
    assert.equal(map['plugin.manifest'].status, 'pass');
    assert.equal(map['plugin.share'].status, 'pass');
    assert.equal(map['plugin.agents'].status, 'pass');
    assert.equal(map['plugin.skill'].status, 'pass');
    assert.equal(map['plugin.commands'].status, 'pass');
    assert.equal(map['plugin.scope'].status, 'pass');
    assert.match(map['plugin.scope'].message, /\.github[\\/]plugins[\\/]kbx/);
  });

  it('warns (not fails) on components still pending sibling issues', () => {
    const map = byId(checkPlugin({ cwd: '/repo' }));
    assert.equal(map['plugin.extension'].status, 'warn');
    assert.match(map['plugin.extension'].message, /#428/);
  });

  it('never fails for the shipped bundle (warnings only)', () => {
    const checks = checkPlugin({ cwd: '/repo' });
    assert.ok(!checks.some((c) => c.status === 'fail'));
  });
});

describe('doctor --json includes the Plugin section', () => {
  it('emits a Plugin section in the report', async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    const spawnSync = fakeSpawnRouter({
      git: fakeSpawnAvailable('git'),
      gh: fakeSpawnAvailable('gh'),
      copilot: fakeSpawnAvailable('copilot'),
    });
    const origExitCode = process.exitCode;
    try {
      await doctor(['--json', '--offline'], { cwd: process.cwd(), spawnSync });
    } finally {
      console.log = origLog;
      process.exitCode = origExitCode;
    }
    const report = JSON.parse(logs.join('\n'));
    const plugin = report.sections.find((s) => s.name === 'Plugin');
    assert.ok(plugin, 'Plugin section present');
    assert.ok(plugin.checks.some((c) => c.id === 'plugin.manifest'));
    assert.ok(plugin.checks.some((c) => c.id === 'plugin.scope'));
  });
});
