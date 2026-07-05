/**
 * Tests for the kbx plugin bundle library (PE1-F1 / #145).
 *
 * Hermetic: a synthetic assets root is built in a temp dir so tests never
 * depend on the real shipped bundle, and scope resolution is driven entirely by
 * injected cwd/home/sessionDir.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const {
  PLUGIN_NAME,
  SCOPES,
  PLUGIN_MANIFEST_PATH,
  EXTENSION_DESCRIPTOR_FILE,
  resolveScopeRoot,
  validatePluginManifest,
  validateExtensionDescriptor,
  resolveBundle,
  assembleBundle,
  gistShareManifest,
  loadPluginManifest,
  loadExtensionDescriptor,
} = await import('../../src/lib/plugin-bundle.ts');

// ── Synthetic assets root ───────────────────────────────────────────────────────

function buildAssets(dir, { withExtension = false } = {}) {
  const bundle = join(dir, 'plugin', PLUGIN_NAME);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, PLUGIN_MANIFEST_PATH),
    JSON.stringify({ name: 'kbx', description: 'd', version: '0.1.0' })
  );
  writeFileSync(
    join(bundle, EXTENSION_DESCRIPTOR_FILE),
    JSON.stringify({ name: 'kbx', version: '0.1.0', type: 'plugin' })
  );
  writeFileSync(join(bundle, 'README.md'), '# kbx');

  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'kb-architect.md'), '---\nname: kb-architect\n---\n');

  mkdirSync(join(dir, 'skills', PLUGIN_NAME), { recursive: true });
  writeFileSync(join(dir, 'skills', PLUGIN_NAME, 'SKILL.md'), '---\nname: kbx\n---\n');

  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'audit.md'), '# audit');

  if (withExtension) {
    mkdirSync(join(dir, 'extensions'), { recursive: true });
    writeFileSync(join(dir, 'extensions', 'index.js'), '// canvas');
  }
  return dir;
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kbx-bundle-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── Scope resolution ─────────────────────────────────────────────────────────────

describe('resolveScopeRoot', () => {
  it('exposes exactly the three documented scopes', () => {
    assert.deepEqual([...SCOPES], ['project', 'user', 'session']);
  });

  it('resolves project scope under <cwd>/.github/plugins/kbx', () => {
    const root = resolveScopeRoot('project', { cwd: '/repo' });
    assert.equal(root, resolve('/repo', '.github', 'plugins', 'kbx'));
  });

  it('resolves user scope under <home>/.copilot/plugins/kbx', () => {
    const root = resolveScopeRoot('user', { home: '/home/me' });
    assert.equal(root, resolve('/home/me', '.copilot', 'plugins', 'kbx'));
  });

  it('resolves session scope under <sessionDir>/plugins/kbx', () => {
    const root = resolveScopeRoot('session', { sessionDir: '/s/state' });
    assert.equal(root, resolve('/s/state', 'plugins', 'kbx'));
  });

  it('throws on an unknown scope', () => {
    assert.throws(() => resolveScopeRoot('global', { cwd: '/r' }), /Unknown plugin scope/);
  });

  it('throws when session scope has no session directory', () => {
    const saved = process.env.COPILOT_SESSION_STATE_DIR;
    delete process.env.COPILOT_SESSION_STATE_DIR;
    try {
      assert.throws(() => resolveScopeRoot('session', {}), /session scope requires/);
    } finally {
      if (saved !== undefined) process.env.COPILOT_SESSION_STATE_DIR = saved;
    }
  });
});

// ── Manifest validation ──────────────────────────────────────────────────────────

describe('validatePluginManifest', () => {
  it('accepts a well-formed manifest', () => {
    const v = validatePluginManifest({ name: 'kbx', description: 'd', version: '1.2.3' });
    assert.equal(v.valid, true);
    assert.deepEqual(v.errors, []);
  });

  it('flags missing required fields', () => {
    const v = validatePluginManifest({ name: 'kbx' });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('description')));
    assert.ok(v.errors.some((e) => e.includes('version')));
  });

  it('rejects a wrong plugin name', () => {
    const v = validatePluginManifest({ name: 'other', description: 'd', version: '1.0.0' });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('must be "kbx"')));
  });

  it('rejects a non-semver version', () => {
    const v = validatePluginManifest({ name: 'kbx', description: 'd', version: 'v1' });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('semver')));
  });

  it('rejects non-objects', () => {
    assert.equal(validatePluginManifest(null).valid, false);
    assert.equal(validatePluginManifest([]).valid, false);
  });
});

// ── Descriptor validation ────────────────────────────────────────────────────────

describe('validateExtensionDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    const v = validateExtensionDescriptor({ name: 'kbx', version: '0.1.0', type: 'plugin' });
    assert.equal(v.valid, true);
  });

  it('requires name, version and type', () => {
    const v = validateExtensionDescriptor({ name: 'kbx' });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('version')));
    assert.ok(v.errors.some((e) => e.includes('type')));
  });
});

// ── Bundle resolution ────────────────────────────────────────────────────────────

describe('resolveBundle', () => {
  it('marks required components present and optional ones pending', () => {
    buildAssets(tmp);
    const { ok, components } = resolveBundle({ assetsRoot: tmp });
    assert.equal(ok, true);
    const byId = Object.fromEntries(components.map((c) => [c.id, c]));
    assert.equal(byId.agents.exists, true);
    assert.equal(byId.skill.exists, true);
    assert.equal(byId.commands.exists, true);
    assert.equal(byId.commands.required, true);
    assert.equal(byId.extension.exists, false);
    assert.ok(byId.extension.pending);
  });

  it('reports ok=false when a required component is missing', () => {
    buildAssets(tmp);
    rmSync(join(tmp, 'agents'), { recursive: true, force: true });
    const { ok, components } = resolveBundle({ assetsRoot: tmp });
    assert.equal(ok, false);
    assert.equal(components.find((c) => c.id === 'agents').exists, false);
  });

  it('treats an empty required dir as missing', () => {
    buildAssets(tmp);
    rmSync(join(tmp, 'agents'), { recursive: true, force: true });
    mkdirSync(join(tmp, 'agents'), { recursive: true });
    const { ok } = resolveBundle({ assetsRoot: tmp });
    assert.equal(ok, false);
  });
});

// ── Assembly ─────────────────────────────────────────────────────────────────────

describe('assembleBundle', () => {
  it('materializes the canonical layout and skips pending optionals', () => {
    buildAssets(tmp);
    const dest = join(tmp, 'out');
    const { installed, skipped } = assembleBundle(dest, { assetsRoot: tmp });

    assert.ok(installed.includes('manifest'));
    assert.ok(installed.includes('agents'));
    assert.ok(installed.includes('skill'));
    assert.ok(installed.includes('commands'));
    assert.ok(skipped.some((s) => s.id === 'extension'));

    assert.ok(existsSync(join(dest, PLUGIN_MANIFEST_PATH)));
    assert.ok(existsSync(join(dest, EXTENSION_DESCRIPTOR_FILE)));
    assert.ok(existsSync(join(dest, 'agents', 'kb-architect.md')));
    assert.ok(existsSync(join(dest, 'skills', 'kbx', 'SKILL.md')));
    assert.ok(existsSync(join(dest, 'commands', 'audit.md')));
  });

  it('includes optional components once present', () => {
    buildAssets(tmp, { withExtension: true });
    const dest = join(tmp, 'out');
    const { installed } = assembleBundle(dest, { assetsRoot: tmp });
    assert.ok(installed.includes('commands'));
    assert.ok(installed.includes('extension'));
    assert.ok(existsSync(join(dest, 'commands', 'audit.md')));
    assert.ok(existsSync(join(dest, 'extensions', 'index.js')));
  });

  it('throws when a required component is missing from the package', () => {
    buildAssets(tmp);
    rmSync(join(tmp, 'skills'), { recursive: true, force: true });
    assert.throws(
      () => assembleBundle(join(tmp, 'out'), { assetsRoot: tmp }),
      /required component "skill"/
    );
  });
});

// ── Gist share ───────────────────────────────────────────────────────────────────

describe('gistShareManifest', () => {
  it('is ok with a valid manifest and descriptor', () => {
    buildAssets(tmp);
    const res = gistShareManifest({ assetsRoot: tmp });
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
    assert.equal(res.descriptor.name, 'kbx');
  });

  it('fails when the descriptor is missing', () => {
    buildAssets(tmp);
    rmSync(join(tmp, 'plugin', PLUGIN_NAME, EXTENSION_DESCRIPTOR_FILE), { force: true });
    const res = gistShareManifest({ assetsRoot: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes(EXTENSION_DESCRIPTOR_FILE)));
  });

  it('fails when the manifest is invalid JSON', () => {
    buildAssets(tmp);
    writeFileSync(join(tmp, 'plugin', PLUGIN_NAME, PLUGIN_MANIFEST_PATH), '{ not json');
    const res = gistShareManifest({ assetsRoot: tmp });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.startsWith('manifest:')));
  });
});

// ── Loaders ──────────────────────────────────────────────────────────────────────

describe('loaders', () => {
  it('load the authored manifest and descriptor from an assets root', () => {
    buildAssets(tmp);
    const m = loadPluginManifest(tmp);
    assert.equal(m.error, null);
    assert.equal(m.manifest.name, 'kbx');
    const d = loadExtensionDescriptor(tmp);
    assert.equal(d.error, null);
    assert.equal(d.descriptor.type, 'plugin');
  });

  it('report not found cleanly', () => {
    const m = loadPluginManifest(tmp);
    assert.equal(m.manifest, null);
    assert.equal(m.error, 'not found');
  });
});

// ── Shipped bundle (integration with the real package assets) ────────────────────

describe('shipped kbx bundle', () => {
  it('has a valid manifest, descriptor, and all required components', () => {
    const { ok, components } = resolveBundle();
    const byId = Object.fromEntries(components.map((c) => [c.id, c]));
    assert.equal(byId.agents.exists, true);
    assert.equal(byId.skill.exists, true);
    assert.equal(ok, true);

    const m = loadPluginManifest();
    assert.equal(validatePluginManifest(m.manifest).valid, true);
    const d = loadExtensionDescriptor();
    assert.equal(validateExtensionDescriptor(d.descriptor).valid, true);
  });

  it('ships the three kb-* agents', () => {
    const { components } = resolveBundle();
    const agents = components.find((c) => c.id === 'agents');
    assert.ok(existsSync(join(agents.source, 'kb-architect.md')));
    assert.ok(existsSync(join(agents.source, 'kb-researcher.md')));
    assert.ok(existsSync(join(agents.source, 'kb-writer.md')));
  });
});
