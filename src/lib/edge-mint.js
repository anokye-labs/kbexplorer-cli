/**
 * Reference edge-minting engine (E3-C1 / issue #137).
 *
 * `mintReferenceEdges` is the CONNECT step over the composite-ingested graph
 * (#134): it reads the identity/link substrate already carried on nodes and
 * mints typed {@link KBEdge}s between **distinct** nodes — a doc that
 * *describes* an epic, a PR that *implements* a work item. It is the
 * high-value cross-source case from §13 (operation 1).
 *
 * What it does — and pointedly does NOT do:
 *
 *  • MINT, never merge. Each minted edge connects two pre-existing, distinct
 *    nodes; no node is rewritten, deduped or conflated. Referent conflation
 *    (collapsing same-referent nodes) is a separate, later job — issue #138 —
 *    and this engine deliberately leaves it untouched.
 *
 *  • The mint signal is {@link KBNode.linkedRefs} ONLY. A `linkedRef` is a
 *    host-neutral pointer ({@link SourceRef}: `kind` / `href` / `resourceKind`
 *    / `role`) from a node to *another source resource* — exactly a
 *    cross-artifact reference. We resolve each `linkedRef.href` to a target
 *    node and, when it lands on a DISTINCT node, mint an edge.
 *
 *  • {@link KBNode.identityClaims} are EXCLUDED on purpose. A `same-as` /
 *    `equivalent-to` / `differentiated-from` claim is a *same-referent*
 *    assertion — the input to referent conflation (#138), not a structural
 *    reference. Minting edges from them would pre-empt conflation, so this
 *    engine ignores them entirely.
 *
 *  • Deterministic, NO timestamps. Identical inputs → byte-identical output.
 *    Minted edges are content-addressed via {@link SourceRef.contentHash}
 *    (never a clock), deduped by {@link buildEdgeId}, provenance-merged on
 *    collapse, and stably sorted. Re-running over a graph that already contains
 *    the minted edges is a no-op (idempotent).
 *
 * Provenance recorded on every minted edge:
 *   - `source: 'inferred'` and structural `type: 'references'`.
 *   - `relation` drawn from the `linkedRef.role` via {@link mapRelation} (the
 *     canonical six-relation taxonomy), with `relationRaw` carrying the original
 *     label verbatim ONLY when the role falls outside the taxonomy.
 *   - `sourceId` = the source-side node's `sourceId` (the system-of-record that
 *     asserted the link) — the precedence-rankable key #139 reads.
 *   - `sourceRefs` / `evidence` = the resolved `linkedRef` (observed support).
 *   - `derivation: { mode: 'derived', generator: 'edge-mint@1', inputs: [...] }`
 *     — the authoritative, content-addressed derived-fact record (rule id +
 *     version) the issue asks for.
 *
 * @module lib/edge-mint
 */

import {
  buildEdgeId,
  mapRelation,
  isKnownRelation,
  RELATION_SYNONYMS,
} from '@anokye-labs/kbexplorer-core';
import { canonicalStringify } from './jsonld.js';

/** Versioned id of the deriving process, recorded on every minted edge. */
export const EDGE_MINT_GENERATOR = 'edge-mint@1';

/** Structural edge type used for minted cross-artifact references. */
const MINTED_EDGE_TYPE = 'references';

/** Canonical fallback relation when a linkedRef carries no usable role. */
const FALLBACK_RELATION = 'structural';

/** Stable comparator helper. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve a raw `linkedRef.role` to a canonical relation plus an optional
 * `relationRaw` passthrough.
 *
 * The passthrough is set **only** when the role is outside the six-relation
 * taxonomy (and is not a recognized synonym) — never for an in-taxonomy label,
 * which would over-populate `relationRaw` per the core contract.
 *
 * @param {unknown} role
 * @returns {{ relation: string, relationRaw?: string }}
 */
