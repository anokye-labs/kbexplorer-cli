/**
 * Referent conflation engine (E3-C2 / issue #138).
 *
 * `conflateReferents` groups nodes that refer to the SAME real-world referent
 * (a person, team or service that appears across multiple sources) into ONE
 * node carrying multiple source-pointers — generalizing the legacy
 * `person.linked` witness. It reads the identity substrate E1 put on nodes,
 * specifically {@link KBNode.identityClaims}, the signal the edge-minting
 * engine (#137) deliberately left untouched.
 *
 * Operation 2 of §13 cross-source connection. Narrow, deterministic, and
 * conflict-preserving — **no** confidence thresholds, **no** duplicate-artifact
 * merging, **no** attribute-winner picking.
 *
 * Grouping rules:
 *
 *  • `same-as` is the ONLY positive merge signal — strict identity. Each
 *    `same-as` claim is resolved (via the same tiered index as edge-mint:
 *    identity URN › node id › `sourceRefs[].href`) to a target node and the two
 *    nodes are unioned (union-find). Dangling/ambiguous claim refs are ignored.
 *
 *  • `equivalent-to` does NOT merge. It asserts equivalence *without* strict
 *    identity (two distinct referents, equivalent in some respect) — a future
 *    equivalence *edge*, not a conflation. It is preserved verbatim on the
 *    conflated node's unioned `identityClaims` and never collapses identity.
 *
 *  • `differentiated-from` is a HARD negative constraint: an unordered pair that
 *    must never share a referent. If a positive component ever contains a
 *    forbidden pair (e.g. *A same-as B* but *B differentiated-from A*), the
 *    hard negative wins: the WHOLE component is left unconflated (conservative,
 *    deterministic, conflict-preserving) and an informative, stably-ordered
 *    contradiction warning is emitted naming the component members and the
 *    specific blocking pair(s). Surgical edge-cutting is intentionally avoided
 *    because it would be nondeterministic.
 *
 * The conflated node (lossless):
 *   - identity/id from a deterministic representative — prefer a member with an
 *     `identity` URN, then the lexicographically smallest `identity`, tiebreak
 *     smallest `id`.
 *   - the union (dedup + sorted) of every member's `sourceRefs`, `evidence`,
 *     `identityClaims` and `linkedRefs` — "one node, many source-pointers".
 *   - `conflatedFrom[]`: every member's `{ id, identity, sourceId, sourceRefs }`
 *     — nothing is lost; this is the input #139 ranks by `SourcePrecedenceConfig`.
 *   - `derivation: { mode:'derived', generator:'conflate@1', inputs:[...] }`.
 *   - scalar attributes (`title` / `cluster` / `content` …) are kept verbatim
 *     from the representative as a PLACEHOLDER. Resolving conflicting scalar
 *     attribute values across members is **#139's** job (SoR-precedence), not
 *     this engine's — #138 groups and unions, it never picks attribute winners.
 *
 * Edges are repointed from merged-away members to the representative, deduped
 * by {@link buildEdgeId} with provenance-merge, and intra-referent self-loops
 * created by the merge are dropped.
 *
 * Deterministic & idempotent: identical inputs → byte-identical output. Only
 * groups of size > 1 are transformed; singleton nodes pass through verbatim, so
 * re-running over an already-conflated graph (whose representative still carries
 * historical `same-as` claims to now-removed members — which resolve dangling
 * and are ignored) yields the identical graph. No timestamps anywhere.
 *
 * @module lib/conflation
 */

import { buildEdgeId, mapRelation } from '@anokye-labs/kbexplorer-core';
import { canonicalStringify } from './jsonld.ts';
import { buildResolutionIndex, resolveLinkedRef } from './edge-mint.ts';
import { mergeAccessLabels, normalizeAccessLabel } from './access-label.ts';

/** Versioned id of the deriving process, recorded on every conflated node. */
export const CONFLATE_GENERATOR = 'conflate@1';

