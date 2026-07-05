/**
 * kbx search-index — Build or check semantic search artifacts.
 *
 * Reads the kbx content model, derives SearchUnits from the knowledge
 * graph, generates embeddings via a pluggable provider, and writes checked-in
 * search artifacts (index-meta.json, units.json, vectors.json).
 *
 * In --check mode: verifies committed artifacts are fresh relative to the
 * current graph — no embedding API calls, pure deterministic comparison.
 *
 * Usage:
 *   kbx search-index                  # build/update artifacts
 *   kbx search-index --check          # CI drift gate
 *   kbx search-index --provider openai --model text-embedding-3-small
 *   kbx search-index --dir .search    # custom artifact directory
 *   kbx search-index --dry-run        # show plan without writing
 */

import { resolve, relative } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSearchIndexArgs } from '../lib/args.js';
import { buildEngineGraph } from '../lib/engine-graph-builder.js';
import { DEFAULT_ACCESS_EXCLUSION, isExcludedByDefault } from '../lib/access-label.js';

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-small';

function normalizeProjectionSettings(settings = {}) {
  return {
    mode: settings.mode ?? DEFAULT_ACCESS_EXCLUSION?.mode ?? 'exclude',
    excludedClassifications: [...(settings.excludedClassifications ?? DEFAULT_ACCESS_EXCLUSION?.excludedClassifications ?? [])].sort(),
    excludedVisibilities: [...(settings.excludedVisibilities ?? DEFAULT_ACCESS_EXCLUSION?.excludedVisibilities ?? [])].sort(),
  };
}

// A node produces a SearchUnit iff it has non-empty body content — this mirrors
// @anokye-labs/kbexplorer-search's extractSearchUnits, which uses
// `rawContent` (falling back to stripped `content`) as the unit body and SKIPS
// any node whose body is empty. A title alone does NOT make a unit, so
// structural provider entities (pull_request, issue, workflow, …) that carry a
// title but no prose are correctly reported as unit-less here.
function hasUnitCandidate(node) {
  if (!node) return false;
  const content = typeof node.rawContent === 'string' ? node.rawContent : typeof node.content === 'string' ? node.content : '';
  return content.trim().length > 0;
}

export function buildProjectionMetadata(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const projectedNodeIds = nodes
    .filter((node) => !isExcludedByDefault(node?.access, DEFAULT_ACCESS_EXCLUSION))
    .map((node) => node.id)
    .sort();
  const unitLessNodeKinds = [...new Set(nodes.filter((node) => !hasUnitCandidate(node)).map((node) => node.nodeType ?? node.kind ?? 'unknown'))].sort();
  return {
    projectedNodeIds,
    engineNodeIdSetHash: createHash('sha256').update(projectedNodeIds.join('\n')).digest('hex'),
    projection: {
      accessExclusion: normalizeProjectionSettings(DEFAULT_ACCESS_EXCLUSION),
      unitLessNodeKinds,
    },
  };
}

