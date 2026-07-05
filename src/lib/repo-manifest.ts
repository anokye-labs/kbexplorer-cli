/**
 * Manifest generation logic for kbx.
 *
 * Generates repo manifest containing:
 * - configRaw: parsed config.yaml
 * - authoredContent: raw markdown strings keyed by path
 * - tree: GHTreeItem-compatible file tree from local FS
 * - readme: README.md content
 * - issues: from `gh` CLI or direct HTTP (best-effort)
 * - pullRequests: from `gh` CLI or direct HTTP (best-effort)
 * - commits: from git log (best-effort)
 * - releases: from `gh` CLI or direct HTTP (best-effort); drafts excluded; capped at 30 newest
 *
 * Manifest shape — top-level keys:
 *   configRaw        string | null      Raw config.yaml content
 *   authoredContent  Record<string,string>  Markdown files keyed by relative path
 *   tree             GHTreeItem[]       File-system tree entries
 *   readme           string | null      README.md content
 *   issues           GHIssue[]          GitHub issues (all states, limit 200)
 *   pullRequests     GHPullRequest[]    GitHub PRs (all states, limit 200)
 *   commits          GHCommit[]         Recent commits (limit 50)
 *   releases         GHRelease[]        GitHub releases (non-draft, limit 30, newest first)
 *   generatedAt      ISO-8601 string    Generation timestamp
 *
 * GHRelease shape:
 *   tag_name         string             Git tag associated with the release
 *   name             string             Release title (falls back to tag_name)
 *   body             string             Release notes markdown
 *   html_url         string             URL to the release page
 *   published_at     string             ISO-8601 publish timestamp
 *   prerelease       boolean            True for pre-release (alpha/beta/rc)
 *
 * # GitHub API base configuration
 *
 * By default all GitHub data is fetched via the `gh` CLI (byte-identical to
 * previous behaviour). Set an API base to switch to direct HTTP:
 *
 *   ## Gitea DTU adapter (hermetic / local testing)
 *   KBX_GH_API_BASE=http://localhost:3456 KBX_GH_TOKEN=test-token kbx manifest
 *
 *   ## GitHub Enterprise (GHE / EMU)
 *   KBX_GH_API_BASE=https://github.example.com/api/v3 KBX_GH_TOKEN=<pat> kbx manifest
 *   # Or, when using the gh CLI authenticated against your GHE host (no base override needed):
 *   GH_HOST=github.example.com kbx manifest
 *
 * See src/lib/gh-fetch.js for the full precedence chain and auth details.
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

import type {
  GHCommit,
  GHIssue,
  GHRelease,
  GHTreeItem,
} from '@anokye-labs/kbexplorer-engine';
import type { RepoPullRequest } from '@anokye-labs/kbexplorer-engine/sources';
import { resolveGhApiBase, resolveGhToken, createFetcher } from './gh-fetch.ts';
import { resolveRepositoryRef } from './forge-adapter.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

type ExecLike = typeof execSync;
type FetchLike = typeof globalThis.fetch;

interface FetchOverrides {
  base?: string | null;
  token?: string;
  _exec?: ExecLike;
  _fetch?: FetchLike;
}

interface ManifestData {
  configRaw: string | null;
  authoredContent: Record<string, string>;
  tree: GHTreeItem[];
  readme: string | null;
  issues: GHIssue[];
  pullRequests: RepoPullRequest[];
  commits: GHCommit[];
  releases: GHRelease[];
  generatedAt: string;
}

type JsonRecord = Record<string, unknown>;

// gh-fetch's TS migration is not complete yet; this local cast preserves the existing runtime contract.
const createManifestFetcher = createFetcher as unknown as (options: {
  base?: string | null;
  token?: string;
  execOpts?: { cwd?: string };
  _exec?: ExecLike;
  _fetch?: FetchLike;
}) => (path: string) => Promise<unknown>;

function normalizeLineEndings(text: unknown): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Detect host root for submodule scenarios
function detectHostRoot(kbRoot: string): string {
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
  'node_modules', '.git', 'dist', '.kbx', '.kbexplorer', '.astro',
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
export function walkFileSystem(root: string, prefix = ''): Array<{ path: string; type: 'blob' | 'tree'; size?: number }> {
  const results: Array<{ path: string; type: 'blob' | 'tree'; size?: number }> = [];

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
export function readAuthoredContent(contentDir: string, contentPath: string): Record<string, string> {
  const content: Record<string, string> = {};
  if (!existsSync(contentDir)) return content;

  function walk(dir: string, prefix: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : `${contentPath}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, relPath.replace(new RegExp(`^${contentPath}/`), contentPath + '/'));
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        try {
          content[relPath] = normalizeLineEndings(readFileSync(fullPath, 'utf-8'));
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
export function readConfig(root: string, contentPath = 'content'): string | null {
  const paths = [
    resolve(root, contentPath, 'config.yaml'),
    resolve(root, contentPath, 'config.yml'),
    resolve(root, 'config.yaml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return normalizeLineEndings(readFileSync(p, 'utf-8'));
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
export function readReadme(root: string): string | null {
  const readmePath = resolve(root, 'README.md');
  if (existsSync(readmePath)) {
    try {
      return normalizeLineEndings(readFileSync(readmePath, 'utf-8'));
    } catch { /* fall through */ }
  }
  return null;
}

