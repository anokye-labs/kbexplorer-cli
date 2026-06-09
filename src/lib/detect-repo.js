/**
 * Repository detection utilities.
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Detect the git remote owner/repo from the current directory.
 */
export function detectGitRemote(cwd = process.cwd()) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
    }).trim();

    const sshMatch = remote.match(/git@[^:]+:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  } catch { /* not a git repo or no remote */ }
  return null;
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
 * Check if the current repo is the kbexplorer template itself.
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
 * Check if a `.kbexplorer` template is installed (submodule OR vendored copy).
 * Both look the same to the runtime: a folder containing package.json.
 */
export function hasSubmodule(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.kbexplorer', 'package.json'));
}

/**
 * Alias for {@link hasSubmodule} with a mode-neutral name.
 */
export function hasTemplate(cwd = process.cwd()) {
  return hasSubmodule(cwd);
}

/**
 * Whether the installed `.kbexplorer` is a real git submodule (has its own .git)
 * as opposed to a vendored one-time copy.
 */
export function isSubmoduleInstall(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.kbexplorer', '.git'));
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
    // Find the [submodule ".kbexplorer"] stanza and its url.
    const lines = content.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      const header = line.match(/^\s*\[submodule\s+"([^"]+)"\]/);
      if (header) {
        inBlock = header[1] === '.kbexplorer' || header[1].endsWith('/.kbexplorer');
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
 * Get the path to the kbexplorer app root.
 * In template repo: the repo root itself.
 * In host repo: .kbexplorer/ submodule directory.
 */
export function getAppRoot(cwd = process.cwd()) {
  if (isTemplateRepo(cwd)) return cwd;
  const submodulePath = resolve(cwd, '.kbexplorer');
  if (existsSync(resolve(submodulePath, 'package.json'))) return submodulePath;
  return null;
}
