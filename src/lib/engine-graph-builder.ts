import { basename, dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, loadKnowledgeBase } from '@anokye-labs/kbexplorer-engine';
import { FileSystemSource } from '@anokye-labs/kbexplorer-engine/sources';
import { readConfig } from './repo-manifest.ts';
import { resolveContentDir } from './kb-env.ts';

interface BuildEngineGraphOptions {
  contentOverride?: string;
  sourceRoot?: string;
}

interface EngineConfig {
  clusters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Build a KBGraph through the engine's config-first pipeline.
 *
 * This is additive and intentionally leaves the legacy graph-loading path
 * untouched while the CLI and affordance layer migrate to the engine graph.
 *
 * The graph is returned **exactly as the engine produces it** — the same graph
 * the SPA consumes via `loadKnowledgeBase(config, { source })`. The CLI does NOT
 * reshape node identities or edge types here; any search-specific projection is
 * documented at the search layer (see `index-meta.json`), never hidden in the
 * builder. Two engine *seams* are used to match the CLI's content-only scope:
 *
 *  - `includeFileTree: false` — the CLI indexes authored + provider *entities*,
 *    not the walked file tree. Without this the engine's FilesProvider
 *    materializes repo-root / dir- / file- scaffolding nodes that pollute node
 *    counts and invent spurious connectivity.
 *  - root-scan fallback — when the resolved `content/` sub-directory doesn't
 *    exist under the source root, top-level `.md` files ARE the content
 *    (`contentPath: ''`), matching the CLI's root-level content convention.
 */
export async function buildEngineGraph(cwd: string, options: BuildEngineGraphOptions = {}) {
  const { contentPath } = resolveContentDir(cwd, options.contentOverride);
  const sourceRoot = options.sourceRoot ?? (isAbsolute(contentPath) ? dirname(contentPath) : cwd);
  const resolvedContentPath = isAbsolute(contentPath) ? basename(contentPath) : contentPath;

  // Root-scan fallback: if the content sub-directory is absent under the source
  // root, treat the root's top-level `.md` files as authored content.
  const hasContentDir = existsSync(join(sourceRoot, resolvedContentPath));
  const sourceContentPath = hasContentDir ? resolvedContentPath : '';

  const configRaw = readConfig(cwd, contentPath);
  const parsedConfig = (configRaw ? parseYaml(configRaw) : undefined) as EngineConfig | undefined;
  // The engine's cluster extraction does `Object.entries(config.clusters)`, so a
  // user config that omits `clusters` (a minimal `title:`-only config.yaml) must
  // still carry an empty `clusters` map. Merge a `{}` default UNDER the parsed
  // config so an explicit `clusters:` block wins; fall back to DEFAULT_CONFIG only
  // when there is no user config at all. This deliberately does NOT pull in
  // DEFAULT_CONFIG's feature set for a partial user config (that would change node
  // counts) — it only guarantees the shape the engine dereferences.
  const config =
    parsedConfig && Object.keys(parsedConfig).length > 0
      ? { clusters: {}, ...parsedConfig }
      : DEFAULT_CONFIG;

  const source = new FileSystemSource(sourceRoot, {
    contentPath: sourceContentPath,
    includeFileTree: false,
  });
  return loadKnowledgeBase(
    config as Parameters<typeof loadKnowledgeBase>[0],
    { source } as Parameters<typeof loadKnowledgeBase>[1],
  );
}
