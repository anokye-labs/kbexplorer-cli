/**
 * Composite ingestion runtime (E2-M1 / issue #134).
 *
 * `loadCompositeKnowledgeBase` generalizes single-source loading into a
 * multi-source build: it resolves the providers declared by a
 * {@link module:lib/composite-config KbxCompositeConfig}, runs them in
 * dependency order, and merges their fragments into ONE {@link KBGraph} as a
 * **naive source-qualified union** — every node/edge from every source is kept,
 * tagged with the originating `sourceId` (provenance / claims intact). There is
 * deliberately NO identity minting or cross-source resolution here; that is E3's
 * job. Colliding ids from different sources are preserved side-by-side.
 *
 * Determinism is the contract: identical inputs → byte-identical output. The
 * merged graph is sorted by stable keys, and the optional content-addressed
 * {@link GraphStore} cache (default OFF) is parity-checked — the output is
 * identical whether the cache is on or off, because the cache only memoizes the
 * exact {@link ProviderResult} a provider would have produced.
 *
 * Engine policies (from `ingestion`):
 *   - `failureMode`  fail-fast (throw on first provider error) | best-effort
 *                    (record the error, continue with the rest).
 *   - `concurrency`  max providers resolved in parallel within a dependency level.
 *   - `budgets`      maxSources / maxNodes / maxEdges / timeoutMs (per provider).
 *
 * Provider loading is injectable (`loadProvider`) so the engine is fully
 * hermetic under test; the default loader dynamic-imports `source.module` and
 * guards it with {@link checkProviderCompatibility}.
 *
 * @module lib/composite-ingest
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  PROVIDER_API_VERSION,
  checkProviderCompatibility,
  formatGraphStoreCacheKey,
  type ContentHash,
  type ExternalProviderConfig,
  type GraphProvider,
  type GraphStore,
  type GraphStoreCacheKey,
  type GraphStoreEntry,
  type GraphStoreInvalidation,
  type GraphStoreWrite,
  type KBAccessLabel,
  type KBConfig,
  type KBEdge,
  type KBGraph,
  type KBNode,
  type ProviderCapability,
  type ProviderContext,
  type ProviderFactory,
  type ProviderResult,
  type Source,
} from '@anokye-labs/kbexplorer-core';
import { canonicalStringify } from './jsonld.ts';
import { normalizeCompositeConfig } from './composite-config.ts';
import { inheritAccess } from './access-label.ts';

/** Capabilities this host engine advertises to loadable providers. */
export const HOST_CAPABILITIES = Object.freeze(['graph:nodes', 'graph:edges', 'sources'] as const);

/** Stable error codes for ingestion-runtime failures. */
export const CompositeIngestErrorCode = Object.freeze({
  PROVIDER_LOAD_FAILED: 'KBX_PROVIDER_LOAD_FAILED',
  PROVIDER_INCOMPATIBLE: 'KBX_PROVIDER_INCOMPATIBLE',
  PROVIDER_FAILED: 'KBX_PROVIDER_FAILED',
  PROVIDER_TIMEOUT: 'KBX_PROVIDER_TIMEOUT',
  DEPENDENCY_CYCLE: 'KBX_DEPENDENCY_CYCLE',
  BUDGET_EXCEEDED: 'KBX_BUDGET_EXCEEDED',
} as const);

type CompositeIngestErrorCodeValue =
  (typeof CompositeIngestErrorCode)[keyof typeof CompositeIngestErrorCode];
type NormalizedCompositeConfig = ReturnType<typeof normalizeCompositeConfig>;
type NormalizedSource = NormalizedCompositeConfig['sources'][number];
type NormalizedIngestion = NormalizedCompositeConfig['ingestion'];
type CompositeNode = KBNode & { [key: string]: unknown };
type CompositeGraph = Omit<KBGraph, 'nodes'> & { nodes: CompositeNode[] };

interface CompositeIngestErrorOptions {
  code?: CompositeIngestErrorCodeValue;
  sourceId?: string;
  cause?: unknown;
}

interface ProviderLoadContext {
  cwd?: string;
  importer?: (spec: string) => Promise<unknown>;
}

interface ProviderEntry {
  source: NormalizedSource;
  sourceId: string;
  provider: GraphProvider;
}

