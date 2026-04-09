/**
 * Manifest generation logic for kbexplorer.
 *
 * Generates repo manifest containing:
 * - configRaw: parsed config.yaml
 * - authoredContent: raw markdown strings keyed by path
 * - tree: GHTreeItem-compatible file tree from local FS
 * - readme: README.md content
 * - issues: from `gh` CLI (best-effort)
 * - pullRequests: from `gh` CLI (best-effort)
 * - commits: from git log (best-effort)
 *
 * Zero external dependencies — uses only node: built-ins + gh CLI.
 */

import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect host root for submodule scenarios
function detectHostRoot(kbRoot) {
  const parentRoot = resolve(kbRoot, '..', '..');
  try {
    const pkg = JSON.parse(readFileSync(resolve(kbRoot, 'package.json'), 'utf-8'));
    if (pkg.name === 'kbexplorer') {
      // Check if parent looks like a host repo
      if (existsSync(resolve(parentRoot, '.git')) && existsSync(resolve(parentRoot, 'package.json'))) {
        const parentPkg = JSON.parse(readFileSync(resolve(parentRoot, 'package.json'), 'utf-8'));
        if (parentPkg.name !== 'kbexplorer') return parentRoot;
      }
    }
  } catch { /* ignore */ }
  return kbRoot;
}

// ── File Tree ──────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.kbexplorer', '.astro',
  '.playwright-cli', '.vscode', '.idea', 'coverage',
]);
const SKIP_FILES = new Set([
  'package-lock.json', '.DS_Store', 'Thumbs.db',
]);

/**
 * Walk the file system and produce GHTreeItem-compatible entries.
 * @param {string} root - Directory to walk
 * @param {string} [prefix=''] - Path prefix for entries
 * @returns {Array<{path: string, type: 'blob'|'tree', size?: number}>}
 */
export function walkFileSystem(root, prefix = '') {
  const results = [];

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push({ path: entryPath, type: 'tree' });
      results.push(...walkFileSystem(resolve(root, entry.name), entryPath));
    } else {
      if (SKIP_FILES.has(entry.name)) continue;
      try {
        const stat = statSync(resolve(root, entry.name));
        results.push({ path: entryPath, type: 'blob', size: stat.size });
      } catch {
        results.push({ path: entryPath, type: 'blob' });
      }
    }
  }

  return results;
}

// ── Authored Content ───────────────────────────────────────

/**
 * Read all markdown files from a content directory.
 * @param {string} contentDir - Absolute path to content directory
 * @param {string} contentPath - Relative path prefix for keys
 * @returns {Record<string, string>}
 */