export function resolveRelation(role) {
  if (role == null || String(role).trim() === '') {
    return { relation: FALLBACK_RELATION };
  }
  const norm = String(role).trim().toLowerCase();
  const { relation } = mapRelation(norm);
  const inTaxonomy =
    isKnownRelation(norm) || Object.prototype.hasOwnProperty.call(RELATION_SYNONYMS, norm);
  return inTaxonomy ? { relation } : { relation, relationRaw: String(role).trim() };
}

/**
 * Build the tiered resolution index over a node set. Each tier maps a locator
 * string to the set of node ids that advertise it, so resolution can prefer a
 * higher-confidence signal (identity URN) over a lower one (a source-ref href).
 *
 * @param {object[]} nodes
 * @returns {{ identity: Map<string,Set<string>>, id: Map<string,Set<string>>, sourceRef: Map<string,Set<string>> }}
 */
export function buildResolutionIndex(nodes) {
  const identity = new Map();
  const id = new Map();
  const sourceRef = new Map();
  const add = (map, key, nodeId) => {
    if (key == null || key === '') return;
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(nodeId);
  };
  for (const node of nodes ?? []) {
    if (!node || node.id == null) continue;
    add(id, node.id, node.id);
    if (node.identity) add(identity, node.identity, node.id);
    for (const ref of node.sourceRefs ?? []) {
      if (ref?.href) add(sourceRef, ref.href, node.id);
    }
  }
  return { identity, id, sourceRef };
}

/**
 * Resolve a `linkedRef` to a target node id.
 *
 * Tiers are tried in descending confidence — identity URN, then node id, then
 * a node's own `sourceRefs[].href`. The FIRST tier with any hit decides the
 * outcome: exactly one node ⇒ resolved; more than one ⇒ `ambiguous` (skip and
 * record, never a nondeterministic first-wins). No tier hits ⇒ `dangling`
 * (the ref points outside the graph; skip silently).
 *
 * @param {object} ref  A {@link SourceRef}.
 * @param {ReturnType<typeof buildResolutionIndex>} index
 * @returns {{ id: string } | { ambiguous: string[] } | { dangling: true }}
 */
export function resolveLinkedRef(ref, index) {
  const href = ref?.href;
  if (!href) return { dangling: true };
  for (const tier of [index.identity, index.id, index.sourceRef]) {
    const hits = tier.get(href);
    if (!hits || hits.size === 0) continue;
    if (hits.size === 1) return { id: [...hits][0] };
    return { ambiguous: [...hits].sort() };
  }
  return { dangling: true };
}

/** Stable, order-independent dedupe of a provenance array (SourceRefs / Evidence). */
function uniqueSorted(items) {
  const seen = new Map();
  for (const item of items) {
    const key = canonicalStringify(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, v]) => v);
}

/** Re-derive the `related` projection (nodeId → sorted unique neighbor ids). */
function deriveRelated(nodes, edges) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const related = {};
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    (related[edge.from] ??= new Set()).add(edge.to);
    (related[edge.to] ??= new Set()).add(edge.from);
  }
  const out = {};
  for (const nid of Object.keys(related).sort()) out[nid] = [...related[nid]].sort();
  return out;
}

/** Deterministic key identifying an edge by endpoints + relation. */
function edgeKey(edge) {
  const relation = edge.relation ?? mapRelation(edge.type).relation ?? FALLBACK_RELATION;
  return buildEdgeId(edge.from, relation, edge.to);
}

/** Final, stable edge comparator (mirrors the composite-ingest union order). */
function edgeComparator(a, b) {
  return (
    cmp(a.sourceId ?? '', b.sourceId ?? '') ||
    cmp(a.from, b.from) ||
    cmp(a.to, b.to) ||
    cmp(a.type ?? '', b.type ?? '') ||
    cmp(a.relation ?? '', b.relation ?? '') ||
    cmp(a.description ?? '', b.description ?? '')
  );
}

/**
 * Mint reference edges between distinct nodes from their `linkedRefs`.
 *
 * @param {{ nodes: object[], edges?: object[] }} graph  A composite-ingested graph.
 * @param {object} [opts]
 * @param {string} [opts.generator]  Override the recorded derivation generator id.
 * @returns {{
 *   graph: object,
 *   minted: object[],
 *   stats: { sourceNodes:number, linkedRefs:number, minted:number, deduped:number,
 *            skippedDangling:number, skippedAmbiguous:number, skippedSelf:number },
 *   warnings: string[]
 * }}
 */
