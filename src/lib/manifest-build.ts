/**
 * kbx manifest producer — thin wrapper over the engine's `buildManifest()`
 * (anokye-labs/kbexplorer-cli#258, discharging the cli#232 duplication debt).
 *
 * Before this module, `src/lib/repo-manifest.ts` was a ~650-line byte-parallel
 * fork of kbexplorer-template's `scripts/generate-manifest.js`: it re-implemented
 * the filesystem walk, content read, and `gh`/`git` GitHub-data fetching that the
 * engine's `RepoSource` implementations (`FileSystemSource`, `GitHubApiSource`)
 * already own. The engine now also owns the producer half — `buildManifest()`
 * drives a `RepoSource` through `getRepoData()` once and reshapes the result
 * into a `RepoManifest` — so the CLI no longer needs (or is allowed to keep) its
 * own generator. This module just resolves *which* `RepoSource` to use and
 * supplies the one field no `RepoSource` can derive (`configRaw`, the raw
 * pre-YAML-parse `config.yaml` text).
 *
 * Local mode (default, and the only mode `kbx manifest`/`kbx dev` use today)
 * drives a `FileSystemSource` over `cwd`. `FileSystemSource.getRepoData()` is a
 * pure filesystem snapshot — it does not shell out to `gh`/`git`, so
 * `issues`/`pullRequests`/`commits`/`releases`/`branches`/`repoMetadata` are
 * always empty/null. That is an accepted trade-off of retiring the CLI's
 * byte-parallel fork (see cli#258's "CRITICAL NUANCE"): byte-identical parity
 * is required only for source-derived fields (`configRaw`, `authoredContent`,
 * `tree`, `readme`, …), not the live-GitHub fields, which `--check` explicitly
 * excludes from drift comparison (see `checkManifestDrift` below).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '@anokye-labs/kbexplorer-engine';
import { FileSystemSource, GitHubApiSource, type RepoManifest } from '@anokye-labs/kbexplorer-engine/sources';
import { resolveContentDir, readConfig } from './kb-env.ts';
import { canonicalStringify } from './jsonld.ts';

export type { RepoManifest };

export const manifestBuildDeps = {
  buildManifest,
  FileSystemSource,
  GitHubApiSource,
};

/**
 * Fields excluded from `--check` drift comparison: the volatile/GitHub-live
 * fields a `FileSystemSource`-backed rebuild cannot reproduce (`generatedAt`
 * and the `issues`/`pullRequests`/`commits`/`releases`/`branches`/`repoMetadata`
 * GitHub-derived fields), plus `tree` — the same exclusions the engine's
 * golden test documents ("the whole-repo file tree ... aren't content and
 * aren't stable", `tests/golden/build-golden.mjs`). `tree` is additionally
 * self-referential here: it includes the manifest's own on-disk output path
 * (written inside the scanned root), so it necessarily differs across builds
 * regardless of any real content change. Real content drift is still fully
 * caught via `authoredContent`/`configRaw`/`readme`.
 */
export const DRIFT_EXCLUDED_FIELDS = [
  'generatedAt',
  'tree',
  'issues',
  'pullRequests',
  'commits',
  'releases',
  'branches',
  'repoMetadata',
] as const;

export interface BuildRepoManifestOptions {
  /** Override the snapshot timestamp (tests / `--check` determinism). */
  generatedAt?: string;
  /** Override the content sub-directory (defaults via `resolveContentDir`). */
  contentOverride?: string;
  /** `owner/name` — when set, builds from the live GitHub API instead of the local filesystem. */
  repo?: string;
  /** `owner/name` — when set, augments the local filesystem manifest with live GitHub data. */
  augment?: string;
  /** Override the GitHub branch used in remote/hybrid mode (defaults to `main`). */
  branch?: string;
}

