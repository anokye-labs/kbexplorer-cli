/**
 * Template version pinning utilities.
 *
 * The submodule is pinned to a specific tag. Updates require explicit approval.
 */

import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const TEMPLATE_REPO = 'https://github.com/anokye-labs/kbexplorer-template.git';

/**
 * Get the latest release tag from the template repo.
 */
export function getLatestTag() {
  try {
    const tags = execSync(
      `git ls-remote --tags --sort=-v:refname ${TEMPLATE_REPO}`,
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
 * Get all available tags from the template repo, sorted newest first.
 */
export function getAvailableTags() {
  try {
    const output = execSync(
      `git ls-remote --tags --sort=-v:refname ${TEMPLATE_REPO}`,
      { encoding: 'utf-8', timeout: 15000 },
    );
    return [...output.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)]
      .map(m => m[1]);
  } catch {
    return [];
  }
}

/**
 * Checkout the submodule to a specific tag.
 */
export function checkoutTag(tag, cwd = process.cwd()) {
  const submodulePath = resolve(cwd, '.kbexplorer');
  execSync(`git fetch --tags`, { cwd: submodulePath, stdio: 'pipe' });
  execSync(`git checkout ${tag}`, { cwd: submodulePath, stdio: 'pipe' });
}

export { TEMPLATE_REPO };
