/**
 * Source-drift detection + multi-source sync status (PE4-F1 / issue #157).
 *
 * The trust loop's first half: answer *"is the committed KB still in sync with
 * its sources, and if not, what drifted?"* — without a clock, without the
 * network, and without reinventing the deterministic machinery that already
 * exists. This module is pure composition:
 *
 *   • **Source drift** is detected by the E2 affected-source dispatch engine
 *     (#136, {@link module:lib/affected-graph}). Diffing each input's
 *     `SourceRef.contentHash` (never a timestamp) between the current composite
 *     graph and a committed baseline yields the *dirty inputs* (changed sources)
 *     and the transitive *affected* node/edge closure over `Derivation.inputs`
 *     and graph edges.
 *   • **Connection-artifact drift** is detected by the E3 connect `--check`
 *     gate (#140, {@link module:lib/connect}) — a byte-for-byte parity check of
 *     the committed `.kbx/connection/*.json` against a fresh deterministic emit.
 *
 * On top of those two signals this module builds the **multi-source sync
 * status**: a per-source rollup keyed on each node/edge's composite `sourceId`
 * (#134). A source is:
 *   - `drifted`  — one of *its own* nodes/edges is a seed (an input hash changed),
 *   - `stale`    — one of its nodes/edges is only *transitively* affected by
 *                  another source's drift (downstream, not itself a seed),
 *   - `in-sync`  — none of its nodes/edges are affected.
 *
 * Pure & deterministic: no I/O, no network, no timestamps. Every returned array
 * is sorted + de-duplicated, so identical inputs ⇒ byte-identical status and the
 * computation is idempotent. Baseline/artifact acquisition (git, fs) is the
 * caller's concern — see {@link module:commands/sync}.
 *
 * @module lib/drift
 */

import { affectedFromGraphs, itemKey } from './affected-graph.ts';

/** Stable string comparator. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, de-duplicated copy of an iterable of strings. */
function sortedUnique(values) {
  return [...new Set(values)].sort(cmp);
}

/** Sentinel used when a node/edge carries no composite source provenance. */
export const UNKNOWN_SOURCE = '(unknown)';

/**
 * The composite source a node/edge belongs to. Composite ingestion (#134)
 * qualifies every fact with `sourceId`; older/hand-authored shapes may only
 * carry `provider`. Falls back to a stable sentinel so grouping never drops a
 * fact silently.
 *
 * @param {object} item
 * @returns {string}
 */
export function sourceOf(item) {
  if (!item || typeof item !== 'object') return UNKNOWN_SOURCE;
  const id = item.sourceId ?? item.provider;
  return typeof id === 'string' && id ? id : UNKNOWN_SOURCE;
}

/**
 * Build `nodeKey → sourceId` over every node and edge of a graph.
 *
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @returns {Map<string,string>}
 */
export function buildSourceIndex(graph = {}) {
  const bySource = new Map();
  for (const item of [...(graph.nodes ?? []), ...(graph.edges ?? [])]) {
    const key = itemKey(item);
    if (typeof key === 'string' && key) bySource.set(key, sourceOf(item));
  }
  return bySource;
}

/**
 * Roll the affected-graph result up into a per-source sync status.
 *
 * @param {object} params
 * @param {{ nodes?: object[], edges?: object[] }} params.current  The current graph.
 * @param {{ full: boolean, seeds: string[], affected: string[] }} params.affected
 *        A {@link affectedFromGraphs} result over `current` vs the baseline.
 * @returns {Array<{ source: string, status: 'in-sync'|'stale'|'drifted',
 *                    drifted: string[], stale: string[], affected: string[] }>}
 *          One entry per source that owns at least one node/edge, sorted by source.
 */
export function rollupSources({ current, affected }) {
  const bySource = buildSourceIndex(current);
  const seeds = new Set(affected.seeds ?? []);
  const affectedSet = new Set(affected.affected ?? []);

  /** @type {Map<string,{drifted:Set<string>,stale:Set<string>,affected:Set<string>}>} */
  const groups = new Map();
  for (const [key, source] of bySource) {
    let g = groups.get(source);
    if (!g) {
      g = { drifted: new Set(), stale: new Set(), affected: new Set() };
      groups.set(source, g);
    }
    if (affectedSet.has(key)) {
      g.affected.add(key);
      if (seeds.has(key)) g.drifted.add(key);
      else g.stale.add(key);
    }
  }

  return [...groups.keys()].sort(cmp).map((source) => {
    const g = groups.get(source);
    const status = g.drifted.size ? 'drifted' : g.stale.size ? 'stale' : 'in-sync';
    return {
      source,
      status,
      drifted: sortedUnique(g.drifted),
      stale: sortedUnique(g.stale),
      affected: sortedUnique(g.affected),
    };
  });
}

/**
 * The sources whose *own* input content hash changed (`drifted`) — i.e. those
 * with unreconciled SOURCE-CONTENT drift that the deterministic reconcile
 * (`kbx sync`) cannot fix on its own; they require re-ingestion / node-content
 * regeneration (incremental regen, #158). `stale` sources are excluded: they
 * are only downstream of another source's drift and are reconciled
 * deterministically.
 *
 * @param {{ sources?: Array<{ source: string, status: string }> }} status
 * @returns {string[]} drifted source ids, sorted (rollup is already sorted)
 */
export function sourceContentDrift(status) {
  return (status?.sources ?? []).filter((s) => s.status === 'drifted').map((s) => s.source);
}

/**
 * Compute the full drift + multi-source sync status for a composite graph
 * against a committed baseline, optionally folding in the connection-artifact
 * parity signal.
 *
 * @param {object} params
 * @param {{ nodes?: object[], edges?: object[] }} params.current
 *        Current composite graph (working-tree/committed source of truth).
 * @param {{ nodes?: object[], edges?: object[] }|null} [params.baseline]
 *        Prior committed graph. Absent/empty ⇒ full build (everything affected).
 * @param {{ ok: boolean, drift: Array<{ file: string, reason: string }> }|null}
 *        [params.connect]  A {@link module:lib/connect.checkConnectArtifacts}
 *        result to fold in. Omitted ⇒ the connection layer is not evaluated.
 * @returns {{
 *   full: boolean,
 *   inSync: boolean,
 *   graph: ReturnType<typeof affectedFromGraphs>,
 *   sources: ReturnType<typeof rollupSources>,
 *   connect: { ok: boolean, drift: Array<object> }|null,
 *   drift: boolean,
 * }}
 */
export function computeSyncStatus({ current, baseline = null, connect = null } = {}) {
  const graph = affectedFromGraphs(current ?? {}, baseline);
  const sources = rollupSources({ current: current ?? {}, affected: graph });

  const connectResult = connect
    ? { ok: connect.ok === true, drift: Array.isArray(connect.drift) ? connect.drift : [] }
    : null;

  // Drift when any node/edge is affected relative to a real baseline, OR the
  // committed connection artifacts diverge from a fresh emit. A `full` build
  // (no prior state) is reported but is not, by itself, "drift": there is
  // nothing committed to be out of sync with.
  const graphDrift = !graph.full && graph.affected.length > 0;
  const connectDrift = connectResult ? connectResult.ok === false : false;
  const drift = graphDrift || connectDrift;

  return {
    full: graph.full,
    inSync: !drift && !graph.full,
    graph,
    sources,
    connect: connectResult,
    drift,
  };
}
