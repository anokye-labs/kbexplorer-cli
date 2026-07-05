import { basename, dirname, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, loadKnowledgeBase } from '@anokye-labs/kbexplorer-engine';
import { FileSystemSource } from '@anokye-labs/kbexplorer-engine/sources';
import { readConfig } from './manifest.js';
import { resolveContentDir } from './kb-env.js';

/**
 * Build a KBGraph through the engine's config-first pipeline.
 *
 * This is additive and intentionally leaves the legacy graph-loading path
 * untouched while the CLI and affordance layer migrate to the engine graph.
 */
export async function buildEngineGraph(cwd, options = {}) {
  const { contentPath } = resolveContentDir(cwd, options.contentOverride);
  const sourceRoot = options.sourceRoot ?? (isAbsolute(contentPath) ? dirname(contentPath) : cwd);
  const sourceContentPath = isAbsolute(contentPath) ? basename(contentPath) : contentPath;

  const configRaw = readConfig(cwd, contentPath);
  const parsedConfig = configRaw ? parseYaml(configRaw) : undefined;
  const config = parsedConfig && Object.keys(parsedConfig).length > 0 ? parsedConfig : DEFAULT_CONFIG;

  const source = new FileSystemSource(sourceRoot, { contentPath: sourceContentPath });
  return loadKnowledgeBase(config, { source });
}
