/**
 * Tests for the doctor Plugin section (PE1-F1 / #145).
 *
 * Exercises the real `checkPlugin` against the shipped package assets, plus the
 * full `doctor --json` document to confirm the Plugin section is wired in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const doctorMod = await import('../../src/commands/doctor.js');
const doctor = doctorMod.default;
const { checkPlugin } = doctorMod;

function byId(checks) {
  return Object.fromEntries(checks.map((c) => [c.id, c]));
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
    try {
      await doctor(['--json', '--offline'], { cwd: process.cwd() });
    } finally {
      console.log = origLog;
    }
    const report = JSON.parse(logs.join('\n'));
    const plugin = report.sections.find((s) => s.name === 'Plugin');
    assert.ok(plugin, 'Plugin section present');
    assert.ok(plugin.checks.some((c) => c.id === 'plugin.manifest'));
    assert.ok(plugin.checks.some((c) => c.id === 'plugin.scope'));
  });
});
