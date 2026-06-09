/**
 * Template version utilities.
 *
 * Submodule installs are pinned to a specific tag; updates require explicit
 * approval. All remote-lookup helpers accept a repo URL (defaulting to the org
 * template) so custom templates work too.
 */

import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const TEMPLATE_REPO = 'https://github.com/anokye-labs/kbexplorer-template.git';

/**
 * Get the latest release tag (vX.Y.Z) from a template repo.
 * @param {string} repoUrl
 */
export function getLatestTag(repoUrl = TEMPLATE_REPO) {
  try {
    const tags = execSync(
      `git ls-remote --tags --sort=-v:refname ${repoUrl}`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const match = tags.match(/refs\/tags\/(v\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Get the tag the submodule is currently pinned to.
 */
export function getCurrentTag(cwd = process.cwd()) {
  const submodulePath = resolve(cwd, '.kbexplorer');
  try {
    const tag = execSync('git describe --tags --exact-match HEAD', {
      cwd: submodulePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return tag || null;
  } catch {
    // Not on a tag — check the commit
    try {
      const sha = execSync('git rev-parse --short HEAD', {
        cwd: submodulePath,
        encoding: 'utf-8',
      }).trim();
      return `(commit ${sha})`;
    } catch {
      return null;
    }
  }
}

/**
 * Get all available release tags from a template repo, newest first.
 * @param {string} repoUrl
 */
export function getAvailableTags(repoUrl = TEMPLATE_REPO) {
  try {
    const output = execSync(
      `git ls-remote --tags --sort=-v:refname ${repoUrl}`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    return [...output.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)]
      .map(m => m[1]);
  } catch {
    return [];
  }
}

/**
 * Checkout a submodule to a specific tag.
 */
export function checkoutTag(tag, cwd = process.cwd()) {
  checkoutRef(tag, cwd);
}

/**
 * Checkout a submodule to a specific tag or branch.
 * @param {string} ref
 * @param {string} cwd
 */
export function checkoutRef(ref, cwd = process.cwd()) {
  const submodulePath = resolve(cwd, '.kbexplorer');
  execSync('git fetch --tags', { cwd: submodulePath, stdio: 'pipe' });
  execSync(`git checkout ${ref}`, { cwd: submodulePath, stdio: 'pipe' });
}

/**
 * Resolve the HEAD commit SHA of a git working directory (for reproducibility).
 * @param {string} dir
 * @returns {string|null}
 */
export function resolveHeadSha(dir) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the latest commit SHA for a branch on a remote.
 * @param {string} repoUrl
 * @param {string} branch
 * @returns {string|null}
 */
export function getBranchSha(repoUrl, branch) {
  try {
    const out = execSync(
      `git ls-remote ${repoUrl} refs/heads/${branch}`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    const m = out.match(/^([0-9a-f]{40})\s/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export { TEMPLATE_REPO };
