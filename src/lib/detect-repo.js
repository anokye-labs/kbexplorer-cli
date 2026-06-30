/**
 * Repository detection utilities.
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveForgeRef, resolveRepositoryRef } from './forge-adapter.js';

/**
 * Read the `origin` remote URL from a git repo, or null when absent.
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null}
 */
function readOriginUrl(cwd = process.cwd()) {
  try {
    return execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null; // not a git repo or no remote
  }
}

/**
 * Detect the git remote owner/repo from the current directory.
 *
 * Resolution now flows through the host-neutral {@link resolveForgeRef} seam;
 * GitHub is the sole registered adapter, so the returned `{ owner, repo }` is
 * identical to the previous inline parsing.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {{ owner: string, repo: string }|null}
 */
export function detectGitRemote(cwd = process.cwd()) {
  const ref = resolveForgeRef(readOriginUrl(cwd));
  return ref ? { owner: ref.owner, repo: ref.repo } : null;
}

/**
 * Detect a host-neutral {@link RepositoryRef} for the current repo's `origin`
 * remote. Carries the raw git remote plus the resolved host identity (or null
 * host for a bare git remote). Returns null when there is no origin remote.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {import('./forge-adapter.js').RepositoryRef|null}
 */
export function detectRepositoryRef(cwd = process.cwd()) {
  return resolveRepositoryRef(readOriginUrl(cwd));
}

/**
 * Detect the current git branch.
 */
export function detectBranch(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'main';
  }
}

/**
 * Check if the current repo is the kbx template itself.
 */
export function isTemplateRepo(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    return pkg.name === 'kbexplorer' || pkg.name === 'kbexplorer-template';
  } catch {
    return false;
  }
}

/**
 * Check if a `.kbx` template is installed (submodule OR vendored copy).
 * Both look the same to the runtime: a folder containing package.json.
 */
export function hasSubmodule(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.kbx', 'package.json'));
}

/**
 * Alias for {@link hasSubmodule} with a mode-neutral name.
 */
export function hasTemplate(cwd = process.cwd()) {
  return hasSubmodule(cwd);
}

/**
 * Whether the installed `.kbx` is a real git submodule (has its own .git)
 * as opposed to a vendored one-time copy.
 */
export function isSubmoduleInstall(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.kbx', '.git'));
}

/**
 * Read the submodule's remote URL from `.gitmodules`, if present.
 * @returns {string|null}
 */
export function getSubmoduleUrl(cwd = process.cwd()) {
  const file = resolve(cwd, '.gitmodules');
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf-8');
    // Find the [submodule ".kbx"] stanza and its url.
    const lines = content.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      const header = line.match(/^\s*\[submodule\s+"([^"]+)"\]/);
      if (header) {
        inBlock = header[1] === '.kbx' || header[1].endsWith('/.kbx');
        continue;
      }
      if (inBlock) {
        const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
        if (url) return url[1];
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Get the path to the kbx app root.
 * In template repo: the repo root itself.
 * In host repo: .kbx/ submodule directory.
 */
export function getAppRoot(cwd = process.cwd()) {
  if (isTemplateRepo(cwd)) return cwd;
  const submodulePath = resolve(cwd, '.kbx');
  if (existsSync(resolve(submodulePath, 'package.json'))) return submodulePath;
  return null;
}

/**
 * Returns true when the legacy `.kbexplorer/` directory exists but `.kbx/` does not.
 * Used to emit a migration warning on dev/build.
 */
export function hasLegacyDir(cwd = process.cwd()) {
  return !existsSync(resolve(cwd, '.kbx', 'package.json')) &&
    existsSync(resolve(cwd, '.kbexplorer', 'package.json'));
}