interface SourceFragment {
  sourceId: string;
  providerId?: string;
  nodes: CompositeNode[];
  edges: KBEdge[];
  cached?: boolean;
  access?: KBAccessLabel;
}

interface CompositeErrorRecord {
  sourceId: string;
  code: CompositeIngestErrorCodeValue | string;
  message: string;
}

interface CompositeResultRecord extends SourceFragment {
  providerId: string;
  cached: boolean;
}

interface LoadCompositeKnowledgeBaseOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  loadProvider?: (source: NormalizedSource, ctx: ProviderLoadContext) => Promise<ProviderFactory>;
  importer?: (spec: string) => Promise<unknown>;
  kbConfig?: KBConfig;
  sources?: Record<string, Source>;
  store?: GraphStore<ProviderResult>;
}

interface LoadCompositeKnowledgeBaseResult {
  graph: CompositeGraph;
  results: CompositeResultRecord[];
  errors: CompositeErrorRecord[];
  skipped: string[];
  warnings: string[];
  stats: {
    sources: number;
    resolved: number;
    failed: number;
    nodes: number;
    edges: number;
    cacheHits: number;
  };
}

type SettledProviderResult =
  | { entry: ProviderEntry; result: ProviderResult; cached: boolean }
  | { entry: ProviderEntry; error: unknown };

const toErrorMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));
const isSettledProviderError = (
  value: SettledProviderResult,
): value is Extract<SettledProviderResult, { error: unknown }> => 'error' in value;

/** Error thrown by the composite ingestion engine. Carries a stable `.code`. */
export class CompositeIngestError extends Error {
  code: CompositeIngestErrorCodeValue;
  sourceId?: string;

  constructor(
    message: string,
    { code = CompositeIngestErrorCode.PROVIDER_FAILED, sourceId, cause }: CompositeIngestErrorOptions = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CompositeIngestError';
    this.code = code;
    if (sourceId) this.sourceId = sourceId;
  }
}

/**
 * Content digest of an arbitrary JSON-serializable value, as a core
 * {@link ContentHash}. Uses the byte-stable {@link canonicalStringify} so the
 * digest is order-independent for structurally identical inputs.
 *
 * @param {unknown} value
 * @returns {{ algorithm: 'sha256', digest: string, encoding: 'hex' }}
 */
export function contentHash(value: unknown): ContentHash {
  const digest = createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
  return { algorithm: 'sha256', digest, encoding: 'hex' };
}

/**
 * Minimal content-addressed, in-memory {@link GraphStore} for the optional
 * provider-result cache. First-party hosts may inject a persistent store; this
 * one exists so the cache path (and its byte-identical parity) is exercisable
 * without any backing service. Keys are serialized with the core's
 * {@link formatGraphStoreCacheKey} so two structurally-identical keys collide.
 */
export class MemoryGraphStore implements GraphStore<ProviderResult> {
  _map: Map<string, GraphStoreEntry<ProviderResult>>;

  constructor() {
    /** @type {Map<string, import('@anokye-labs/kbexplorer-core').GraphStoreEntry>} */
    this._map = new Map();
  }

  async get(key: GraphStoreCacheKey): Promise<GraphStoreEntry<ProviderResult> | undefined> {
    return this._map.get(formatGraphStoreCacheKey(key));
  }

  async put(entry: GraphStoreWrite<ProviderResult>): Promise<void> {
    const now = new Date(0).toISOString();
    this._map.set(formatGraphStoreCacheKey(entry.key), {
      createdAt: now,
      updatedAt: now,
      ...entry,
    });
  }

  async delete(key: GraphStoreCacheKey): Promise<boolean> {
    return this._map.delete(formatGraphStoreCacheKey(key));
  }

  async invalidate(match: GraphStoreInvalidation): Promise<number> {
    let removed = 0;
    for (const [k, entry] of [...this._map.entries()]) {
      const key = entry.key;
      if (match.providerId && key.providerId !== match.providerId) continue;
      if (match.sourceId && key.sourceId !== match.sourceId) continue;
      if (match.scope && key.scope !== match.scope) continue;
      if (match.variant && key.variant !== match.variant) continue;
      this._map.delete(k);
      removed++;
    }
    return removed;
  }
}