/** Canonical fallback relation when an edge carries no usable relation. */
const FALLBACK_RELATION = 'structural';

/**
 * Node fields that are structural / identity / already-unioned-provenance and
 * are therefore NEVER snapshotted as resolvable attribute values. Everything
 * else on a member node (title, cluster, content, rawContent, emoji, image,
 * sprite, display, data, and any custom attribute) is captured so the
 * SoR-precedence engine (#139) can rank competing values per field.
 */
const NON_ATTRIBUTE_FIELDS = new Set([
  'id',
  'identity',
  'source',
  'sourceId',
  'provider',
  'parent',
  'nodeType',
  'connections',
  'sourceRefs',
  'evidence',
  'identityClaims',
  'linkedRefs',
  'derivation',
  'derived',
  'conflatedFrom',
  'precedence',
  'entityType',
  'jsonld',
  'access',
  'pageTheme',
]);

/**
 * Snapshot a member node's precedence-eligible attribute values (a shallow copy
 * of every own field except the structural/identity set above), with keys in
 * stable sorted order. Lossless: this preserves the scalar values that would
 * otherwise be dropped when a non-representative member is conflated away, so
 * #139 can resolve conflicting attributes deterministically.
 *
 * @param {object} node
 * @returns {Record<string, unknown>}
 */
export function snapshotAttributes(node) {
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (NON_ATTRIBUTE_FIELDS.has(key)) continue;
    out[key] = node[key];
  }
  return out;
}

/** Stable comparator helper. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable, order-independent dedupe of a provenance array. */
function uniqueSorted(items) {
  const seen = new Map();
  for (const item of items ?? []) {
    const key = canonicalStringify(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, v]) => v);
}

