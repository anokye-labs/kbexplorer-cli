/**
 * System-of-record precedence resolution (E3-C3 / issue #139).
 *
 * `resolvePrecedence` is the LAST connect step: it applies E1's declared
 * {@link SourcePrecedenceConfig} (issue #26, read from `KBConfig.precedence`) to
 * the conflated referents produced by #138, resolving the *rare* case where two
 * sources assert different values for the same attribute of one conflated node.
 * Declared precedence wins, deterministically — §13 operation 3.
 *
 * Two pillars, both load-bearing:
 *
 *  • Ordering only — NO thresholds, NO confidence scores. Each conflicting field
 *    is decided by comparing the contributing members' `sourceId`s (the
 *    documented precedence↔provenance bridge: `sourceId` is the precedence key)
 *    against the effective order — `precedence.fields[field]` when present, else
 *    the global `precedence.sources`. The value from the single highest-ranked
 *    source wins. A `sourceId` absent from the order ranks below every listed
 *    key.
 *
 *  • CONFLICT-PRESERVING where precedence does not decide. When members differ
 *    on a field but no rule yields a unique winner — no precedence config at
 *    all, the contributing sources are all unranked, or the top-ranked source
 *    disagrees with itself — the engine NEVER silently flattens. It keeps the
 *    #138 representative placeholder as the field value AND records every
 *    competing value with its `sourceId` so the conflict is auditable.
 *
 * Output is additive and lossless: a resolved node gains a `precedence` record
 *   `{ resolved: { <field>: { sourceId, value, via } }, conflicts: { <field>:
 *   [{ sourceId, value }] } }`
 * and (for decided winners) the winning value is written onto the node; the
 * `conflatedFrom[]` snapshot is never mutated.
 *
 * Resolvable attributes: the node-level scalars `title`, `cluster`, `content`,
 * `rawContent`, `emoji`, `image`, `sprite`, `display`, plus every top-level key
 * of `data` addressed by its bare name. Structural / identity / provenance
 * fields are left alone. Disambiguation when a name exists both node-level and
 * under `data`: the NODE-level field owns the name (a `fields[name]` rule
 * targets it); a `data` key only owns a name when no member has a node-level
 * field of that name.
 *
 * Deterministic & idempotent (winners + recorded conflicts are a pure function
 * of `conflatedFrom[].attributes` + config, recomputed from scratch each run);
 * no timestamps; non-conflated nodes pass through verbatim.
 *
 * @module lib/precedence
 */

import { canonicalStringify } from './jsonld.ts';

/** Node-level scalar attributes eligible for precedence resolution. */
export const RESOLVABLE_SCALAR_FIELDS = Object.freeze([
  'cluster',
  'content',
  'display',
  'emoji',
  'image',
  'rawContent',
  'sprite',
  'title',
]) as readonly string[];

type Candidate = { sourceId?: string; value: unknown };
type ResolvedWinner = { value: unknown; sourceId?: string };
type ConflatedMember = { sourceId?: string; attributes?: Record<string, unknown> };
type FieldCandidateBucket = { isData: boolean; candidates: Candidate[] };
type SourcePrecedenceConfig = {
  sources?: string[];
  fields?: Record<string, string[]>;
};
type ResolvePrecedenceOptions = {
  config?: { precedence?: SourcePrecedenceConfig | null } | null;
  precedence?: SourcePrecedenceConfig | null;
};
type PrecedenceNode = Record<string, unknown> & {
  conflatedFrom?: ConflatedMember[];
  data?: Record<string, unknown>;
};
type PrecedenceGraph = { nodes?: PrecedenceNode[]; edges?: object[] };

/** Stable comparator helper. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read the precedence config from opts (KBConfig.precedence or a direct override). */
function readPrecedence(opts: ResolvePrecedenceOptions): SourcePrecedenceConfig | null {
  return opts.config?.precedence ?? opts.precedence ?? null;
}

/**
 * Decide the winning candidate for one field given an effective source order.
 *
 * @param {Array<{ sourceId?: string, value: unknown }>} candidates
 * @param {string[]|null} order  Effective precedence order (highest first), or null.
 * @returns {{ value: unknown, sourceId?: string } | null}  Winner, or null when
 *   precedence does not decide (conflict-preserve).
 */
export function pickWinner(candidates: Candidate[], order: string[] | null): ResolvedWinner | null {
  if (!Array.isArray(order) || order.length === 0) return null;
  const rankOf = (sourceId: string | undefined) => {
    if (sourceId == null) return Infinity;
    const i = order.indexOf(sourceId);
    return i === -1 ? Infinity : i;
  };
  let best = Infinity;
  for (const c of candidates) best = Math.min(best, rankOf(c.sourceId));
  if (best === Infinity) return null; // every contributor unranked
  const top = candidates.filter((c) => rankOf(c.sourceId) === best);
  // The top rank is a single source key; if it disagrees with itself we cannot
  // decide → conflict-preserve.
  const distinct = new Map<string, Candidate>(top.map((c) => [canonicalStringify(c.value), c]));
  if (distinct.size !== 1) return null;
  const winner = distinct.values().next().value as Candidate;
  return { value: winner.value, sourceId: winner.sourceId };
}