/**
 * Scope a resolved credential bag down to exactly the logical keys THIS source
 * declared under its own `credentials:` block (#203). `source.credentialEnv` —
 * produced alongside `source.credentials` by {@link module:lib/composite-config}
 * — is the authoritative allowlist of keys `normalizeCompositeConfig` actually
 * resolved for this entry; anything else on `source.credentials` is dropped
 * rather than trusted. Defense in depth: a provider module is untrusted,
 * dynamically-imported code (see the Trust boundary docs), so even a future
 * caller/refactor that accidentally attaches extra keys to `source.credentials`
 * (e.g. by sharing an object reference across sources) can never widen what a
 * given provider receives beyond what its own config entry declared.
 */
function scopeCredentialsToSource(source: NormalizedSource): Record<string, string> {
  const bag = source.credentials;
  if (!bag || typeof bag !== 'object') return {};
  const declaredKeys = source.credentialEnv && typeof source.credentialEnv === 'object'
    ? Object.keys(source.credentialEnv)
    : Object.keys(bag);
  const scoped: Record<string, string> = {};
  for (const key of declaredKeys) {
    if (Object.prototype.hasOwnProperty.call(bag, key)) scoped[key] = bag[key];
  }
  return scoped;
}

/** Build the {@link ExternalProviderConfig} handed to a provider factory. */
export function buildProviderConfig(source: NormalizedSource): ExternalProviderConfig {
  const options: Record<string, unknown> = { ...source.options };
  // Resolved secrets ride under options.credentials (never the raw env names) —
  // and only the ones declared for THIS source (#203); never a broader bag.
  const credentials = scopeCredentialsToSource(source);
  if (Object.keys(credentials).length > 0) {
    options.credentials = credentials;
  }
  const config: ExternalProviderConfig = { type: (source.kind ?? 'custom') as ExternalProviderConfig['type'], options };
  if (source.name ?? source.sourceId) config.name = source.name ?? source.sourceId;
  const optionCluster = typeof source.options?.cluster === 'string' ? source.options.cluster : undefined;
  if (source.cluster ?? optionCluster)
    config.cluster = source.cluster ?? optionCluster;
  if (source.module) config.module = source.module;
  return config;
}

/**
 * Default provider loader: dynamic-import `source.module`, guard it with
 * {@link checkProviderCompatibility}, and return its factory. Injectable so the
 * engine stays hermetic under test.
 *
 * @param {object} source   Normalized source entry.
 * @param {{ cwd?: string, importer?: (spec:string)=>Promise<any> }} [ctx]
 * @returns {Promise<Function>} ProviderFactory
 */
export async function defaultLoadProvider(
  source: NormalizedSource,
  ctx: ProviderLoadContext = {},
): Promise<ProviderFactory> {
  if (!source.module) {
    throw new CompositeIngestError(
      `Source "${source.sourceId}" has no "module" and no host resolver was supplied for kind "${source.kind}".`,
      { code: CompositeIngestErrorCode.PROVIDER_LOAD_FAILED, sourceId: source.sourceId }
    );
  }
  const importer = ctx.importer ?? ((spec: string) => import(spec));
  let mod: unknown;
  try {
    mod = await importer(source.module);
  } catch (cause) {
    throw new CompositeIngestError(
      `Failed to import provider module "${source.module}" for source "${source.sourceId}": ${toErrorMessage(cause)}`,
      { code: CompositeIngestErrorCode.PROVIDER_LOAD_FAILED, sourceId: source.sourceId, cause }
    );
  }
  const moduleRecord = (mod ?? {}) as {
    apiVersion?: string;
    capabilities?: ProviderCapability[];
    default?: unknown;
  };
  const { compatible, reason } = checkProviderCompatibility(
    { apiVersion: moduleRecord.apiVersion, capabilities: moduleRecord.capabilities },
    { apiVersion: PROVIDER_API_VERSION, capabilities: [...HOST_CAPABILITIES] as ProviderCapability[] }
  );
  if (!compatible) {
    throw new CompositeIngestError(
      `Provider module "${source.module}" (source "${source.sourceId}") is incompatible: ${reason}`,
      { code: CompositeIngestErrorCode.PROVIDER_INCOMPATIBLE, sourceId: source.sourceId }
    );
  }
  const factory = moduleRecord.default ?? mod;
  if (typeof factory !== 'function') {
    throw new CompositeIngestError(
      `Provider module "${source.module}" (source "${source.sourceId}") has no default-export factory function.`,
      { code: CompositeIngestErrorCode.PROVIDER_LOAD_FAILED, sourceId: source.sourceId }
    );
  }
  return factory as ProviderFactory;
}

