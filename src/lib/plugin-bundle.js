/**
 * kbx plugin bundle — manifest schema, bundle layout, scope resolution, and the
 * gist-share descriptor.
 *
 * The plugin packages kbx as a single installable GitHub Copilot plugin that
 * aggregates, over one engine:
 *   - the kbx command surface  (commands/)
 *   - the kb-* agents          (agents/)
 *   - the kbx skill            (skills/kbx/)
 *   - the kbexplorer canvas extension (extensions/)
 *
 * Canonical on-disk layout (grounded on the microsoft/skills plugin convention):
 *
 *   <plugin-root>/
 *     .claude-plugin/plugin.json   ← manifest (required)
 *     copilot-extension.json       ← gist-share descriptor (required to share)
 *     agents/  commands/  skills/kbx/  extensions/
 *
 * The component directories have a single source of truth inside this package
 * (src/assets/*). `resolveBundle()` reports where each component comes from and
 * whether it exists; `assembleBundle()` materializes the bundle at an install
 * root for one of the three scopes; `doctor` consumes `resolveBundle()`.
 *
 * This module is pure layout + validation: it contains no graph, provider, or
 * engine logic.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolvePackageAssetsDir } from './assets.js';

/** Canonical plugin name. */
export const PLUGIN_NAME = 'kbx';

/** Manifest location inside the bundle (Copilot/Claude plugin convention). */
export const PLUGIN_MANIFEST_DIR = '.claude-plugin';
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_MANIFEST_PATH = `${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE}`;

/** Gist-share descriptor — required for `kbx plugin share`. */
export const EXTENSION_DESCRIPTOR_FILE = 'copilot-extension.json';

/** Install scopes. */
export const SCOPES = Object.freeze(['project', 'user', 'session']);

/** Absolute path to the authored bundle template shipped with this package. */
export function authoredBundleRoot(assetsRoot) {
  const root = assetsRoot ?? resolvePackageAssetsDir(import.meta.url);
  return resolve(root, 'plugin', PLUGIN_NAME);
}

/** Absolute path to the package asset root (src/assets). */
function defaultAssetsRoot() {
  return resolvePackageAssetsDir(import.meta.url);
}

/**
 * Bundle components. `from` is the canonical source (relative to src/assets),
 * `to` is the destination path inside the bundle root. Directory components
 * carry `kind: 'dir'`, single files `kind: 'file'`.
 */
export const BUNDLE_COMPONENTS = Object.freeze([
  {
    id: 'manifest',
    label: 'plugin manifest',
    kind: 'file',
    from: join('plugin', PLUGIN_NAME, PLUGIN_MANIFEST_PATH),
    to: PLUGIN_MANIFEST_PATH,
    required: true,
  },
  {
    id: 'extension-descriptor',
    label: 'gist-share descriptor',
    kind: 'file',
    from: join('plugin', PLUGIN_NAME, EXTENSION_DESCRIPTOR_FILE),
    to: EXTENSION_DESCRIPTOR_FILE,
    required: true,
  },
  {
    id: 'readme',
    label: 'bundle README',
    kind: 'file',
    from: join('plugin', PLUGIN_NAME, 'README.md'),
    to: 'README.md',
    required: false,
  },
  {
    id: 'agents',
    label: 'agents',
    kind: 'dir',
    from: 'agents',
    to: 'agents',
    required: true,
  },
  {
    id: 'skill',
    label: 'kbx skill',
    kind: 'dir',
    from: join('skills', PLUGIN_NAME),
    to: join('skills', PLUGIN_NAME),
    required: true,
  },
  {
    id: 'commands',
    label: 'command surface',
    kind: 'dir',
    from: 'commands',
    to: 'commands',
    required: true,
  },
  {
    id: 'extension',
    label: 'canvas extension',
    kind: 'dir',
    from: 'extensions',
    to: 'extensions',
    required: false,
    pending: 'anokye-labs/kbexplorer-template#428',
  },
]);

// ── Scope resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the install root for a scope.
 *   project → <cwd>/.github/plugins/kbx
 *   user    → <home>/.copilot/plugins/kbx
 *   session → <sessionDir>/plugins/kbx
 */
export function resolveScopeRoot(scope, { cwd, home, sessionDir } = {}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`Unknown plugin scope "${scope}". Expected one of: ${SCOPES.join(', ')}`);
  }
  const baseCwd = cwd ?? process.cwd();
  switch (scope) {
    case 'project':
      return resolve(baseCwd, '.github', 'plugins', PLUGIN_NAME);
    case 'user':
      return resolve(home ?? homedir(), '.copilot', 'plugins', PLUGIN_NAME);
    case 'session': {
      const dir = sessionDir ?? process.env.COPILOT_SESSION_STATE_DIR;
      if (!dir) {
        throw new Error(
          'session scope requires a session directory (pass sessionDir or set COPILOT_SESSION_STATE_DIR)'
        );
      }
      return resolve(dir, 'plugins', PLUGIN_NAME);
    }
    default:
      throw new Error(`Unhandled scope "${scope}"`);
  }
}

