/**
 * kbexplorer search-index — Build or check semantic search artifacts.
 *
 * Reads the kbexplorer content model, derives SearchUnits from the knowledge
 * graph, generates embeddings via a pluggable provider, and writes checked-in
 * search artifacts (index-meta.json, units.json, vectors.json).
 *
 * In --check mode: verifies committed artifacts are fresh relative to the
 * current graph — no embedding API calls, pure deterministic comparison.
 *
 * Usage:
 *   kbexplorer search-index                  # build/update artifacts
 *   kbexplorer search-index --check          # CI drift gate
 *   kbexplorer search-index --provider openai --model text-embedding-3-small
 *   kbexplorer search-index --dir .search    # custom artifact directory
 *   kbexplorer search-index --dry-run        # show plan without writing
 */

import { resolve, relative } from 'node:path';
import { buildGraph } from '../lib/graph-builder.js';

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-small';

function parseArgs(args) {
  const out = {
    check: false,
    dryRun: false,
    help: false,
    json: false,
    dir: null,
    provider: null,
    model: null,
    content: null,
    batchSize: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') out.check = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir') out.dir = args[++i];
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else if (a === '--provider') out.provider = args[++i];
    else if (a.startsWith('--provider=')) out.provider = a.slice('--provider='.length);
    else if (a === '--model') out.model = args[++i];
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a === '--content') out.content = args[++i];
    else if (a.startsWith('--content=')) out.content = a.slice('--content='.length);
    else if (a === '--batch-size') out.batchSize = parseInt(args[++i], 10);
    else if (a.startsWith('--batch-size=')) out.batchSize = parseInt(a.slice('--batch-size='.length), 10);
  }
  return out;
}

function printHelp() {
  console.log(`
  kbexplorer search-index — Build or check semantic search artifacts

  Usage: kbexplorer search-index [options]

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
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const artifactDir = resolve(cwd, opts.dir || DEFAULT_ARTIFACT_DIR);
  const providerName = opts.provider || DEFAULT_PROVIDER;
  const modelName = opts.model || DEFAULT_MODEL;

  // Build the graph from content/
  const graph = buildGraph(cwd, { contentOverride: opts.content });
  if (graph.nodes.length === 0) {
    console.error('✗ No content nodes found. Is there a content/ directory with .md files?');
    process.exit(1);
  }

  // Lazy-import kbexplorer-search to avoid hard dependency at CLI load time.
  // Falls back to a local path if the package isn't installed.
  let search;
  try {
    search = await import('@anokye-labs/kbexplorer-search');
  } catch {
    // Development fallback: try relative path to sibling repo
    try {
      const { resolve: r } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const devPath = r(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'kbexplorer-search', 'dist', 'index.js');
      search = await import(devPath);
    } catch {
      console.error('✗ @anokye-labs/kbexplorer-search is not installed.');
      console.error('  Run: npm install @anokye-labs/kbexplorer-search');
      process.exit(1);
    }
  }

  const { extractSearchUnits, computeContentHash, readArtifacts, writeArtifacts, checkDrift, generateEmbeddings, getProvider } = search;

  // ── Dry run ──
  if (opts.dryRun) {
    const units = extractSearchUnits(graph);
    const existing = readArtifacts(artifactDir);
    const relDir = relative(cwd, artifactDir);
    console.log(`Dry run — search-index plan:`);
    console.log(`  Content nodes:    ${graph.nodes.length}`);
    console.log(`  Search units:     ${units.length}`);
    console.log(`  Artifact dir:     ${relDir}/`);
    console.log(`  Provider:         ${providerName}`);
    console.log(`  Model:            ${modelName}`);
    console.log(`  Existing index:   ${existing ? `${existing.meta.unitCount} units` : 'none'}`);
    return;
  }

  // ── Check mode ──
  if (opts.check) {
    const result = checkDrift(artifactDir, graph);
    const relDir = relative(cwd, artifactDir);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.fresh) {
      console.log(`✅ Search artifacts in ${relDir}/ are up to date.`);
    } else {
      console.error(`✗ Search artifacts in ${relDir}/ are stale:`);
      if (!result.contentHashMatch) {
        console.error(`  Content hash mismatch (graph has changed).`);
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
      console.error(`\n  Run \`kbexplorer search-index\` to update.`);
    }

    process.exit(result.fresh ? 0 : 1);
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

  console.log(`✅ Search artifacts written to ${relDir}/`);
  console.log(`   index-meta.json  units.json  vectors.json`);
}