/**
 * Order provider entries so every provider runs after the providers it depends
 * on. Stable by config order for ties (Kahn's algorithm over `dependencies`,
 * which reference provider ids). Returns dependency *levels*: entries within a
 * level are mutually independent and may run concurrently.
 *
 * Unknown dependency ids are ignored (a provider may depend on a provider not
 * present in this composite build).
 *
 * @param {Array<{ sourceId:string, provider:{ id:string, dependencies?:string[] } }>} entries
 * @returns {Array<Array<object>>} levels in resolution order
 * @throws {CompositeIngestError} DEPENDENCY_CYCLE
 */
export function planLevels(entries: readonly ProviderEntry[]): ProviderEntry[][] {
  const byProviderId = new Map<string, ProviderEntry>();
  for (const e of entries) {
    if (!byProviderId.has(e.provider.id)) byProviderId.set(e.provider.id, e);
  }
  const indegree = new Map<ProviderEntry, number>();
  const dependents = new Map<ProviderEntry, ProviderEntry[]>();
  for (const e of entries) indegree.set(e, 0);
  for (const e of entries) {
    const deps = Array.isArray(e.provider.dependencies) ? e.provider.dependencies : [];
    for (const depId of deps) {
      const depEntry = byProviderId.get(depId);
      if (!depEntry || depEntry === e) continue;
      indegree.set(e, (indegree.get(e) ?? 0) + 1);
      if (!dependents.has(depEntry)) dependents.set(depEntry, []);
      dependents.get(depEntry)?.push(e);
    }
  }
  const levels: ProviderEntry[][] = [];
  let frontier = entries.filter((e) => indegree.get(e) === 0);
  let remaining = entries.length;
  while (frontier.length) {
    levels.push(frontier);
    remaining -= frontier.length;
    const next = [];
    for (const e of frontier) {
      for (const dep of dependents.get(e) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 0) - 1);
        if (indegree.get(dep) === 0) next.push(dep);
      }
    }
    // Preserve config order within each level.
    next.sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
    frontier = next;
  }
  if (remaining > 0) {
    const stuck = entries.filter((e) => (indegree.get(e) ?? 0) > 0).map((e) => e.sourceId);
    throw new CompositeIngestError(
      `Provider dependency cycle detected among sources: ${stuck.join(', ')}.`,
      { code: CompositeIngestErrorCode.DEPENDENCY_CYCLE }
    );
  }
  return levels;
}

/** Run `tasks` with at most `limit` in flight; results returned in input order. */
async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(limit, 1), items.length || 1))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    });
  await Promise.all(runners);
  return results;
}

/** Resolve a provider with an optional per-provider timeout budget. */
async function resolveWithTimeout(
  provider: GraphProvider,
  context: ProviderContext,
  timeoutMs: number | undefined,
  sourceId: string,
): Promise<ProviderResult> {
  if (!timeoutMs) return provider.resolve(context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<ProviderResult>([
      provider.resolve(context),
      new Promise<ProviderResult>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CompositeIngestError(
              `Source "${sourceId}" exceeded the ${timeoutMs}ms provider timeout budget.`,
              { code: CompositeIngestErrorCode.PROVIDER_TIMEOUT, sourceId }
            )
          );
        }, timeoutMs);
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stable comparator helper. */
function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Qualify bare provider node ids/edge endpoints to the CLI's historical
 * `kg://...` graph identity shape. Newer provider releases surface plain ids
 * (e.g. `doc-a`) for rich-markdown fragments, but the rest of this CLI's graph
 * layer and its tests still assume a `kg://` URN-style identity. Keep that
 * contract intact here rather than silently changing downstream graph semantics.
 */
function qualifyGraphRef(ref: string): string;
function qualifyGraphRef<T>(ref: T): T;
function qualifyGraphRef(ref: unknown): unknown {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('kg://')) return ref;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref;
  return `kg://${ref}`;
}

