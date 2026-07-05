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
import { loadGraph } from '../lib/engine-graph.ts';
import { resolveContentDir } from '../lib/kb-env.ts';

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
export function createAffordanceContext({ cwd = process.cwd(), roots, seams = {} } = {}) {
  const absCwd = resolve(cwd);
  /** @type {import('../lib/engine-graph.ts').Graph|null} */
  let graphCache = null;

  return {
    cwd: absCwd,
    roots,
    seams,

    /** Resolve the content directory (honours an optional `content` override). */
    resolveContent({ content } = {}) {
      return resolveContentDir(absCwd, content);
    },

    /** Load (and memoise) the knowledge graph scoped to `roots` (or `cwd`). */
    async loadGraph() {
      if (!graphCache) {
        graphCache = await loadGraph(roots ? { roots, cwd: absCwd } : { cwd: absCwd });
      }
      return graphCache;
    },
  };
}