/**
 * Build a `RepoManifest` for `cwd` via the engine's `buildManifest()` producer.
 *
 * Local mode (default): constructs a `FileSystemSource` over `cwd` using the
 * same content-path resolution (`resolveContentDir`) already shared by
 * `kbx audit`/the engine-graph pipeline, and reads `configRaw` directly (the
 * one field `buildManifest` cannot derive from `RepoData`).
 *
 * Remote mode (`options.repo` set): constructs a `GitHubApiSource`, mirroring
 * the `--repo owner/name` convention already used by `kbx explore`. The
 * constructor is called with the `'full'` preset and an injected `EngineEnv`
 * carrying `GITHUB_TOKEN`/`GH_TOKEN` when present, because `GitHubApiSource`
 * only fetches commits under the `'full'` preset (the default `'standard'`
 * preset omits them, and the old generator shipped 50 commits) and the engine's
 * `ghFetch` reads `GITHUB_TOKEN ?? GH_TOKEN` from that injected environment.
 * When no token is set, `env` stays `undefined` and the build remains
 * unauthenticated (still works for public repos, just rate-limited).
 * `configRaw` is left `undefined` in this mode — a remote caller has no local
 * file to read and the engine's `GitHubApiSource` does not expose raw config
 * text.
 */
export async function buildRepoManifest(
  cwd: string,
  options: BuildRepoManifestOptions = {},
): Promise<RepoManifest> {
  if (options.repo) {
    const [owner, repo] = options.repo.split('/');
    if (!owner || !repo) {
      throw new Error('repo must be in owner/name form');
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const env = token ? { GITHUB_TOKEN: token } : undefined;
    const source = new manifestBuildDeps.GitHubApiSource(
      { owner, repo, path: 'content', branch: options.branch ?? 'main' },
      'full',
      env,
    );
    return manifestBuildDeps.buildManifest(source, { generatedAt: options.generatedAt });
  }

  const { contentPath } = resolveContentDir(cwd, options.contentOverride);
  // Root-scan fallback: if the content sub-directory is absent, treat the
  // root's top-level `.md` files as authored content — the same convention
  // `buildEngineGraph` (src/lib/engine-graph-builder.ts) already uses.
  const hasContentDir = existsSync(resolve(cwd, contentPath));
  const sourceContentPath = hasContentDir ? contentPath : '';

  const configRaw = readConfig(cwd, contentPath);
  const source = new manifestBuildDeps.FileSystemSource(cwd, { contentPath: sourceContentPath });
  if (options.augment) {
    const [owner, repo] = options.augment.split('/');
    if (!owner || !repo) {
      throw new Error('augment must be in owner/name form');
    }
    const augmentFrom = new manifestBuildDeps.GitHubApiSource(
      { owner, repo, path: 'content', branch: options.branch ?? 'main' },
      'full',
      { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
    );
    return manifestBuildDeps.buildManifest(source, { configRaw, generatedAt: options.generatedAt, augmentFrom });
  }

  return manifestBuildDeps.buildManifest(source, { configRaw, generatedAt: options.generatedAt });
}

/** A single drifted top-level manifest field (`kbx manifest --check`). */
export interface ManifestDrift {
  field: string;
  reason: string;
}

function omitFields(manifest: RepoManifest, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  for (const field of fields) delete out[field];
  return out;
}

/**
 * Compare an on-disk manifest against a freshly-built one, ignoring the
 * volatile / live-GitHub fields (`DRIFT_EXCLUDED_FIELDS`) that a
 * `FileSystemSource`-backed rebuild cannot reproduce byte-for-byte (see this
 * module's docs). Returns the list of drifted top-level fields — empty means
 * "in sync".
 */
export function diffManifests(onDisk: RepoManifest, fresh: RepoManifest): ManifestDrift[] {
  const drift: ManifestDrift[] = [];
  const onDiskStable = omitFields(onDisk, DRIFT_EXCLUDED_FIELDS);
  const freshStable = omitFields(fresh, DRIFT_EXCLUDED_FIELDS);
  const keys = new Set([...Object.keys(onDiskStable), ...Object.keys(freshStable)]);
  for (const key of keys) {
    const a = canonicalStringify(onDiskStable[key] ?? null);
    const b = canonicalStringify(freshStable[key] ?? null);
    if (a !== b) {
      drift.push({ field: key, reason: 'value differs from a fresh rebuild' });
    }
  }
  return drift;
}