function readExistingArtifactMeta(artifactDir) {
  const metaPath = resolve(artifactDir, 'index-meta.json');
  if (!metaPath) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function persistProjectionMetadata(artifactDir, meta) {
  const indexMetaPath = resolve(artifactDir, 'index-meta.json');
  const existing = readExistingArtifactMeta(artifactDir) ?? {};
  const nextMeta = {
    ...existing,
    ...meta,
    projection: meta.projection ?? existing.projection ?? {
      accessExclusion: normalizeProjectionSettings(DEFAULT_ACCESS_EXCLUSION),
      unitLessNodeKinds: [],
    },
  };
  writeFileSync(indexMetaPath, JSON.stringify(nextMeta, null, 2) + '\n');
}

function printHelp() {
  console.log(`
  kbx search-index — Build or check semantic search artifacts

  Usage: kbx search-index [options]

  Reads content/, extracts SearchUnits from the knowledge graph, generates
  embeddings, and writes checked-in artifacts to the artifact directory.

  Options:
    --check               Drift gate: verify artifacts are fresh (no API calls)
    --dir <path>          Artifact directory (default: ${DEFAULT_ARTIFACT_DIR})
    --provider <name>     Embedding provider (default: ${DEFAULT_PROVIDER})
    --model <id>          Embedding model (default: ${DEFAULT_MODEL})
    --content <dir>       Override content directory
    --batch-size <n>      Embeddings per API call (default: 100)
    --dry-run             Show plan without writing artifacts
    --json                Machine-readable JSON output
    -h, --help            Show this help
`);
}

export default async function searchIndex(args = []) {
  const opts = parseSearchIndexArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const artifactDir = resolve(cwd, opts.dir || DEFAULT_ARTIFACT_DIR);
  const providerName = opts.provider || DEFAULT_PROVIDER;
  const modelName = opts.model || DEFAULT_MODEL;

  // Build the graph via the engine-backed pipeline so search-index uses the
  // same KBGraph shape as the SPA and the affordance layer.
  const graph = await buildEngineGraph(cwd, { contentOverride: opts.content });
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    console.error('✗ No content nodes found. Is there a content/ directory with .md files?');
    process.exit(1);
  }

  // Lazy-import kbx-search to avoid a hard dependency at CLI load time.
  let search;
  try {
    search = await import('@anokye-labs/kbexplorer-search');
  } catch {
    console.error('✗ @anokye-labs/kbexplorer-search is not installed.');
    console.error('  Run: npm install @anokye-labs/kbexplorer-search');
    process.exit(1);
  }

  const { extractSearchUnits, computeContentHash, readArtifacts, writeArtifacts, checkDrift, generateEmbeddings, getProvider } = search;
  const projectionMeta = buildProjectionMetadata(graph);

  // ── Dry run ──
  if (opts.dryRun) {
    const units = extractSearchUnits(graph);
    const existing = readArtifacts(artifactDir);
    const relDir = relative(cwd, artifactDir);
    console.log(`Dry run — search-index plan:`);
    console.log(`  Content nodes:    ${graph.nodes.length}`);
    console.log(`  Search units:     ${units.length}`);
    console.log(`  Engine node hash: ${projectionMeta.engineNodeIdSetHash}`);
    console.log(`  Artifact dir:     ${relDir}/`);
    console.log(`  Provider:         ${providerName}`);
    console.log(`  Model:            ${modelName}`);
    console.log(`  Existing index:   ${existing ? `${existing.meta.unitCount} units` : 'none'}`);
    return;
  }

  // ── Check mode ──
  if (opts.check) {
    const result = checkDrift(artifactDir, graph);
    const previousMeta = readArtifacts(artifactDir)?.meta ?? {};
    const nodeHashMatch = previousMeta.engineNodeIdSetHash === projectionMeta.engineNodeIdSetHash;
    const projectionMatch = JSON.stringify(previousMeta.projection ?? null) === JSON.stringify(projectionMeta.projection);
    const fresh = Boolean(result.fresh && nodeHashMatch && projectionMatch);
    const relDir = relative(cwd, artifactDir);
    const payload = {
      ...result,
      fresh,
      engineNodeIdSetHash: projectionMeta.engineNodeIdSetHash,
      previousEngineNodeIdSetHash: previousMeta.engineNodeIdSetHash,
      projection: projectionMeta.projection,
      previousProjection: previousMeta.projection,
      nodeHashMatch,
      projectionMatch,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (fresh) {
      console.log(`✅ Search artifacts in ${relDir}/ are up to date.`);
    } else {
      console.error(`✗ Search artifacts in ${relDir}/ are stale:`);
      if (!result.contentHashMatch) {
        console.error(`  Content hash mismatch (graph has changed).`);
      }
      if (!nodeHashMatch) {
        console.error(`  Engine node-id-set hash mismatch (graph projection changed).`);
      }
      if (!projectionMatch) {
        console.error(`  Projection metadata mismatch (access exclusion / unit-less node kinds changed).`);
      }
      if (result.missingUnits.length > 0) {
        console.error(`  Missing units: ${result.missingUnits.join(', ')}`);
      }
      if (result.extraUnits.length > 0) {
        console.error(`  Extra units: ${result.extraUnits.join(', ')}`);
      }
      if (result.staleUnits.length > 0) {
        console.error(`  Stale units: ${result.staleUnits.join(', ')}`);
      }
      console.error(`\n  Run \`kbx search-index\` to update.`);
    }

    process.exit(fresh ? 0 : 1);
    return;
  }

  // ── Build mode ──
  const units = extractSearchUnits(graph);
  const contentHash = computeContentHash(graph);
  const previousArtifact = readArtifacts(artifactDir);
  const relDir = relative(cwd, artifactDir);

  console.log(`Building search index...`);
  console.log(`  Content nodes:  ${graph.nodes.length}`);
  console.log(`  Search units:   ${units.length}`);
  console.log(`  Provider:       ${providerName}`);
  console.log(`  Model:          ${modelName}`);

  let provider;
  try {
    provider = getProvider(providerName, { model: modelName });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const vectors = await generateEmbeddings(units, provider, {
    batchSize: opts.batchSize || 100,
    previousArtifact: previousArtifact || undefined,
    onProgress: ({ completed, total, cached, embedded }) => {
      process.stdout.write(`\r  Embedding: ${completed}/${total} (${cached} cached, ${embedded} new)`);
    },
  });
  console.log('');

  const config = {
    embedding: { provider: providerName, model: modelName },
    artifacts: { dir: relDir },
  };
  writeArtifacts(artifactDir, units, vectors, config, contentHash);
  persistProjectionMetadata(artifactDir, {
    contentHash,
    unitCount: units.length,
    engineNodeIdSetHash: projectionMeta.engineNodeIdSetHash,
    projection: projectionMeta.projection,
  });

  console.log(`✅ Search artifacts written to ${relDir}/`);
  console.log(`   index-meta.json  units.json  vectors.json`);
}


