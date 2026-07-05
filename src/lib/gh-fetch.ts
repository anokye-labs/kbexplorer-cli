/**
 * GitHub API fetch seam for kbexplorer manifest generation.
 *
 * Resolves an API base URL and dispatches either the default `gh` CLI path
 * or a direct-HTTP path (for DTU adapters such as the Gitea twin, or GitHub
 * Enterprise hosts). The two paths are kept byte-for-byte equivalent from the
 * caller's perspective: both return parsed JSON or throw on failure.
 *
 * # API-base resolution precedence (highest → lowest)
 *
 *   1. `ghApiBase` field in `.kbexplorer.json`
 *   2. `KBEXPLORER_GH_API_BASE` environment variable
 *   3. No base (default) → `gh api` CLI is used, exactly as before
 *
 * # Auth when a base is set
 *
 *   `Authorization: token <KBX_GH_TOKEN || GH_TOKEN>`
 *
 * The Gitea DTU adapter is a bare GitHub REST v3 proxy; it does not support the
 * `gh` auth handshake, so `gh --hostname` will not authenticate against it.
 * Direct HTTP fetch with an explicit token is the correct approach.
 *
 * # Pointing the CLI at alternative hosts
 *
 *   ## Gitea DTU adapter (hermetic testing)
 *   KBX_GH_API_BASE=http://localhost:3456 KBX_GH_TOKEN=test-token kbx manifest
 *
 *   ## GitHub Enterprise (GHE / EMU)
 *   KBX_GH_API_BASE=https://github.example.com/api/v3 KBX_GH_TOKEN=<pat> kbx manifest
 *   # Or, when using the gh CLI authenticated against your GHE host:
 *   GH_HOST=github.example.com kbx manifest  (no KBX_GH_API_BASE needed)
 *
 * Zero external dependencies — uses only node: built-ins + the injected fetch / execSync.
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync as _defaultExecSync } from 'node:child_process';

/** Env var for overriding the GitHub API base URL. */
export const GH_API_BASE_ENV = 'KBX_GH_API_BASE';

/** Env var for the auth token used with direct-HTTP fetches. */
export const GH_TOKEN_ENV = 'KBX_GH_TOKEN';

/** Fallback token env var (gh CLI convention). */
export const GH_TOKEN_FALLBACK_ENV = 'GH_TOKEN';

type ExecOptions = {
  cwd?: string;
  timeout?: number;
  encoding?: BufferEncoding;
  [key: string]: unknown;
};

type ExecFn = (command: string, options?: ExecOptions) => string | Buffer;

interface GhFetchOptions {
  base: string | null | undefined;
  path: string;
  token?: string;
  execOpts?: ExecOptions;
  _exec?: ExecFn;
  _fetch?: typeof fetch;
}

/**
 * Resolve the GitHub API base URL using the precedence chain:
 *
 *   1. `ghApiBase` field in `.kbx.json` (or legacy `.kbexplorer.json`)
 *   2. `KBX_GH_API_BASE` env var (or legacy `KBEXPLORER_GH_API_BASE`)
 *   3. null (default → use `gh` CLI)
 *
 * @param {string} [cwd=process.cwd()] - Project root to look for .kbx.json
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
export function resolveGhApiBase(cwd = process.cwd(), env = process.env) {
  // 1. .kbx.json field (also accepts legacy .kbexplorer.json)
  for (const fileName of ['.kbx.json', '.kbexplorer.json']) {
    const configFile = resolve(cwd, fileName);
    if (existsSync(configFile)) {
      try {
        const data: unknown = JSON.parse(readFileSync(configFile, 'utf-8'));
        if (
          data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          typeof (data as { ghApiBase?: unknown }).ghApiBase === 'string' &&
          (data as { ghApiBase: string }).ghApiBase.trim()
        ) {
          return (data as { ghApiBase: string }).ghApiBase.trim();
        }
      } catch { /* ignore malformed JSON */ }
      break; // found a config file (even if it had no ghApiBase), stop searching
    }
  }

  // 2. Env var (with legacy fallback)
  const envVal = env[GH_API_BASE_ENV];
  if (envVal && envVal.trim()) {
    return envVal.trim();
  }
  const legacyVal = env['KBEXPLORER_GH_API_BASE'];
  if (legacyVal && legacyVal.trim()) {
    process.stderr.write(`[kbx] KBEXPLORER_GH_API_BASE is deprecated; rename to ${GH_API_BASE_ENV}\n`);
    return legacyVal.trim();
  }

  // 3. Default: use gh CLI
  return null;
}