/**
 * Merge per-source provider results into one deterministic, source-qualified
 * KBGraph. No dedupe / no minting — all nodes & edges are kept and tagged with
 * provenance (`node.provider` falls back to the originating sourceId).
 *
 * @param {Array<{ sourceId:string, nodes:object[], edges:object[], access?:object }>} fragments
 * @returns {{ nodes:object[], edges:object[], clusters:object[], related:Record<string,string[]> }}
 */
export function mergeSourceQualified(fragments: readonly SourceFragment[]): CompositeGraph {
  const nodes: CompositeNode[] = [];
  const edges: KBEdge[] = [];
  for (const frag of fragments) {
    for (const node of frag.nodes ?? []) {
      // Source-qualify with `sourceId` (additive provenance) WITHOUT clobbering
      // the provider's own `provider` claim; fall back to sourceId when unset.
      // A node keeps its OWN access label; only an unlabeled node inherits the
      // composite source's label (never broadens).
      const access = inheritAccess(node.access, frag.access);
      const qualified: CompositeNode = {
        ...node,
        id: qualifyGraphRef(node.id),
        sourceId: frag.sourceId,
        provider: node.provider ?? frag.sourceId,
      };
      if (access) qualified.access = access;
      else delete qualified.access;
      nodes.push(qualified);
    }
    for (const edge of frag.edges ?? []) {
      const access = inheritAccess(edge.access, frag.access);
      const qualified: KBEdge = {
        ...edge,
        from: qualifyGraphRef(edge.from),
        to: qualifyGraphRef(edge.to),
        sourceId: frag.sourceId,
      };
      if (access) qualified.access = access;
      else delete qualified.access;
      edges.push(qualified);
    }
  }
  nodes.sort(
    (a, b) => cmp(a.sourceId ?? '', b.sourceId ?? '') || cmp(a.id, b.id) || cmp(a.title ?? '', b.title ?? '')
  );
  edges.sort(
    (a, b) =>
      cmp(a.sourceId ?? '', b.sourceId ?? '') ||
      cmp(a.from, b.from) ||
      cmp(a.to, b.to) ||
      cmp(a.type ?? '', b.type ?? '') ||
      cmp(a.relation ?? '', b.relation ?? '') ||
      cmp(a.description ?? '', b.description ?? '')
  );

  return { nodes, edges, clusters: [], related: deriveRelated(nodes, edges) };
}

/** Deterministic `related` projection (nodeId → sorted unique neighbor ids). */
function deriveRelated(nodes: readonly CompositeNode[], edges: readonly KBEdge[]): Record<string, string[]> {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const related: Record<string, Set<string>> = {};
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    (related[edge.from] ??= new Set()).add(edge.to);
    (related[edge.to] ??= new Set()).add(edge.from);
  }
  const relatedOut: Record<string, string[]> = {};
  for (const id of Object.keys(related).sort()) {
    relatedOut[id] = [...related[id]!].sort();
  }
  return relatedOut;
}

/**
 * Load a composite knowledge base from a {@link KbxCompositeConfig}.
 *
 * @param {object} rawConfig  Raw composite config (root or `{ kbx: {...} }`).
 * @param {object} [opts]
 * @param {string}   [opts.cwd]            Base dir for module resolution.
 * @param {object}   [opts.env]            Environment for credential resolution.
 * @param {Function} [opts.loadProvider]   Injectable async (source, ctx) => factory.
 * @param {Function} [opts.importer]       Injectable dynamic-import for the default loader.
 * @param {object}   [opts.kbConfig]       KBConfig passed through to providers' ProviderContext.
 * @param {Record<string,object>} [opts.sources]  Source map handed to providers.
 * @param {import('@anokye-labs/kbexplorer-core').GraphStore} [opts.store]  Optional provider-result cache (default OFF).
 * @returns {Promise<{
 *   graph: object,
 *   results: Array<{ sourceId:string, providerId:string, nodes:object[], edges:object[], cached:boolean }>,
 *   errors: Array<{ sourceId:string, code:string, message:string }>,
 *   skipped: string[],
 *   warnings: string[],
 *   stats: { sources:number, resolved:number, failed:number, nodes:number, edges:number, cacheHits:number }
 * }>}
 */