/** Gather per-field candidate {sourceId, value} lists from a node's members. */
function gatherFieldCandidates(conflatedFrom: ConflatedMember[]): Map<string, FieldCandidateBucket> {
  // First pass: which names exist as node-level resolvable fields on any member.
  const nodeFieldNames = new Set<string>();
  for (const m of conflatedFrom) {
    const attrs = m.attributes ?? {};
    for (const f of RESOLVABLE_SCALAR_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(attrs, f)) nodeFieldNames.add(f);
    }
  }
  /** @type {Map<string, { isData: boolean, candidates: Array<{sourceId?:string, value:unknown}> }>} */
  const fields = new Map<string, FieldCandidateBucket>();
  const ensure = (name: string, isData: boolean) => {
    let entry = fields.get(name);
    if (!entry) fields.set(name, (entry = { isData, candidates: [] }));
    return entry;
  };
  for (const m of conflatedFrom) {
    const attrs = m.attributes ?? {};
    for (const f of RESOLVABLE_SCALAR_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(attrs, f))
        ensure(f, false).candidates.push({ sourceId: m.sourceId, value: attrs[f] });
    }
    const data = attrs.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data)) {
        if (nodeFieldNames.has(k)) continue; // node-level field owns the name
        ensure(k, true).candidates.push({ sourceId: m.sourceId, value: (data as Record<string, unknown>)[k] });
      }
    }
  }
  return fields;
}

/**
 * Resolve conflicting attributes on conflated nodes by declared SoR-precedence.
 *
 * @param {{ nodes: object[], edges?: object[] }} graph  A conflated graph (#138 output).
 * @param {object} [opts]
 * @param {object} [opts.config]      KBConfig; precedence is read from `config.precedence`.
 * @param {object} [opts.precedence]  Direct {@link SourcePrecedenceConfig} override.
 * @returns {{
 *   graph: object,
 *   stats: { conflatedNodes:number, fieldsResolved:number, fieldsConflicted:number }
 * }}
 */
export function resolvePrecedence(graph: PrecedenceGraph, opts: ResolvePrecedenceOptions = {}) {
  const precedence = readPrecedence(opts);
  const nodes = graph?.nodes ?? [];
  let fieldsResolved = 0;
  let fieldsConflicted = 0;
  let conflatedNodes = 0;

  const outNodes = nodes.map((node: PrecedenceNode) => {
    const conflatedFrom = node?.conflatedFrom;
    if (!Array.isArray(conflatedFrom) || conflatedFrom.length < 2) return node;
    conflatedNodes++;

    const fields = gatherFieldCandidates(conflatedFrom);
    const resolved: Record<string, { sourceId?: string; value: unknown; via: 'fields' | 'sources' }> = {};
    const conflicts: Record<string, Candidate[]> = {};
    /** @type {Record<string, unknown>} field → winning value to apply (node-level) */
    const applyNode: Record<string, unknown> = {};
    /** @type {Record<string, unknown>} data key → winning value to apply */
    const applyData: Record<string, unknown> = {};

    for (const [field, { isData, candidates }] of [...fields.entries()].sort((a, b) =>
      cmp(a[0], b[0])
    )) {
      const distinctValues = new Set(candidates.map((c) => canonicalStringify(c.value)));
      if (distinctValues.size <= 1) continue; // no conflict

      const order = precedence ? (precedence.fields?.[field] ?? precedence.sources ?? null) : null;
      const winner = pickWinner(candidates, order);
      if (winner) {
        const via = precedence?.fields?.[field] ? 'fields' : 'sources';
        resolved[field] = { sourceId: winner.sourceId, value: winner.value, via };
        if (isData) applyData[field] = winner.value;
        else applyNode[field] = winner.value;
        fieldsResolved++;
      } else {
        // Conflict-preserve: retain competing values with provenance, sorted.
        const seen = new Map<string, Candidate>();
        for (const c of candidates) {
          const key = `${c.sourceId ?? ''}\u0000${canonicalStringify(c.value)}`;
          if (!seen.has(key)) seen.set(key, { sourceId: c.sourceId, value: c.value });
        }
        conflicts[field] = [...seen.values()].sort(
          (a, b) =>
            cmp(a.sourceId ?? '', b.sourceId ?? '') ||
            cmp(canonicalStringify(a.value), canonicalStringify(b.value))
        );
        fieldsConflicted++;
      }
    }

    const hasResolved = Object.keys(resolved).length > 0;
    const hasConflicts = Object.keys(conflicts).length > 0;
    if (!hasResolved && !hasConflicts) return node;

    const next: Record<string, unknown> = { ...node, ...applyNode };
    if (Object.keys(applyData).length > 0) next.data = { ...(node.data ?? {}), ...applyData };
    next.precedence = {
      ...(hasResolved ? { resolved } : {}),
      ...(hasConflicts ? { conflicts } : {}),
    };
    return next;
  });

  return {
    graph: { ...graph, nodes: outNodes },
    stats: { conflatedNodes, fieldsResolved, fieldsConflicted },
  };
}