/**
 * Resolve the auth token for direct-HTTP fetches.
 *
 * Precedence: KBX_GH_TOKEN → KBEXPLORER_GH_TOKEN (deprecated) → GH_TOKEN → '' (anonymous)
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveGhToken(env = process.env) {
  if (env[GH_TOKEN_ENV]) return env[GH_TOKEN_ENV];
  const legacy = env['KBEXPLORER_GH_TOKEN'];
  if (legacy) {
    process.stderr.write(`[kbx] KBEXPLORER_GH_TOKEN is deprecated; rename to ${GH_TOKEN_ENV}\n`);
    return legacy;
  }
  return env[GH_TOKEN_FALLBACK_ENV] || '';
}

/**
 * Build a GitHub REST v3 URL from a base and a path.
 *
 * @param {string} base - Base URL (e.g. "http://localhost:3456")
 * @param {string} path - API path (e.g. "/repos/owner/repo/issues")
 * @returns {string}
 */
export function buildApiUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

/**
 * Fetch a GitHub REST v3 endpoint.
 *
 * When `base` is null, delegates to `execSync('gh api ...')` (the default path —
 * byte-identical to today's behavior). When `base` is set, uses direct HTTP
 * with the resolved token (the DTU / GHE path).
 *
 * The `path` uses `{owner}` / `{repo}` placeholders, consistent with the
 * existing `gh api` invocation style (e.g. `repos/{owner}/{repo}/releases`).
 *
 * @param {object} opts
 * @param {string|null} opts.base     - API base URL or null for gh CLI
 * @param {string}      opts.path     - Endpoint path (with or without leading /)
 * @param {string}      [opts.token]  - Auth token for direct HTTP
 * @param {object}      [opts.execOpts] - Options forwarded to execSync (cwd, timeout…)
 * @param {Function}    [opts._exec]  - Injected execSync (for testing)
 * @param {Function}    [opts._fetch] - Injected fetch (for testing)
 * @returns {Promise<unknown>} Parsed JSON response
 * @throws {Error} on non-200 HTTP status or JSON parse failure
 */
export async function ghFetch({ base, path, token, execOpts = {}, _exec, _fetch }: GhFetchOptions): Promise<unknown> {
  if (base === null || base === undefined) {
    // ── Default path: gh CLI ───────────────────────────────────────────────
    const exec = _exec ?? _defaultExecSync;
    // Wrap endpoint in double quotes so `?` and `&` survive the shell
    // (same guard as the existing fetchLocalReleases implementation).
    const quoted = path.startsWith('"') ? path : `"${path}"`;
    const json = exec(`gh api ${quoted}`, {
      encoding: 'utf-8',
      timeout: 30000,
      ...execOpts,
    });
    return JSON.parse(String(json));
  }

  // ── Override path: direct HTTP ─────────────────────────────────────────
  const fetchFn = _fetch ?? globalThis.fetch;
  const url = buildApiUrl(base, path);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetchFn(url, { headers });
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} — ${url}`,
    );
  }
  return response.json();
}

/**
 * Create a bound fetcher pre-configured with base + token + execOpts.
 *
 * This is the primary integration point for manifest.js — create one fetcher
 * per manifest run, then pass it (or its parts) to each fetch* function.
 *
 * @param {object} opts
 * @param {string|null} opts.base
 * @param {string}      [opts.token]
 * @param {object}      [opts.execOpts]
 * @param {Function}    [opts._exec]
 * @param {Function}    [opts._fetch]
 * @returns {(path: string) => Promise<unknown>}
 */
export function createFetcher({
  base = null,
  token,
  execOpts = {},
  _exec,
  _fetch,
}: Partial<GhFetchOptions> = {}) {
  return (path: string) => ghFetch({ base, path, token, execOpts, _exec, _fetch });
}