export async function loadCompositeKnowledgeBase(
  rawConfig: unknown,
  opts: LoadCompositeKnowledgeBaseOptions = {},
): Promise<LoadCompositeKnowledgeBaseResult> {
  const env = opts.env ?? process.env;
  const normalized = normalizeCompositeConfig(rawConfig, { env });
  const { ingestion } = normalized;
  const failFast = ingestion.failureMode === 'fail-fast';
  const loadProvider =
    opts.loadProvider ??
    ((source: NormalizedSource) => defaultLoadProvider(source, { cwd: opts.cwd, importer: opts.importer }));

  const warnings = [...normalized.warnings];
  const errors: CompositeErrorRecord[] = [];
  const skipped: string[] = [];

  // Budget: maxSources caps how many sources are resolved (config order).
  let sources: NormalizedSource[] = [...normalized.sources];
  if (ingestion.budgets.maxSources != null && sources.length > ingestion.budgets.maxSources) {
    const kept = sources.slice(0, ingestion.budgets.maxSources);
    for (const s of sources.slice(ingestion.budgets.maxSources)) skipped.push(s.sourceId);
    if (failFast) {
      throw new CompositeIngestError(
        `Budget exceeded: ${sources.length} sources declared but maxSources=${ingestion.budgets.maxSources}.`,
        { code: CompositeIngestErrorCode.BUDGET_EXCEEDED }
      );
    }
    warnings.push(
      `maxSources=${ingestion.budgets.maxSources} reached; skipped sources: ${skipped.join(', ')}.`
    );
    sources = kept;
  }

  // Instantiate providers (load + factory). A load failure is a provider error.
  const entries: ProviderEntry[] = [];
  for (const source of sources) {
    try {
      const factory = await loadProvider(source, { cwd: opts.cwd, importer: opts.importer });
      const provider = factory(buildProviderConfig(source));
      entries.push({ source, sourceId: source.sourceId, provider });
    } catch (err) {
      const rec = {
        sourceId: source.sourceId,
        code: err instanceof CompositeIngestError ? err.code : CompositeIngestErrorCode.PROVIDER_LOAD_FAILED,
        message: toErrorMessage(err),
      };
      if (failFast) throw err;
      errors.push(rec);
    }
  }

  const levels = planLevels(entries);

  /** @type {Array<{ sourceId:string, providerId:string, nodes:object[], edges:object[], cached:boolean }>} */
  const results: CompositeResultRecord[] = [];
  let cacheHits = 0;
  const accumulatedNodes: CompositeNode[] = []; // qualified nodes from completed levels (for ProviderContext)

  for (const level of levels) {
    const existingNodes = accumulatedNodes.slice();
    const settled = await mapWithConcurrency(level, ingestion.concurrency, async (entry) => {
      const { source, provider } = entry;
      const cacheKey: GraphStoreCacheKey = {
        scope: 'provider-result',
        providerId: provider.id,
        sourceId: source.sourceId,
        contentHash: contentHash({
          kind: source.kind,
          module: source.module,
          options: source.options,
          providerId: provider.id,
        }),
      };
      try {
        if (opts.store) {
          const hit = await opts.store.get(cacheKey);
          if (hit) {
            return { entry, result: hit.value, cached: true };
          }
        }
        const context: ProviderContext = {
          config: opts.kbConfig ?? ({} as KBConfig),
          existingNodes,
          sources: opts.sources,
        };
        const result = await resolveWithTimeout(
          provider,
          context,
          ingestion.budgets.timeoutMs,
          source.sourceId
        );
        if (opts.store) {
          await opts.store.put({ key: cacheKey, value: result });
        }
        return { entry, result, cached: false };
      } catch (err) {
        return { entry, error: err };
      }
    }) as SettledProviderResult[];

    // In fail-fast, surface the first error in config order.
    if (failFast) {
      const firstError = settled.find(isSettledProviderError);
      if (firstError) throw firstError.error;
    }

    for (const s of settled) {
      if (isSettledProviderError(s)) {
        errors.push({
          sourceId: s.entry.sourceId,
          code: s.error instanceof CompositeIngestError ? s.error.code : CompositeIngestErrorCode.PROVIDER_FAILED,
          message: toErrorMessage(s.error),
        });
        continue;
      }
      if (s.cached) cacheHits++;
      const nodes: CompositeNode[] = s.result.nodes as CompositeNode[];
      const edges: KBEdge[] = s.result.edges;
      results.push({
        sourceId: s.entry.sourceId,
        providerId: s.entry.provider.id,
        nodes,
        edges,
        cached: s.cached,
        ...(s.entry.source.access ? { access: s.entry.source.access } : {}),
      });
      for (const node of nodes) {
        const access = inheritAccess(node.access, s.entry.source.access);
        accumulatedNodes.push({
          ...node,
          sourceId: s.entry.sourceId,
          provider: node.provider ?? s.entry.sourceId,
          ...(access ? { access } : {}),
        });
      }
    }
  }

  let graph = mergeSourceQualified(results);

  // Budgets: maxNodes / maxEdges enforced on the merged totals.
  graph = enforceGraphBudgets(graph, ingestion.budgets, failFast, warnings);

  const stats = {
    sources: sources.length,
    resolved: results.length,
    failed: errors.length,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    cacheHits,
  };
  return { graph, results, errors, skipped, warnings, stats };
}