// ── GitHub Data ────────────────────────────────────────────

function isGhAvailable(_exec: ExecLike = execSync): boolean {
  try {
    _exec('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve owner/repo for direct-HTTP paths.
 *
 * When a base override is active the `{owner}/{repo}` placeholders that `gh api`
 * resolves automatically must be supplied explicitly.  We derive them from the
 * git remote, falling back to empty strings so callers can still make their
 * best effort.
 *
 * @param {string} [cwd]
 * @param {Function} [_exec] - Injected execSync (for testing)
 * @returns {{ owner: string, repo: string }}
 */
export function resolveOwnerRepo(cwd?: string, _exec: ExecLike = execSync): { owner: string; repo: string } {
  try {
    const remote = _exec('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    // Parse through the host-neutral ForgeAdapter seam (#141/#143). GitHub wins
    // via its adapter (byte-identical); SSH is host-agnostic; a self-hosted /
    // GHES HTTPS remote resolves via the seam's generic `scheme://host/o/r`
    // fallback instead of assuming GitHub.
    const ref = resolveRepositoryRef(remote);
    if (ref?.host) return { owner: ref.host.owner, repo: ref.host.repo };
  } catch { /* not a git repo or no remote */ }
  return { owner: '', repo: '' };
}

/**
 * Fetch issues.
 *
 * Default path  → `gh issue list --json …` (unchanged behaviour)
 * Override path → GET /repos/{owner}/{repo}/issues?state=all&per_page=200
 *
 * @param {string}        [cwd]
 * @param {object}        [_overrides] - Injected dependencies (for testing)
 * @param {string|null}   [_overrides.base]   - API base override (null → gh CLI)
 * @param {string}        [_overrides.token]  - Auth token for direct HTTP
 * @param {Function}      [_overrides._exec]  - Injected execSync
 * @param {Function}      [_overrides._fetch] - Injected fetch
 * @returns {Array|Promise<Array>}
 */
function mapIssueLabel(label: unknown): { name: string; color: string } {
  if (typeof label === 'string') return { name: label, color: '' };
  if (isRecord(label)) return { name: stringValue(label.name), color: stringValue(label.color) };
  return { name: '', color: '' };
}

function mapAssignee(assignee: unknown): { login: string } {
  if (typeof assignee === 'string') return { login: assignee };
  if (isRecord(assignee)) return { login: stringValue(assignee.login) };
  return { login: '' };
}

function mapHttpIssue(issue: unknown): GHIssue {
  const value = isRecord(issue) ? issue : {};
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: stringValue(value.state, 'open').toLowerCase(),
    labels: arrayValue(value.labels).map(mapIssueLabel),
    assignees: arrayValue(value.assignees).map(mapAssignee),
    html_url: stringValue(value.html_url),
    created_at: stringValue(value.created_at),
    updated_at: stringValue(value.updated_at),
  };
}

function mapCliIssue(issue: unknown): GHIssue {
  const value = isRecord(issue) ? issue : {};
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: stringValue(value.state, 'open').toLowerCase(),
    labels: arrayValue(value.labels).map(mapIssueLabel),
    assignees: arrayValue(value.assignees).map(mapAssignee),
    html_url: stringValue(value.url),
    created_at: stringValue(value.createdAt),
    updated_at: stringValue(value.updatedAt),
  };
}

function mapHttpPullRequest(pr: unknown): RepoPullRequest {
  const value = isRecord(pr) ? pr : {};
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: stringValue(value.state, 'open').toLowerCase(),
    labels: arrayValue(value.labels).map(mapIssueLabel),
    html_url: stringValue(value.html_url),
    created_at: stringValue(value.created_at),
    updated_at: stringValue(value.updated_at),
  };
}

function mapCliPullRequest(pr: unknown): RepoPullRequest {
  const value = isRecord(pr) ? pr : {};
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: stringValue(value.state, 'open').toLowerCase(),
    labels: arrayValue(value.labels).map(mapIssueLabel),
    html_url: stringValue(value.url),
    created_at: stringValue(value.createdAt),
    updated_at: stringValue(value.updatedAt),
  };
}

