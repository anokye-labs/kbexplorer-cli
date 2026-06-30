/**
 * Tests for the `kbx plugin` command (PE1-F1 / #145).
 *
 * Argument parsing is unit-tested directly; install/share/resolve are exercised
 * against the shipped package assets with console + process.exitCode captured.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginMod = await import('../../src/commands/plugin.js');
const plugin = pluginMod.default;
const { parsePluginArgs } = pluginMod;

function capture() {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  return {
    out,
    err,
    restore() {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = origExit;
    },
  };
}

describe('parsePluginArgs', () => {
  it('defaults to project scope and no subcommand', () => {
    const o = parsePluginArgs([]);
    assert.equal(o.sub, null);
    assert.equal(o.scope, 'project');
  });

  it('parses subcommand and scope flags', () => {
    const o = parsePluginArgs(['install', '--scope', 'user', '--json']);
    assert.equal(o.sub, 'install');
    assert.equal(o.scope, 'user');
    assert.equal(o.json, true);
  });

  it('supports --scope=value and --session-dir=value forms', () => {
    const o = parsePluginArgs(['install', '--scope=session', '--session-dir=/s']);
    assert.equal(o.scope, 'session');
    assert.equal(o.sessionDir, '/s');
  });
});

describe('kbx plugin resolve', () => {
  it('reports components as JSON without failing for the shipped bundle', async () => {
    const cap = capture();
    try {
      await plugin(['resolve', '--json']);
    } finally {
      cap.restore();
    }
    const doc = JSON.parse(cap.out.join('\n'));
    assert.equal(doc.ok, true);
    assert.ok(doc.components.some((c) => c.id === 'agents' && c.exists));
  });
});

describe('kbx plugin share', () => {
  it('prints a valid gist-share descriptor', async () => {
    const cap = capture();
    try {
      await plugin(['share', '--json']);
    } finally {
      cap.restore();
    }
    const doc = JSON.parse(cap.out.join('\n'));
    assert.equal(doc.ok, true);
    assert.equal(doc.descriptor.name, 'kbx');
    assert.notEqual(process.exitCode, 1);
  });
});

describe('kbx plugin install', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbx-plugin-cmd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('installs at session scope into the given directory', async () => {
    const cap = capture();
    try {
      await plugin(['install', '--scope', 'session', '--session-dir', dir, '--json']);
    } finally {
      cap.restore();
    }
    const doc = JSON.parse(cap.out.join('\n'));
    assert.equal(doc.scope, 'session');
    assert.ok(doc.installed.includes('manifest'));
    assert.ok(doc.installed.includes('agents'));
    assert.ok(existsSync(join(dir, 'plugins', 'kbx', '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(dir, 'plugins', 'kbx', 'skills', 'kbx', 'SKILL.md')));
  });

  it('rejects an unknown scope with a non-zero exit code', async () => {
    const cap = capture();
    try {
      await plugin(['install', '--scope', 'global']);
    } finally {
      const exit = process.exitCode;
      cap.restore();
      assert.equal(exit, 1);
    }
    assert.ok(cap.err.join('\n').includes('Unknown scope'));
  });

  it('errors when session scope lacks a directory', async () => {
    const saved = process.env.COPILOT_SESSION_STATE_DIR;
    delete process.env.COPILOT_SESSION_STATE_DIR;
    const cap = capture();
    try {
      await plugin(['install', '--scope', 'session'], { env: {} });
    } finally {
      const exit = process.exitCode;
      cap.restore();
      if (saved !== undefined) process.env.COPILOT_SESSION_STATE_DIR = saved;
      assert.equal(exit, 1);
    }
  });
});

describe('kbx plugin (no subcommand)', () => {
  it('prints usage', async () => {
    const cap = capture();
    try {
      await plugin([]);
    } finally {
      cap.restore();
    }
    assert.ok(cap.out.join('\n').includes('kbx plugin'));
  });
});