/** Apply maxNodes / maxEdges budgets to a merged graph (sorted, deterministic). */
function enforceGraphBudgets(
  graph: CompositeGraph,
  budgets: NormalizedIngestion['budgets'],
  failFast: boolean,
  warnings: string[],
): CompositeGraph {
  let { nodes, edges } = graph;
  if (budgets.maxNodes != null && nodes.length > budgets.maxNodes) {
    if (failFast) {
      throw new CompositeIngestError(
        `Budget exceeded: merged graph has ${nodes.length} nodes but maxNodes=${budgets.maxNodes}.`,
        { code: CompositeIngestErrorCode.BUDGET_EXCEEDED }
      );
    }
    warnings.push(`maxNodes=${budgets.maxNodes} reached; truncated from ${nodes.length} nodes.`);
    nodes = nodes.slice(0, budgets.maxNodes);
  }
  if (budgets.maxEdges != null && edges.length > budgets.maxEdges) {
    if (failFast) {
      throw new CompositeIngestError(
        `Budget exceeded: merged graph has ${edges.length} edges but maxEdges=${budgets.maxEdges}.`,
        { code: CompositeIngestErrorCode.BUDGET_EXCEEDED }
      );
    }
    warnings.push(`maxEdges=${budgets.maxEdges} reached; truncated from ${edges.length} edges.`);
    edges = edges.slice(0, budgets.maxEdges);
  }
  if (nodes === graph.nodes && edges === graph.edges) return graph;
  // Re-derive `related` against the surviving nodes; do NOT re-qualify (the
  // nodes/edges already carry their sourceId provenance).
  return { nodes, edges, clusters: [], related: deriveRelated(nodes, edges) };
}

/** Canonical, byte-stable serialization of a composite graph (sorted keys + trailing newline). */
export function serializeCompositeGraph(graph: KBGraph): string {
  return canonicalStringify(graph);
}

/**
 * Persist a composite graph to the git working tree as a canonical JSON file
 * (no SQLite backing). Returns the absolute path written.
 *
 * @param {object} graph
 * @param {{ outDir:string, fileName?:string }} options
 * @returns {string}
 */
export function persistCompositeKnowledgeBase(
  graph: KBGraph,
  options: { outDir: string; fileName?: string },
): string {
  const { outDir, fileName = 'composite-graph.json' } = options ?? {};
  if (!outDir)
    throw new CompositeIngestError('persistCompositeKnowledgeBase requires an "outDir".', {
      code: CompositeIngestErrorCode.PROVIDER_FAILED,
    });
  mkdirSync(outDir, { recursive: true });
  const file = resolvePath(outDir, fileName);
  writeFileSync(file, serializeCompositeGraph(graph), 'utf-8');
  return file;
}