function mapRelease(release: unknown): GHRelease {
  const value = isRecord(release) ? release : {};
  return {
    tag_name: stringValue(value.tag_name),
    name: stringValue(value.name) || stringValue(value.tag_name),
    body: stringValue(value.body),
    html_url: stringValue(value.html_url),
    published_at: stringValue(value.published_at),
    prerelease: value.prerelease === true,
  };
}

function isDraftRelease(release: unknown): boolean {
  return isRecord(release) && release.draft === true;
}

export function fetchLocalIssues(cwd?: string, _overrides: FetchOverrides = {}): GHIssue[] | Promise<GHIssue[]> {
  const { base, token, _exec: injectedExec, _fetch } = _overrides;
  const exec = injectedExec ?? execSync;

  // ── Direct-HTTP path ──────────────────────────────────────────────────────
  if (base != null) {
    const { owner, repo } = resolveOwnerRepo(cwd, exec);
    const fetcher = createManifestFetcher({ base, token, execOpts: { cwd }, _exec: injectedExec, _fetch });
    return fetcher(`/repos/${owner}/${repo}/issues?state=all&per_page=200`)
      .then((data) => arrayValue(data).map(mapHttpIssue))
      .catch((err) => {
        console.warn('[generate-manifest] Failed to fetch issues (HTTP):', getErrorMessage(err));
        return [];
      });
  }

  // ── Default path: gh CLI ──────────────────────────────────────────────────
  if (!isGhAvailable(exec)) {
    console.warn('[generate-manifest] gh CLI not found — skipping issues');
    return [];
  }
  try {
    const json = exec(
      'gh issue list --json number,title,body,state,labels,assignees,url,createdAt,updatedAt --state all --limit 200',
      { cwd, encoding: 'utf-8', timeout: 30000 },
    );
    const issues = JSON.parse(json) as unknown;
    return arrayValue(issues).map(mapCliIssue);
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch issues:', getErrorMessage(err));
    return [];
  }
}

/**
 * Fetch pull requests.
 *
 * Default path  → `gh pr list --json …` (unchanged behaviour)
 * Override path → GET /repos/{owner}/{repo}/pulls?state=all&per_page=200
 *
 * @param {string}        [cwd]
 * @param {object}        [_overrides] - Injected dependencies (for testing)
 * @param {string|null}   [_overrides.base]   - API base override (null → gh CLI)
 * @param {string}        [_overrides.token]  - Auth token for direct HTTP
 * @param {Function}      [_overrides._exec]  - Injected execSync
 * @param {Function}      [_overrides._fetch] - Injected fetch
 * @returns {Array|Promise<Array>}
 */
