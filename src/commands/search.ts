/**
 * kbx search — Semantic search over the knowledge graph.
 *
 * Loads checked-in search artifacts and runs a cosine similarity query.
 * Returns kbx-native results: node IDs, titles, clusters, paths,
 * snippets, scores, and graph context.
 *
 * Usage:
 *   kbx search "how does audit validation work?"
 *   kbx search "deployment" --limit 10
 *   kbx search "config" --cluster infra --json
 */

import { resolve, relative } from 'node:path';
import { parseSearchArgs } from '../lib/args.ts';

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_LIMIT = 5;

function printHelp() {
  console.log(`
  kbx search — Semantic search over the knowledge graph

  Usage: kbx search <query> [options]

  Loads checked-in search artifacts and runs a cosine similarity query.

  Arguments:
    <query>               Natural language search query

  Options:
    --limit <n>           Max results (default: ${DEFAULT_LIMIT})
    --cluster <id>        Filter by cluster
    --entity-type <type>  Filter by entity type
    --min-score <n>       Minimum cosine similarity (0..1)
    --dir <path>          Artifact directory (default: ${DEFAULT_ARTIFACT_DIR})
    --provider <name>     Embedding provider (default: openai)
    --model <id>          Embedding model (must match indexed model)
    --json                Machine-readable JSON output
    -h, --help            Show this help
`);
}

function formatScore(score) {
  return (score * 100).toFixed(1) + '%';
}

export default async function search(args = []) {
  const opts = parseSearchArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.query) {
    console.error('✗ No query given. Usage: kbx search <query> [options]');
    process.exit(1);
  }

  const cwd = process.cwd();
  const artifactDir = resolve(cwd, opts.dir || DEFAULT_ARTIFACT_DIR);

  // Lazy-import kbx-search to avoid a hard dependency at CLI load time.
  let searchMod;
  try {
    searchMod = await import('@anokye-labs/kbexplorer-search');
  } catch {
    console.error('✗ @anokye-labs/kbexplorer-search is not installed.');
    console.error('  Run: npm install @anokye-labs/kbexplorer-search');
    process.exit(1);
  }

  const { readArtifacts, createSearchEngine, getProvider } = searchMod;

  // Load artifacts
  const artifact = readArtifacts(artifactDir);
  if (!artifact) {
    const relDir = relative(cwd, artifactDir);
    console.error(`✗ No search artifacts found in ${relDir}/`);
    console.error(`  Run \`kbx search-index\` to build them.`);
    process.exit(1);
  }

  // Resolve provider (must match what was used for indexing)
  const providerName = opts.provider || 'openai';
  const modelName = opts.model || artifact.meta.model;
  let provider;
  try {
    provider = getProvider(providerName, {
      model: modelName,
      dimensions: artifact.meta.dimensions,
    });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const engine = createSearchEngine(artifact, provider);
  const results = await engine.search(opts.query, {
    limit: opts.limit || DEFAULT_LIMIT,
    cluster: opts.cluster,
    entityType: opts.entityType,
    minScore: opts.minScore,
  });

  if (opts.json) {
    console.log(JSON.stringify({ query: opts.query, results }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No results for "${opts.query}".`);
    return;
  }

  console.log(`\n  Results for "${opts.query}":\n`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = `${i + 1}.`;
    const score = formatScore(r.score);
    console.log(`  ${rank} ${r.title}  [${score}]  cluster:${r.cluster}`);
    if (r.path) console.log(`     ${r.path}`);
    if (r.snippet) {
      const snippet = r.snippet.length > 120 ? r.snippet.slice(0, 120) + '...' : r.snippet;
      console.log(`     ${snippet}`);
    }
    if (r.connections.length > 0) {
      console.log(`     → ${r.connections.slice(0, 5).join(', ')}`);
    }
    console.log('');
  }
}