export function readAuthoredContent(contentDir, contentPath) {
  const content = {};
  if (!existsSync(contentDir)) return content;

  function walk(dir, prefix) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : `${contentPath}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, relPath.replace(new RegExp(`^${contentPath}/`), contentPath + '/'));
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        try {
          content[relPath] = readFileSync(fullPath, 'utf-8');
        } catch {
          console.warn(`[generate-manifest] Failed to read ${fullPath}`);
        }
      }
    }
  }

  walk(contentDir, contentPath);
  return content;
}

// ── Config ─────────────────────────────────────────────────

/**
 * Read and return raw config.yaml content.
 * @param {string} root - Project root
 * @param {string} [contentPath='content'] - Content directory name
 * @returns {string|null}
 */
export function readConfig(root, contentPath = 'content') {
  const paths = [
    resolve(root, contentPath, 'config.yaml'),
    resolve(root, contentPath, 'config.yml'),
    resolve(root, 'config.yaml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch { /* continue */ }
    }
  }
  return null;
}

// ── README ─────────────────────────────────────────────────

/**
 * Read README.md from the project root.
 * @param {string} root
 * @returns {string|null}
 */
export function readReadme(root) {
  const readmePath = resolve(root, 'README.md');
  if (existsSync(readmePath)) {
    try {
      return readFileSync(readmePath, 'utf-8');
    } catch { /* fall through */ }
  }
  return null;
}

// ── GitHub Data (via gh CLI) ───────────────────────────────

function isGhAvailable() {
  try {
    execSync('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch issues via gh CLI.
 * @returns {Array}
 */
export function fetchLocalIssues(cwd) {
  if (!isGhAvailable()) {
    console.warn('[generate-manifest] gh CLI not found — skipping issues');
    return [];
  }
  try {
    const json = execSync(
      'gh issue list --json number,title,body,state,labels,assignees,url,createdAt,updatedAt --state all --limit 200',
      { cwd, encoding: 'utf-8', timeout: 30000 },
    );
    const issues = JSON.parse(json);
    // Map to GHIssue-compatible shape
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      state: i.state?.toLowerCase() ?? 'open',
      labels: (i.labels ?? []).map((l) => ({
        name: typeof l === 'string' ? l : l.name,
        color: typeof l === 'string' ? '' : (l.color ?? ''),
      })),
      assignees: (i.assignees ?? []).map((a) => ({
        login: typeof a === 'string' ? a : a.login,
      })),
      html_url: i.url ?? '',
      created_at: i.createdAt ?? '',
      updated_at: i.updatedAt ?? '',
    }));
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch issues:', err.message);
    return [];
  }
}

/**
 * Fetch pull requests via gh CLI.
 * @returns {Array}
 */
export function fetchLocalPullRequests(cwd) {
  if (!isGhAvailable()) {
    console.warn('[generate-manifest] gh CLI not found — skipping PRs');
    return [];
  }
  try {
    const json = execSync(
      'gh pr list --json number,title,body,state,labels,url,createdAt,updatedAt --state all --limit 200',
      { cwd, encoding: 'utf-8', timeout: 30000 },
    );
    const prs = JSON.parse(json);
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state?.toLowerCase() ?? 'open',
      labels: (pr.labels ?? []).map((l) => ({
        name: typeof l === 'string' ? l : l.name,
        color: typeof l === 'string' ? '' : (l.color ?? ''),
      })),
      html_url: pr.url ?? '',
      created_at: pr.createdAt ?? '',
      updated_at: pr.updatedAt ?? '',
    }));
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch PRs:', err.message);
    return [];
  }
}

/**
 * Fetch recent commits via git log.
 * @returns {Array}
 */
export function fetchLocalCommits(cwd) {
  try {
    const log = execSync(
      'git log --pretty=format:"%H|||%s|||%an|||%aI" -50',
      { cwd, encoding: 'utf-8', timeout: 10000 },
    );
    if (!log.trim()) return [];
    return log.trim().split('\n').map((line) => {
      const [sha, message, author, date] = line.split('|||');
      return {
        sha,
        commit: {
          message,
          author: { name: author, date },
        },
        html_url: '',
      };
    });
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch commits:', err.message);
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────

/**
 * Generate manifest for a given root directory.
 * @param {string} root - Project root directory
 * @returns {Object} Manifest object
 */
export function generateManifest(root) {
  const hostRoot = detectHostRoot(root);
  const isSubmodule = hostRoot !== root;
  
  console.log(`[generate-manifest] Root: ${root}`);
  console.log(`[generate-manifest] Host root: ${hostRoot}`);
  console.log(`[generate-manifest] Submodule mode: ${isSubmodule}`);

  // Determine content path from env or default
  const contentPath = process.env.VITE_KB_PATH || 'content';
  const contentDir = resolve(root, contentPath);

  const manifest = {
    configRaw: readConfig(root, contentPath),
    authoredContent: readAuthoredContent(contentDir, contentPath),
    tree: walkFileSystem(root),
    readme: readReadme(root),
    issues: fetchLocalIssues(hostRoot),
    pullRequests: fetchLocalPullRequests(hostRoot),
    commits: fetchLocalCommits(hostRoot),
    generatedAt: new Date().toISOString(),
  };

  console.log(`[generate-manifest] Tree: ${manifest.tree.length} entries`);
  console.log(`[generate-manifest] Content: ${Object.keys(manifest.authoredContent).length} files`);
  console.log(`[generate-manifest] Issues: ${manifest.issues.length}`);
  console.log(`[generate-manifest] PRs: ${manifest.pullRequests.length}`);
  console.log(`[generate-manifest] Commits: ${manifest.commits.length}`);

  return manifest;
}