export function fetchLocalPullRequests(
  cwd?: string,
  _overrides: FetchOverrides = {},
): RepoPullRequest[] | Promise<RepoPullRequest[]> {
  const { base, token, _exec: injectedExec, _fetch } = _overrides;
  const exec = injectedExec ?? execSync;

  // ── Direct-HTTP path ──────────────────────────────────────────────────────
  if (base != null) {
    const { owner, repo } = resolveOwnerRepo(cwd, exec);
    const fetcher = createManifestFetcher({ base, token, execOpts: { cwd }, _exec: injectedExec, _fetch });
    return fetcher(`/repos/${owner}/${repo}/pulls?state=all&per_page=200`)
      .then((data) => arrayValue(data).map(mapHttpPullRequest))
      .catch((err) => {
        console.warn('[generate-manifest] Failed to fetch PRs (HTTP):', getErrorMessage(err));
        return [];
      });
  }

  // ── Default path: gh CLI ──────────────────────────────────────────────────
  if (!isGhAvailable(exec)) {
    console.warn('[generate-manifest] gh CLI not found — skipping PRs');
    return [];
  }
  try {
    const json = exec(
      'gh pr list --json number,title,body,state,labels,url,createdAt,updatedAt --state all --limit 200',
      { cwd, encoding: 'utf-8', timeout: 30000 },
    );
    const prs = JSON.parse(json) as unknown;
    return arrayValue(prs).map(mapCliPullRequest);
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch PRs:', getErrorMessage(err));
    return [];
  }
}

/** Maximum number of releases to include in the manifest. */
const RELEASES_LIMIT = 30;

/**
 * Fetch GitHub releases.
 *
 * Default path  → `gh api "repos/{owner}/{repo}/releases?per_page=30"` (unchanged)
 * Override path → GET /repos/{owner}/{repo}/releases?per_page=30 (direct HTTP)
 *
 * Drafts are excluded; results are sorted newest-first and capped at RELEASES_LIMIT.
 * Tolerates gh absence or non-zero exit — returns empty array and emits a warning.
 *
 * @param {string}   [cwd] - Working directory for the gh invocation
 * @param {Function} [_exec] - Injected execSync replacement (for testing; default path only)
 * @param {object}   [_overrides] - Injected dependencies (for testing; override path)
 * @param {string|null}  [_overrides.base]   - API base override (null → gh CLI)
 * @param {string}       [_overrides.token]  - Auth token for direct HTTP
 * @param {Function}     [_overrides._exec]  - Injected execSync (for both paths)
 * @param {Function}     [_overrides._fetch] - Injected fetch (override path only)
 * @returns {Array<{tag_name:string,name:string,body:string,html_url:string,published_at:string,prerelease:boolean}>|Promise}
 */