export function mintReferenceEdges(graph, opts = {}) {
  const generator = opts.generator ?? EDGE_MINT_GENERATOR;
  const nodes = graph?.nodes ?? [];
  const existingEdges = graph?.edges ?? [];
  const index = buildResolutionIndex(nodes);

  // Pre-existing edges anchor dedupe: a minted edge that would collide with an
  // edge already in the graph is suppressed (keeps re-runs idempotent).
  const existingKeys = new Set(existingEdges.map(edgeKey));

  // Source-node iteration is sorted so the chosen provenance on a collapsed edge
  // is independent of input node order.
  const sourceNodes = [...nodes]
    .filter((n) => n && n.id != null && Array.isArray(n.linkedRefs) && n.linkedRefs.length > 0)
    .sort((a, b) => cmp(a.sourceId ?? '', b.sourceId ?? '') || cmp(a.id, b.id));

  const stats = {
    sourceNodes: sourceNodes.length,
    linkedRefs: 0,
    minted: 0,
    deduped: 0,
    skippedDangling: 0,
    skippedAmbiguous: 0,
    skippedSelf: 0,
  };
  const warnings = [];
  /** @type {Map<string, object>} key → minted edge (accumulates merged provenance) */
  const mintedByKey = new Map();

  for (const node of sourceNodes) {
    for (const ref of node.linkedRefs) {
      stats.linkedRefs++;
      const resolved = resolveLinkedRef(ref, index);
      if ('dangling' in resolved) {
        stats.skippedDangling++;
        continue;
      }
      if ('ambiguous' in resolved) {
        stats.skippedAmbiguous++;
        warnings.push(
          `linkedRef href="${ref.href}" on node "${node.id}" is ambiguous (matches ${resolved.ambiguous.join(', ')}); skipped.`
        );
        continue;
      }
      const targetId = resolved.id;
      if (targetId === node.id) {
        stats.skippedSelf++;
        continue;
      }

      const { relation, relationRaw } = resolveRelation(ref.role);
      const key = buildEdgeId(node.id, relation, targetId);
      if (existingKeys.has(key)) {
        stats.deduped++;
        continue;
      }

      const evidence = {
        ref,
        note: `minted from linkedRef href="${ref.href}" on node "${node.id}"`,
      };

      const existing = mintedByKey.get(key);
      if (existing) {
        // Collapse: merge provenance deterministically; keep the smallest
        // sourceId so #139 has a single, stable system-of-record to rank.
        stats.deduped++;
        existing.sourceRefs = uniqueSorted([...existing.sourceRefs, ref]);
        existing.evidence = uniqueSorted([...existing.evidence, evidence]);
        existing.derivation.inputs = uniqueSorted([...existing.derivation.inputs, ref]);
        const candidateSourceId = node.sourceId;
        if (candidateSourceId != null && cmp(candidateSourceId, existing.sourceId ?? '') < 0) {
          existing.sourceId = candidateSourceId;
        }
        continue;
      }

      /** @type {object} */
      const edge = {
        from: node.id,
        to: targetId,
        type: MINTED_EDGE_TYPE,
        description: `${node.id} ${relation} ${targetId}`,
        source: 'inferred',
        weight: 1,
        relation,
        sourceRefs: [ref],
        evidence: [evidence],
        derivation: { mode: 'derived', generator, inputs: [ref] },
      };
      if (relationRaw != null) edge.relationRaw = relationRaw;
      if (node.sourceId != null) edge.sourceId = node.sourceId;
      mintedByKey.set(key, edge);
      stats.minted++;
    }
  }

  const minted = [...mintedByKey.values()].sort(edgeComparator);
  const allEdges = [...existingEdges, ...minted].sort(edgeComparator);

  return {
    graph: { ...graph, edges: allEdges, related: deriveRelated(nodes, allEdges) },
    minted,
    stats,
    warnings,
  };
}
