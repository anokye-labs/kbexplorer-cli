/**
 * Affected-source dispatch engine (E2-M3 / issue #136).
 *
 * Generalizes the git-`affected` computation (src/lib/affected.js, which maps a
 * git diff to the content nodes that *cite* changed files) into a host-neutral,
 * **content-hash + derivation** dispatch that works for any source kind in the
 * composite graph (#134, src/lib/composite-*).
 *
 * The recompute signal is the one {@link Derivation} (#24) was built for: a
 * change to an input's {@link SourceRef.contentHash} — never a clock. Given the
 * current composite graph and a prior committed baseline, the engine:
 *
 *   1. **Dirty-input detection (source-input granularity).** Each node/edge
 *      carries provenance inputs ({@link Derivation.inputs} +
 *      {@link Provenance.sourceRefs} + evidence refs). Each input is fingerprinted
 *      by its stable `href` → `formatContentHash(contentHash)`. An input is
 *      *dirty* when its fingerprint was added or changed versus the baseline.
 *   2. **Seed selection (node/edge granularity).** A node/edge is a *seed* when
 *      any of its inputs is dirty.
 *   3. **Transitive closure** over `Derivation.inputs` (intra-graph
 *      producer → consumer: a node whose identity `href` is another node's input)
 *      AND graph edges (`from` → `to`). The affected set is every node reachable
 *      downstream from a seed, plus the seeds.
 *
 * **No prior state ⇒ full build.** When the baseline is absent/empty (first run,
 * nothing committed), every node is treated as affected — there is nothing to
 * diff against, so everything must be (re)generated.
 *
 * Pure & deterministic: no I/O, no network, no timestamps. Identical inputs →
 * byte-identical output; all returned arrays are sorted & de-duplicated, so the
 * computation is idempotent. Baseline acquisition (reading the committed graph at
 * a git ref) is the caller's concern — see {@link module:commands/affected}.
 *
 * @module lib/affected-graph
 */

import { formatContentHash } from '@anokye-labs/kbexplorer-core';
import type { Derivation, Evidence, KBEdge, KBGraph, KBNode, Provenance, SourceRef } from '@anokye-labs/kbexplorer-core';

interface ItemLike {
  id?: unknown;
  '@id'?: unknown;
  address?: unknown;
  href?: unknown;
  derivation?: Derivation;
  provenance?: Provenance;
  sourceRefs?: SourceRef[];
  evidence?: Array<Evidence | null | undefined>;
}

interface EdgeLike extends ItemLike {
  from?: string | { '@id'?: string; id?: string } | null;
  to?: string | { '@id'?: string; id?: string } | null;
}

interface GraphLike {
  nodes?: ItemLike[];
  edges?: EdgeLike[];
}

interface InputIndex {
  fingerprints: Map<string, string>;
  consumers: Map<string, Set<string>>;
  keys: Set<string>;
}

interface AffectedResult {
  full: boolean;
  dirtyInputs: string[];
  addedInputs: string[];
  changedInputs: string[];
  removedInputs: string[];
  seeds: string[];
  affected: string[];
  nodeCount: number;
}

/** Stable string comparator. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, de-duplicated copy of an iterable of strings. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(cmp);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function isSourceRef(ref: unknown): ref is SourceRef {
  return isObject(ref) && typeof ref.href === 'string' && ref.href.length > 0;
}

/**
 * The stable identity locator of a node/edge, used to chain derivations: a node
 * "produces" this href, and any other node listing it as a {@link Derivation}
 * input depends on it. Accepts the internal (`id`) and JSON-LD (`@id`) shapes.
 *
 * @param {object} item
 * @returns {string|undefined}
 */
export function itemKey(item: ItemLike | null | undefined): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const key = item.id ?? item['@id'] ?? item.address ?? item.href;
  return typeof key === 'string' && key ? key : undefined;
}

/**
 * Gather every provenance input ({@link SourceRef}) a node/edge depends on,
 * across the additive provenance surfaces a fact may carry:
 *   - `derivation.inputs[]`         (how it was computed — the canonical signal)
 *   - `provenance.sourceRefs[]`     (pointers back to source resources)
 *   - `sourceRefs[]`                (top-level provenance, as some engines attach)
 *   - `provenance.evidence[].ref`   (observed support)
 *   - `evidence[].ref`              (top-level observed support)
 *
 * Liberal-in to stay forward-compatible with how the composite/connect engines
 * attach provenance. Returns the raw refs (order-insensitive downstream).
 *
 * @param {object} item
 * @returns {Array<object>} SourceRef[]
 */