/** Minimal deterministic union-find over node-id strings. */
class UnionFind {
  constructor(ids) {
    this.parent = new Map();
    for (const id of ids) this.parent.set(id, id);
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path-compress.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic: smaller id becomes the root.
    if (cmp(ra, rb) <= 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

/**
 * Pick the deterministic representative of a group of member nodes: prefer a
 * member with an `identity` URN, then the lexicographically smallest
 * `identity`, tiebreak by smallest `id`.
 *
 * @param {object[]} members
 * @returns {object}
 */
export function pickRepresentative(members) {
  return [...members].sort((a, b) => {
    const ai = a.identity ? 0 : 1;
    const bi = b.identity ? 0 : 1;
    return ai - bi || cmp(a.identity ?? '', b.identity ?? '') || cmp(a.id, b.id);
  })[0];
}

/** Deterministic key identifying an edge by endpoints + relation. */
function edgeKey(edge) {
  const relation = edge.relation ?? mapRelation(edge.type).relation ?? FALLBACK_RELATION;
  return buildEdgeId(edge.from, relation, edge.to);
}

/** Final, stable edge comparator (mirrors the union-graph order). */
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

/**
 * Conflate same-referent nodes into single nodes with multiple source-pointers.
 *
 * @param {{ nodes: object[], edges?: object[] }} graph
 * @param {object} [opts]
 * @param {string} [opts.generator]  Override the recorded derivation generator id.
 * @returns {{
 *   graph: object,
 *   groups: Array<{ representative: string, identity?: string, members: string[] }>,
 *   stats: { inputNodes:number, conflatedGroups:number, mergedNodes:number,
 *            contradictions:number, edgesRepointed:number, edgesDropped:number, edgesDeduped:number },
 *   warnings: string[]
 * }}
 */
export function conflateReferents(graph, opts = {}) {
  const generator = opts.generator ?? CONFLATE_GENERATOR;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const byId = new Map(nodes.filter((n) => n && n.id != null).map((n) => [n.id, n]));
  const index = buildResolutionIndex(nodes);

  const uf = new UnionFind([...byId.keys()]);
  /** @type {Set<string>} unordered "a\u0000b" forbidden pairs (a<b). */
  const forbidden = new Set();
  const pairKey = (a, b) => (cmp(a, b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`);

  // Process identity claims. Sort source nodes for deterministic union order.
  const claimants = [...byId.values()]
    .filter((n) => Array.isArray(n.identityClaims) && n.identityClaims.length > 0)
    .sort((a, b) => cmp(a.id, b.id));
  for (const node of claimants) {
    for (const claim of node.identityClaims) {
      const resolved = resolveLinkedRef(claim?.ref, index);
      if (!('id' in resolved)) continue; // dangling or ambiguous → ignore
      const targetId = resolved.id;
      if (targetId === node.id) continue;
      if (claim.claim === 'same-as') uf.union(node.id, targetId);
      else if (claim.claim === 'differentiated-from') forbidden.add(pairKey(node.id, targetId));
      // 'equivalent-to' and any other kind: no merge (preserved via union of claims).
    }
  }

  // Gather components by root.
  const components = new Map();
  for (const id of byId.keys()) {
    const root = uf.find(id);
    (components.get(root) ?? components.set(root, []).get(root)).push(id);
  }

  const warnings = [];
  const removedIds = new Set(); // non-representative members of conflated groups
  const conflatedByRepId = new Map();
  const remap = new Map(); // member id → representative id
  const groups = [];
  let contradictions = 0;

  for (const [, memberIds] of [...components.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (memberIds.length < 2) continue; // singleton → verbatim
    const sortedMemberIds = [...memberIds].sort();

    // Negative-constraint validation: any forbidden pair fully inside this
    // component blocks the whole merge.
    const blocking = [];
    for (const pk of forbidden) {
      const [a, b] = pk.split('\u0000');
      if (sortedMemberIds.includes(a) && sortedMemberIds.includes(b)) blocking.push([a, b]);
    }
    if (blocking.length > 0) {
      contradictions++;
      const pairs = blocking
        .map(([a, b]) => `${a}<->${b}`)
        .sort()
        .join(', ');
      warnings.push(
        `conflation contradiction: component {${sortedMemberIds.join(', ')}} not conflated; ` +
          `blocked by differentiated-from pair(s): ${pairs}.`
      );
      continue; // leave every member as a distinct, untouched node
    }

    const members = sortedMemberIds.map((id) => byId.get(id));
    const rep = pickRepresentative(members);
    groups.push({
      representative: rep.id,
      ...(rep.identity ? { identity: rep.identity } : {}),
      members: sortedMemberIds,
    });

    const allSourceRefs = uniqueSorted(members.flatMap((m) => m.sourceRefs ?? []));
    // A conflated referent's access is the MOST-RESTRICTIVE label among its
    // members (intersect / never broaden). Member labels are not lost — each is
    // preserved on its `conflatedFrom[]` entry.
    const mergedAccess = mergeAccessLabels(members.map((m) => m.access));
    const conflated = {
      ...rep,
      sourceRefs: allSourceRefs,
      evidence: uniqueSorted(members.flatMap((m) => m.evidence ?? [])),
      identityClaims: uniqueSorted(members.flatMap((m) => m.identityClaims ?? [])),
      linkedRefs: uniqueSorted(members.flatMap((m) => m.linkedRefs ?? [])),
      conflatedFrom: sortedMemberIds.map((id) => {
        const m = byId.get(id);
        const entry = { id: m.id };
        if (m.identity) entry.identity = m.identity;
        if (m.sourceId != null) entry.sourceId = m.sourceId;
        if (m.sourceRefs?.length) entry.sourceRefs = uniqueSorted(m.sourceRefs);
        const memberAccess = normalizeAccessLabel(m.access);
        if (memberAccess) entry.access = memberAccess;
        entry.attributes = snapshotAttributes(m);
        return entry;
      }),
      derivation: { mode: 'derived', generator, inputs: allSourceRefs },
    };
    if (mergedAccess) conflated.access = mergedAccess;
    else delete conflated.access;
    // Drop empty unioned arrays so absent-everywhere fields stay absent (keeps
    // singletons-vs-conflated output shapes consistent and re-runs byte-stable).
    for (const key of ['sourceRefs', 'evidence', 'identityClaims', 'linkedRefs']) {
      if (Array.isArray(conflated[key]) && conflated[key].length === 0) delete conflated[key];
    }

    conflatedByRepId.set(rep.id, conflated);
    for (const id of sortedMemberIds) {
      remap.set(id, rep.id);
      if (id !== rep.id) removedIds.add(id);
    }
  }

  // Build the output node list: replace representatives with conflated nodes,
  // drop merged-away members, pass everything else through verbatim.
  const outNodes = [];
  for (const node of nodes) {
    if (node?.id != null && removedIds.has(node.id)) continue;
    outNodes.push(conflatedByRepId.get(node?.id) ?? node);
  }
  outNodes.sort((a, b) => cmp(a.sourceId ?? '', b.sourceId ?? '') || cmp(a.id, b.id));

  // Repoint edges onto representatives, drop self-loops, dedupe with merge.
  let edgesRepointed = 0;
  let edgesDropped = 0;
  const edgeByKey = new Map();
  for (const edge of edges) {
    const from = remap.get(edge.from) ?? edge.from;
    const to = remap.get(edge.to) ?? edge.to;
    if (from !== edge.from || to !== edge.to) edgesRepointed++;
    if (from === to) {
      edgesDropped++;
      continue;
    }
    const repointed = { ...edge, from, to };
    const key = edgeKey(repointed);
    const existing = edgeByKey.get(key);
    if (!existing) {
      edgeByKey.set(key, repointed);
      continue;
    }
    // Provenance-merge on collapse (deterministic).
    if (repointed.sourceRefs || existing.sourceRefs)
      existing.sourceRefs = uniqueSorted([
        ...(existing.sourceRefs ?? []),
        ...(repointed.sourceRefs ?? []),
      ]);
    if (repointed.evidence || existing.evidence)
      existing.evidence = uniqueSorted([...(existing.evidence ?? []), ...(repointed.evidence ?? [])]);
    if (existing.derivation?.inputs || repointed.derivation?.inputs)
      existing.derivation = {
        ...(existing.derivation ?? repointed.derivation),
        inputs: uniqueSorted([
          ...(existing.derivation?.inputs ?? []),
          ...(repointed.derivation?.inputs ?? []),
        ]),
      };
    // Collapsing two edges into one must never broaden access: merge labels
    // most-restrictively.
    if (repointed.access || existing.access) {
      const mergedEdgeAccess = mergeAccessLabels([existing.access, repointed.access]);
      if (mergedEdgeAccess) existing.access = mergedEdgeAccess;
      else delete existing.access;
    }
  }
  const edgesDeduped = edges.length - edgesDropped - edgeByKey.size;
  const outEdges = [...edgeByKey.values()].sort(edgeComparator);

  // Edge access carries its OWN label; an unlabeled edge derives the
  // most-restrictive label of its (post-conflation) endpoints. Never broadens.
  const accessByNodeId = new Map(outNodes.map((n) => [n.id, n.access]));
  for (const edge of outEdges) {
    if (normalizeAccessLabel(edge.access)) continue;
    const derived = mergeAccessLabels([accessByNodeId.get(edge.from), accessByNodeId.get(edge.to)]);
    if (derived) edge.access = derived;
    else delete edge.access;
  }

  warnings.sort();

  return {
    graph: { ...graph, nodes: outNodes, edges: outEdges, related: deriveRelated(outNodes, outEdges) },
    groups,
    stats: {
      inputNodes: nodes.length,
      conflatedGroups: groups.length,
      mergedNodes: removedIds.size,
      contradictions,
      edgesRepointed,
      edgesDropped,
      edgesDeduped,
    },
    warnings,
  };
}
