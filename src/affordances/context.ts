/**
 * Affordance execution context — the protocol-neutral "given this context" half
 * of the DO-seam (PE3-F1).
 *
 * An affordance is *"given this **context**, what action is available…"*. This
 * module builds that context: a small, transport-neutral bag of where to read
 * from (`cwd`, optional `roots`) plus lazily-resolved, cached views over the
 * local knowledge graph and content directory. It carries **no** knowledge of
 * MCP, JSON-RPC, or canvases.
 *
 * The context also exposes optional **injectable seams** (`seams`) so the
 * contract stays hermetically testable and so adapters/the job layer can supply
 * capabilities the contract deliberately does not own — most importantly the
 * fuzzy `runExtraction` runtime used by `derive` and the semantic-search module
 * used by `search`. When a seam is absent the relevant affordance fails with a
 * typed {@link AffordanceError} rather than reaching for a transport.
 *
 * @module src/affordances/context
 */

import { resolve } from 'node:path';
import { loadGraph, type LoadedGraph } from '../lib/engine-graph.ts';
import { resolveContentDir } from '../lib/kb-env.ts';
import type { JobChange, JobPartialFailure, JobProgress, JobStore } from './jobs/store.ts';

type IngestedDocument = ReturnType<typeof import('../lib/ingest.ts').readSource>;

export interface ExtractionIntermediate {
  entities: unknown[];
  relationships: unknown[];
}

export interface GenerateRunArgs {
  request: Record<string, unknown>;
  signal: AbortSignal;
  onProgress: (progress: Partial<JobProgress>) => void;
  getCredential: (name: string) => string;
}

export interface GenerateRunResult {
  changes?: JobChange[];
  partial?: JobPartialFailure[];
}

export interface CreatePullRequestArgs {
  title: string;
  body: string;
  branch?: string;
  base?: string;
  changes: JobChange[];
  cwd: string;
}

export interface CreatePullRequestResult {
  url?: string;
  branch?: string;
}

/**
 * @typedef {object} AffordanceContextSeams
 * @property {() => Promise<object>} [loadSearchModule]
 *   Resolves the `@anokye-labs/kbexplorer-search` module (or a stub in tests).
 * @property {(document: object) => Promise<{entities: object[], relationships: object[]}>} [runExtraction]
 *   Fuzzy extractor for `derive`. Owned by the adapter/job layer, never by the
 *   contract — its absence makes `derive` (non-`--check`) report `UNSUPPORTED`.
 *
 * @typedef {object} AffordanceContext
 * @property {string} cwd
 * @property {string[]|undefined} roots
 * @property {AffordanceContextSeams} seams
 * @property {(opts?: {content?: string}) => {contentDir: string, contentPath: string}} resolveContent
 * @property {() => Promise<import('../lib/engine-graph.ts').Graph>} loadGraph  Cached graph view.
 */
export interface AffordanceContextSeams {
  loadSearchModule?: () => Promise<unknown>;
  runExtraction?: (document: IngestedDocument) => Promise<ExtractionIntermediate>;
  requestConsent?: (request: unknown) => Promise<unknown> | unknown;
  consentPolicy?: 'allow';
  jobStore?: JobStore;
  runGenerate?: (args: GenerateRunArgs) => Promise<GenerateRunResult>;
  createPullRequest?: (args: CreatePullRequestArgs) => Promise<CreatePullRequestResult>;
}

export interface ResolvedContentDir {
  contentDir: string;
  contentPath: string;
}

export interface AffordanceContext {
  cwd: string;
  roots?: string[];
  seams: AffordanceContextSeams;
  resolveContent: (opts?: { content?: string }) => ResolvedContentDir;
  loadGraph: () => Promise<LoadedGraph>;
}

export interface CreateAffordanceContextOptions {
  cwd?: string;
  roots?: string[];
  seams?: AffordanceContextSeams;
}

/**
 * Build a protocol-neutral affordance execution context.
 *
 * @param {object} [opts]
 * @param {string}   [opts.cwd=process.cwd()]  Repository / working root.
 * @param {string[]} [opts.roots]              Sandbox roots; defaults to `[cwd]`
 *        inside the loader when omitted. Pass when a host scopes readable folders.
 * @param {AffordanceContextSeams} [opts.seams={}]  Injectable capabilities.
 * @returns {AffordanceContext}
 */
export function createAffordanceContext({
  cwd = process.cwd(),
  roots,
  seams = {},
}: CreateAffordanceContextOptions = {}): AffordanceContext {
  const absCwd = resolve(cwd);
  let graphCache: LoadedGraph | null = null;

  return {
    cwd: absCwd,
    roots,
    seams,

    /** Resolve the content directory (honours an optional `content` override). */
    resolveContent({ content }: { content?: string } = {}): ResolvedContentDir {
      return resolveContentDir(absCwd, content);
    },

    /** Load (and memoise) the knowledge graph scoped to `roots` (or `cwd`). */
    async loadGraph(): Promise<LoadedGraph> {
      if (!graphCache) {
        graphCache = await loadGraph(roots ? { roots, cwd: absCwd } : { cwd: absCwd });
      }
      return graphCache;
    },
  };
}