export function extractInputRefs(item: ItemLike | null | undefined): SourceRef[] {
  if (!item || typeof item !== 'object') return [];
  const refs: SourceRef[] = [];
  const push = (ref: unknown) => {
    if (isSourceRef(ref)) refs.push(ref);
  };
  const der = item.derivation;
  if (der && Array.isArray(der.inputs)) der.inputs.forEach(push);
  const prov = item.provenance;
  if (prov && Array.isArray(prov.sourceRefs)) prov.sourceRefs.forEach(push);
  if (Array.isArray(item.sourceRefs)) item.sourceRefs.forEach(push);
  const evidences: Array<Evidence | null | undefined> = [
    ...(prov && Array.isArray(prov.evidence) ? prov.evidence : []),
    ...(Array.isArray(item.evidence) ? item.evidence : []),
  ];
  for (const ev of evidences) push(ev && ev.ref);
  return refs;
}

/**
 * Deterministic fingerprint of a single {@link SourceRef}: its content hash
 * rendered via the core's canonical {@link formatContentHash}, or the empty
 * string when no hash is recorded. An input with no hash on either side is
 * stable; gaining/losing/altering a hash is a change.
 *
 * @param {object} ref SourceRef
 * @returns {string}
 */
export function refFingerprint(ref: SourceRef | null | undefined): string {
  if (ref && ref.contentHash && typeof ref.contentHash === 'object') {
    try {
      return formatContentHash(ref.contentHash);
    } catch {
      // Malformed hash — fall through to the unhashed sentinel.
    }
  }
  return '';
}

/**
 * Fold a graph's nodes (and edges) into the structures the diff/closure need:
 *   - `fingerprints`  href → combined fingerprint of every ref seen for that href
 *                     (sorted-unique join, so a change to ANY occurrence flips it)
 *   - `consumers`     input href → Set of node/edge keys that list it as an input
 *   - `producers`     node/edge key → itself (identity hrefs that other nodes can
 *                     name as inputs, enabling intra-graph derivation chaining)
 *
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @returns {{ fingerprints: Map<string,string>, consumers: Map<string,Set<string>>, keys: Set<string> }}
 */
export function buildInputIndex(graph: GraphLike = {}): InputIndex {
  const items: ItemLike[] = [...(graph.nodes ?? []), ...(graph.edges ?? [])];
  /** @type {Map<string, Set<string>>} */
  const fpParts = new Map();
  /** @type {Map<string, Set<string>>} */
  const consumers = new Map();
  const keys = new Set<string>();

  for (const item of items) {
    const key = itemKey(item);
    if (key) keys.add(key);
    for (const ref of extractInputRefs(item)) {
      const href = ref.href;
      if (!fpParts.has(href)) fpParts.set(href, new Set());
      fpParts.get(href).add(refFingerprint(ref));
      if (key) {
        if (!consumers.has(href)) consumers.set(href, new Set());
        consumers.get(href).add(key);
      }
    }
  }

  const fingerprints = new Map();
  for (const [href, parts] of fpParts) {
    fingerprints.set(href, [...parts].sort(cmp).join('|'));
  }
  return { fingerprints, consumers, keys };
}

/**
 * Derive the baseline fingerprint map from a prior graph object. A convenience
 * for callers that load the committed graph at `--since <ref>`.
 *
 * @param {{ nodes?: object[], edges?: object[] }} priorGraph
 * @returns {Map<string,string>}
 */
export function baselineFromGraph(priorGraph: GraphLike): Map<string, string> {
  return buildInputIndex(priorGraph).fingerprints;
}

/**
 * Compare current input fingerprints against a baseline map. An href is dirty
 * when it is new (absent from baseline) or its fingerprint changed. Removed
 * hrefs (in baseline, gone from current) are reported separately — they affect
 * cleanup, not the regeneration of surviving nodes — and never seed the set.
 *
 * @param {Map<string,string>} current
 * @param {Map<string,string>} baseline
 * @returns {{ dirty: string[], added: string[], changed: string[], removed: string[] }}
 */
export function diffFingerprints(
  current: Map<string, string>,
  baseline: Map<string, string>,
): { dirty: string[]; added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [href, fp] of current) {
    if (!baseline.has(href)) added.push(href);
    else if (baseline.get(href) !== fp) changed.push(href);
  }
  for (const href of baseline.keys()) {
    if (!current.has(href)) removed.push(href);
  }
  return {
    dirty: sortedUnique([...added, ...changed]),
    added: added.sort(cmp),
    changed: changed.sort(cmp),
    removed: removed.sort(cmp),
  };
}

/**
 * Build the downstream dependency adjacency (producer key → Set of dependent
 * keys) from intra-graph derivations and graph edges. An edge A→B and a node B
 * deriving from A's identity href both mean "B is downstream of A".
 *
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {{ consumers: Map<string,Set<string>>, keys: Set<string> }} index
 * @returns {Map<string, Set<string>>}
 */