export function fetchLocalReleases(
  cwd?: string,
  _exec: ExecLike = execSync,
  _overrides: FetchOverrides = {},
): GHRelease[] | Promise<GHRelease[]> {
  const base = _overrides.base ?? null;
  const token = _overrides.token;
  const injectedExec = _overrides._exec ?? _exec;
  const _fetch = _overrides._fetch;

  function shapeReleases(releases: unknown[]): GHRelease[] {
    return releases
      .filter((release) => !isDraftRelease(release))
      .map(mapRelease)
      .sort((a, b) => Date.parse(b.published_at || '0') - Date.parse(a.published_at || '0'))
      .slice(0, RELEASES_LIMIT)
      .map((r) => ({ ...r }));
  }

  // ── Direct-HTTP path ──────────────────────────────────────────────────────
  if (base != null) {
    const { owner, repo } = resolveOwnerRepo(cwd, injectedExec);
    const fetcher = createManifestFetcher({ base, token, execOpts: { cwd }, _exec: injectedExec, _fetch });
    return fetcher(`/repos/${owner}/${repo}/releases?per_page=${RELEASES_LIMIT}`)
      .then((data) => shapeReleases(arrayValue(data)))
      .catch((err) => {
        console.warn('[generate-manifest] Failed to fetch releases (HTTP):', getErrorMessage(err));
        return [];
      });
  }

  // ── Default path: gh CLI ──────────────────────────────────────────────────
  try {
    injectedExec('gh --version', { stdio: 'ignore' });
  } catch {
    console.warn('[generate-manifest] gh CLI not found — skipping releases');
    return [];
  }
  try {
    // The endpoint must be quoted: execSync goes through a shell where an
    // unquoted `?`/`&` is parsed as shell syntax (`&` splits commands on both
    // cmd.exe and POSIX shells).
    const json = injectedExec(
      `gh api "repos/{owner}/{repo}/releases?per_page=${RELEASES_LIMIT}"`,
      { cwd, encoding: 'utf-8', timeout: 30000 },
    );
    return shapeReleases(arrayValue(JSON.parse(json) as unknown));
  } catch (err) {
    console.warn('[generate-manifest] Failed to fetch releases:', getErrorMessage(err));
    return [];
  }
}

/**
 * Fetch recent commits via git log.
 * @returns {Array}
 */
export function fetchLocalCommits(cwd?: string): GHCommit[] {
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
    console.warn('[generate-manifest] Failed to fetch commits:', getErrorMessage(err));
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────

/**
 * Generate manifest for a given root directory.
 *
 * When `KBX_GH_API_BASE` is set (or `ghApiBase` is in .kbx.json),
 * GitHub data is fetched via direct HTTP to that base (DTU / GHE path).
 * Otherwise the `gh` CLI is used — behaviour is byte-identical to before.
 *
 * @param {string} root - Project root directory
 * @returns {Promise<Object>} Manifest object
 */
export async function generateManifest(root: string): Promise<ManifestData> {
  const hostRoot = detectHostRoot(root);
  const isSubmodule = hostRoot !== root;

  console.log(`[generate-manifest] Root: ${root}`);
  console.log(`[generate-manifest] Host root: ${hostRoot}`);
  console.log(`[generate-manifest] Submodule mode: ${isSubmodule}`);

  // Resolve GitHub API base + token once per run
  const ghApiBase = resolveGhApiBase(hostRoot);
  const ghToken = ghApiBase ? resolveGhToken() : undefined;

  if (ghApiBase) {
    console.log(`[generate-manifest] GitHub API base: ${ghApiBase} (direct HTTP)`);
  }

  const overrides = ghApiBase != null ? { base: ghApiBase, token: ghToken } : {};

  // Determine content path from env or default
  const contentPath = process.env.VITE_KB_PATH || 'content';
  const contentDir = resolve(root, contentPath);

  const [issues, pullRequests, releases] = await Promise.all([
    Promise.resolve(fetchLocalIssues(hostRoot, overrides)),
    Promise.resolve(fetchLocalPullRequests(hostRoot, overrides)),
    Promise.resolve(fetchLocalReleases(hostRoot, execSync, overrides)),
  ]);

  const manifest = {
    configRaw: readConfig(root, contentPath),
    authoredContent: readAuthoredContent(contentDir, contentPath),
    tree: walkFileSystem(root),
    readme: readReadme(root),
    issues,
    pullRequests,
    commits: fetchLocalCommits(hostRoot),
    releases,
    generatedAt: new Date().toISOString(),
  };

  console.log(`[generate-manifest] Tree: ${manifest.tree.length} entries`);
  console.log(`[generate-manifest] Content: ${Object.keys(manifest.authoredContent).length} files`);
  console.log(`[generate-manifest] Issues: ${manifest.issues.length}`);
  console.log(`[generate-manifest] PRs: ${manifest.pullRequests.length}`);
  console.log(`[generate-manifest] Commits: ${manifest.commits.length}`);
  console.log(`[generate-manifest] Releases: ${manifest.releases.length}`);

  return manifest;
}
