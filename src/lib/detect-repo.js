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
 * Check if .kbexplorer submodule exists.
 */
export function hasSubmodule(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.kbexplorer', 'package.json'));
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
