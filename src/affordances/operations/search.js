/**
 * Affordance: `search` — semantic search over the knowledge graph.
 *
 * Read-only, protocol-neutral. Runs a cosine-similarity query over checked-in
 * search artifacts via the `@anokye-labs/kbexplorer-search` engine and returns
 * kbx-native results (ids, titles, clusters, paths, snippets, scores).
 *
 * The search module is resolved through the context's `loadSearchModule` seam
 * when present (kept hermetic for tests / injectable by adapters); otherwise it
 * is dynamically imported. The contract does not bundle the engine, so a missing
 * module surfaces as a typed `UNSUPPORTED` error and missing artifacts as
 * `MISSING_ARTIFACT` — never a thrown transport concern.
 *
 * @module src/affordances/operations/search
 */

import { resolve } from 'node:path';
import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';

const DEFAULT_ARTIFACT_DIR = '.search';
const DEFAULT_LIMIT = 5;
const DEFAULT_PROVIDER = 'openai';

async function resolveSearchModule(context) {
  if (typeof context.seams?.loadSearchModule === 'function') {
    return context.seams.loadSearchModule();
  }
  return import('@anokye-labs/kbexplorer-search');
}

export default defineAffordance({
  name: 'search',
  title: 'Semantic search',
  summary:
    'Cosine-similarity search over checked-in search artifacts; returns ranked kbx-native results.',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    query: { type: 'string', required: true, description: 'Natural-language search query.' },
    limit: { type: 'number', default: DEFAULT_LIMIT, min: 1, description: 'Max results.' },
    cluster: { type: 'string', description: 'Filter by cluster id.' },
    entityType: { type: 'string', description: 'Filter by entity type.' },
    minScore: { type: 'number', min: 0, max: 1, description: 'Minimum cosine similarity (0..1).' },
    dir: { type: 'string', description: `Artifact directory (default ${DEFAULT_ARTIFACT_DIR}).` },
    provider: { type: 'string', description: `Embedding provider (default ${DEFAULT_PROVIDER}).` },
    model: { type: 'string', description: 'Embedding model (must match the indexed model).' },
  }),
  output: defineSchema({
    query: { type: 'string' },
    results: { type: 'array' },
  }),
  async execute(context, input) {
    let mod;
    try {
      mod = await resolveSearchModule(context);
    } catch {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        '@anokye-labs/kbexplorer-search is not installed. Run: npm install @anokye-labs/kbexplorer-search'
      );
    }

    const { readArtifacts, createSearchEngine, getProvider } = mod;
    const artifactDir = resolve(context.cwd, input.dir || DEFAULT_ARTIFACT_DIR);
    const artifact = readArtifacts(artifactDir);
    if (!artifact) {
      throw new AffordanceError(
        ERROR_CODES.MISSING_ARTIFACT,
        `No search artifacts found in ${artifactDir}. Run \`kbx search-index\` to build them.`,
        { artifactDir }
      );
    }

    const providerName = input.provider || DEFAULT_PROVIDER;
    const modelName = input.model || artifact.meta?.model;
    let provider;
    try {
      provider = getProvider(providerName, {
        model: modelName,
        dimensions: artifact.meta?.dimensions,
      });
    } catch (err) {
      throw new AffordanceError(ERROR_CODES.EXECUTION_FAILED, err.message, {
        provider: providerName,
      });
    }

    const engine = createSearchEngine(artifact, provider);
    let results;
    try {
      results = await engine.search(input.query, {
        limit: input.limit ?? DEFAULT_LIMIT,
        cluster: input.cluster,
        entityType: input.entityType,
        minScore: input.minScore,
      });
    } catch (err) {
      throw new AffordanceError(ERROR_CODES.EXECUTION_FAILED, `search failed: ${err.message}`);
    }

    return { query: input.query, results };
  },
});