function buildDownstream(graph: GraphLike, index: InputIndex): Map<string, Set<string>> {
  /** @type {Map<string, Set<string>>} */
  const down = new Map();
  const link = (from: string | undefined, to: string | undefined) => {
    if (!from || !to || from === to) return;
    if (!down.has(from)) down.set(from, new Set());
    down.get(from).add(to);
  };

  // Intra-graph derivation chaining: input href that is itself a node/edge key
  // means that producer is upstream of every consumer listing it as an input.
  for (const [href, consumerKeys] of index.consumers) {
    if (!index.keys.has(href)) continue;
    for (const consumer of consumerKeys) link(href, consumer);
  }

  // Graph edges: from → to is the canonical downstream channel.
  for (const edge of graph.edges ?? []) {
    const from = edgeEndpoint(edge && edge.from);
    const to = edgeEndpoint(edge && edge.to);
    link(from, to);
  }
  return down;
}

/** Coerce an edge endpoint (string id or `{ '@id' }`/`{ id }` object) to a key. */
function edgeEndpoint(end: EdgeLike['from']): string | undefined {
  if (typeof end === 'string') return end;
  if (end && typeof end === 'object') {
    const k = end['@id'] ?? end.id;
    return typeof k === 'string' ? k : undefined;
  }
  return undefined;
}

/**
 * Deterministic transitive closure of `seeds` over the `down` adjacency.
 *
 * @param {Iterable<string>} seeds
 * @param {Map<string, Set<string>>} down
 * @returns {string[]} sorted unique reachable keys (seeds included)
 */
export function closure(seeds: Iterable<string>, down: Map<string, Set<string>>): string[] {
  const seen = new Set<string>();
  // Sort the frontier for a stable visitation order (output is sorted anyway,
  // but a deterministic walk keeps the computation itself reproducible).
  const stack = sortedUnique(seeds);
  while (stack.length) {
    const key = stack.pop();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const next = down.get(key);
    if (next) for (const n of [...next].sort(cmp)) if (!seen.has(n)) stack.push(n);
  }
  return sortedUnique(seen);
}

/**
 * Compute the affected set for a composite graph against a prior baseline.
 *
 * @param {object} options
 * @param {{ nodes?: object[], edges?: object[] }} options.graph  Current composite graph.
 * @param {Map<string,string>|null} [options.baseline]  Prior input fingerprints
 *   (e.g. from {@link baselineFromGraph}). `null`/empty ⇒ full build.
 * @returns {{
 *   full: boolean,
 *   dirtyInputs: string[],
 *   addedInputs: string[],
 *   changedInputs: string[],
 *   removedInputs: string[],
 *   seeds: string[],
 *   affected: string[],
 *   nodeCount: number,
 * }}
 */
/**
 * Convenience wrapper: compute the affected set from a current graph and an
 * optional prior (baseline) graph. An absent/empty baseline graph ⇒ full build.
 *
 * @param {{ nodes?: object[], edges?: object[] }} currentGraph
 * @param {{ nodes?: object[], edges?: object[] }|null} [baselineGraph]
 * @returns {ReturnType<typeof computeAffected>}
 */
export function affectedFromGraphs(
  currentGraph: GraphLike,
  baselineGraph: GraphLike | null = null,
): AffectedResult {
  const hasBaseline =
    baselineGraph &&
    ((baselineGraph.nodes && baselineGraph.nodes.length) ||
      (baselineGraph.edges && baselineGraph.edges.length));
  const baseline = hasBaseline ? baselineFromGraph(baselineGraph) : null;
  return computeAffected({ graph: currentGraph ?? {}, baseline });
}

export function computeAffected(
  {
    graph = {},
    baseline = null,
  }: {
    graph?: GraphLike;
    baseline?: Map<string, string> | null;
  } = {},
): AffectedResult {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const allKeys = sortedUnique(
    [...nodes, ...edges].map(itemKey).filter((k) => typeof k === 'string')
  );

  // No prior state ⇒ everything is affected (full build). Documented contract.
  if (!baseline || baseline.size === 0) {
    return {
      full: true,
      dirtyInputs: [],
      addedInputs: [],
      changedInputs: [],
      removedInputs: [],
      seeds: allKeys,
      affected: allKeys,
      nodeCount: nodes.length,
    };
  }

  const index = buildInputIndex(graph);
  const { dirty, added, changed, removed } = diffFingerprints(index.fingerprints, baseline);

  // Seeds: any node/edge whose inputs intersect the dirty href set.
  const dirtySet = new Set(dirty);
  const seedSet = new Set<string>();
  for (const href of dirtySet) {
    const consumerKeys = index.consumers.get(href);
    if (consumerKeys) for (const k of consumerKeys) seedSet.add(k);
  }

  const down = buildDownstream(graph, index);
  const affected = closure(seedSet, down);

  return {
    full: false,
    dirtyInputs: dirty,
    addedInputs: added,
    changedInputs: changed,
    removedInputs: removed,
    seeds: sortedUnique(seedSet),
    affected,
    nodeCount: nodes.length,
  };
}
