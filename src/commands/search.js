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

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_LIMIT = 5;

function parseArgs(args) {
  const out = {
    query: null,
    help: false,
    json: false,
    limit: null,
    cluster: null,
    entityType: null,
    minScore: null,
    dir: null,
    provider: null,
    model: null,
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--cluster') out.cluster = args[++i];
    else if (a.startsWith('--cluster=')) out.cluster = a.slice('--cluster='.length);
    else if (a === '--entity-type') out.entityType = args[++i];
    else if (a.startsWith('--entity-type=')) out.entityType = a.slice('--entity-type='.length);
    else if (a === '--min-score') out.minScore = parseFloat(args[++i]);
    else if (a.startsWith('--min-score=')) out.minScore = parseFloat(a.slice('--min-score='.length));
    else if (a === '--dir') out.dir = args[++i];
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else if (a === '--provider') out.provider = args[++i];
    else if (a.startsWith('--provider=')) out.provider = a.slice('--provider='.length);
    else if (a === '--model') out.model = args[++i];
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (!a.startsWith('-')) positional.push(a);
  }
  out.query = positional.join(' ') || null;
  return out;
}

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
  const opts = parseArgs(args);
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

  // Lazy-import kbx-search
  let searchMod;
  try {
    searchMod = await import('@anokye-labs/kbexplorer-search');
  } catch {
    try {
      const { resolve: r } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const devPath = r(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'kbx-search', 'dist', 'index.js');
      searchMod = await import(devPath);
    } catch {
      console.error('✗ @anokye-labs/kbexplorer-search is not installed.');
      console.error('  Run: npm install @anokye-labs/kbexplorer-search');
      process.exit(1);
    }
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