// ── Manifest + descriptor validation ───────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/** Validate a parsed plugin manifest object. Returns { valid, errors }. */
export function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest is not a JSON object'] };
  }
  for (const field of ['name', 'description', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`missing or empty required field: ${field}`);
    }
  }
  if (typeof manifest.name === 'string' && manifest.name !== PLUGIN_NAME) {
    errors.push(`manifest name "${manifest.name}" must be "${PLUGIN_NAME}"`);
  }
  if (typeof manifest.version === 'string' && !SEMVER_RE.test(manifest.version)) {
    errors.push(`version "${manifest.version}" is not valid semver`);
  }
  return { valid: errors.length === 0, errors };
}

/** Validate a parsed gist-share descriptor object. Returns { valid, errors }. */
export function validateExtensionDescriptor(descriptor) {
  const errors = [];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { valid: false, errors: ['descriptor is not a JSON object'] };
  }
  for (const field of ['name', 'version', 'type']) {
    if (typeof descriptor[field] !== 'string' || descriptor[field].trim() === '') {
      errors.push(`missing or empty required field: ${field}`);
    }
  }
  if (typeof descriptor.name === 'string' && descriptor.name !== PLUGIN_NAME) {
    errors.push(`descriptor name "${descriptor.name}" must be "${PLUGIN_NAME}"`);
  }
  if (typeof descriptor.version === 'string' && !SEMVER_RE.test(descriptor.version)) {
    errors.push(`version "${descriptor.version}" is not valid semver`);
  }
  return { valid: errors.length === 0, errors };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Read + parse the authored manifest. Returns { path, manifest, error }. */
export function loadPluginManifest(assetsRoot) {
  const path = resolve(authoredBundleRoot(assetsRoot), PLUGIN_MANIFEST_PATH);
  if (!existsSync(path)) return { path, manifest: null, error: 'not found' };
  try {
    return { path, manifest: readJson(path), error: null };
  } catch (err) {
    return { path, manifest: null, error: err.message };
  }
}

/** Read + parse the authored gist-share descriptor. Returns { path, descriptor, error }. */
export function loadExtensionDescriptor(assetsRoot) {
  const path = resolve(authoredBundleRoot(assetsRoot), EXTENSION_DESCRIPTOR_FILE);
  if (!existsSync(path)) return { path, descriptor: null, error: 'not found' };
  try {
    return { path, descriptor: readJson(path), error: null };
  } catch (err) {
    return { path, descriptor: null, error: err.message };
  }
}

// ── Bundle resolution ───────────────────────────────────────────────────────────

function isNonEmptyDir(p) {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve every bundle component against the package asset sources.
 * Returns { ok, components: [{ id, label, kind, required, pending, source, exists }] }.
 * `ok` is true when every required component exists.
 */
export function resolveBundle({ assetsRoot } = {}) {
  const root = assetsRoot ?? defaultAssetsRoot();
  const components = BUNDLE_COMPONENTS.map((c) => {
    const source = resolve(root, c.from);
    const exists = c.kind === 'dir' ? isNonEmptyDir(source) : existsSync(source);
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      required: c.required,
      pending: c.pending ?? null,
      source,
      exists,
    };
  });
  const ok = components.every((c) => !c.required || c.exists);
  return { ok, components };
}

// ── Assembly (install) ──────────────────────────────────────────────────────────

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/**
 * Materialize the bundle at `destRoot` by copying each resolvable component from
 * its canonical source. Skips missing optional components. Returns
 * { installed: [...ids], skipped: [{ id, reason }] }.
 *
 * Throws if a required component is missing from the package.
 */
export function assembleBundle(destRoot, { assetsRoot } = {}) {
  const root = assetsRoot ?? defaultAssetsRoot();
  const installed = [];
  const skipped = [];
  for (const c of BUNDLE_COMPONENTS) {
    const source = resolve(root, c.from);
    const exists = c.kind === 'dir' ? isNonEmptyDir(source) : existsSync(source);
    if (!exists) {
      if (c.required) {
        throw new Error(`required component "${c.id}" not found at ${source}`);
      }
      skipped.push({ id: c.id, reason: c.pending ? `pending ${c.pending}` : 'not present' });
      continue;
    }
    const dest = resolve(destRoot, c.to);
    if (c.kind === 'dir') {
      copyDir(source, dest);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
    installed.push(c.id);
  }
  return { installed, skipped };
}

/**
 * Build the payload that `kbx plugin share` prints/validates for gist sharing.
 * A gist share requires a valid manifest AND a valid copilot-extension.json.
 * Returns { ok, errors, descriptor, manifest }.
 */
export function gistShareManifest({ assetsRoot } = {}) {
  const errors = [];
  const { manifest, error: mErr } = loadPluginManifest(assetsRoot);
  if (mErr) errors.push(`manifest: ${mErr}`);
  else {
    const v = validatePluginManifest(manifest);
    if (!v.valid) errors.push(...v.errors.map((e) => `manifest: ${e}`));
  }
  const { descriptor, error: dErr } = loadExtensionDescriptor(assetsRoot);
  if (dErr) errors.push(`${EXTENSION_DESCRIPTOR_FILE}: ${dErr}`);
  else {
    const v = validateExtensionDescriptor(descriptor);
    if (!v.valid) errors.push(...v.errors.map((e) => `${EXTENSION_DESCRIPTOR_FILE}: ${e}`));
  }
  return { ok: errors.length === 0, errors, descriptor, manifest };
}
