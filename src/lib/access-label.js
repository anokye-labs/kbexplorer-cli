import {
  coerceAccessLabel as coreCoerceAccessLabel,
  normalizeAccessLabel as coreNormalizeAccessLabel,
  DEFAULT_ACCESS_EXCLUSION,
  resolveAccessExclusion,
  isExcludedByDefault as coreIsExcludedByDefault,
} from '@anokye-labs/kbexplorer-core';

/**
 * CLI access-label carry & lattice (E5 / issue #144).
 *
 * The runtime contract now comes from `@anokye-labs/kbexplorer-core`'s hoisted
 * access helpers. The CLI keeps the lattice/merge helpers here because the core
 * package currently exports normalization and exclusion helpers, not the CLI's
 * merge/inheritance semantics. We preserve the prior behavior so graph, JSON-LD,
 * and composite-ingestion logic remain deterministic and never broaden labels.
 *
 * @module lib/access-label
 */

export { DEFAULT_ACCESS_EXCLUSION, resolveAccessExclusion };

/** Classification rank, least → most restrictive. Absent maps to 0. */
export const CLASSIFICATION_RANK = Object.freeze({
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
  unknown: 5,
});

/** Visibility rank, least → most restrictive. Absent maps to 0. */
export const VISIBILITY_RANK = Object.freeze({
  public: 1,
  internal: 2,
  private: 3,
});

/** Canonical most-restrictive sentinel per axis (used for unrecognized tokens and tie-breaks). */
export const ACCESS_TOP_CLASSIFICATION = 'unknown';
export const ACCESS_TOP_VISIBILITY = 'private';

/** Rank a classification token; unrecognized non-empty tokens rank as the top tier. */
function classificationRank(token) {
  if (token == null) return 0;
  return CLASSIFICATION_RANK[token] ?? CLASSIFICATION_RANK[ACCESS_TOP_CLASSIFICATION];
}

/** Rank a visibility token; unrecognized non-empty tokens rank as the top tier. */
function visibilityRank(token) {
  if (token == null) return 0;
  return VISIBILITY_RANK[token] ?? VISIBILITY_RANK[ACCESS_TOP_VISIBILITY];
}

/**
 * Re-export the shared core normalization helper.
 *
 * @param {unknown} raw
 * @returns {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined}
 */
export function normalizeAccessLabel(raw) {
  return coreNormalizeAccessLabel(raw);
}

/**
 * Re-export the shared core coercion helper.
 *
 * kbx frontmatter authors access two ways:
 *   • **scalar shorthand** — `access: restricted` (a bare string). The string is
 *     the classification tier, so it coerces to `{ classification: 'restricted' }`.
 *   • **nested block** — `access: { classification, visibility, labels, … }`, an
 *     already-structured label.
 *
 * Both route through {@link normalizeAccessLabel} so the result is the exact
 * canonical shape core / search / the template gate consume (never a bare
 * string, which every one of those consumers silently drops as "unlabeled" —
 * the AF-009 no-op). A blank / garbage value yields `undefined` (= unlabeled).
 *
 * NOTE(#179): the CLI's content-file parser (`src/lib/markdown.js`, backed by
 * `@anokye-labs/kbexplorer-provider-rich-markdown`) now preserves nested
 * objects, so the object branch below is exercised for real — it previously
 * described the legacy flat parser that rejected a nested `access:` block
 * outright (the page would be skipped entirely). #179 still tracks adding an
 * end-to-end nested-`access:` fixture test.
 *
 * @param {unknown} raw  The frontmatter `access` value (string | object | absent).
 * @returns {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined}
 */
export function coerceAccessLabel(raw) {
  return coreCoerceAccessLabel(raw);
}

/**
 * Re-export the shared core exclusion helper.
 *
 * @param {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined} label
 * @param {Partial<import('@anokye-labs/kbexplorer-core').AccessExclusionConfig>} [config]
 * @returns {boolean}
 */
export function isExcludedByDefault(label, config) {
  return coreIsExcludedByDefault(label, config);
}

/**
 * A node/edge keeps its OWN access label; only an unlabeled one inherits the
 * fallback. Never overrides a present label, never broadens. Both inputs are
 * normalized; returns a normalized label or `undefined`.
 *
 * @param {unknown} own        The node/edge's own `access` (may be absent).
 * @param {unknown} fallback   The label to inherit when `own` is unlabeled (e.g. source label).
 * @returns {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined}
 */
export function inheritAccess(own, fallback) {
  return normalizeAccessLabel(own) ?? normalizeAccessLabel(fallback);
}

/** Stable JSON key for de-duplicating sourcePolicyRef objects. */
function refKey(ref) {
  const out = {};
  for (const key of Object.keys(ref).sort()) out[key] = ref[key];
  return JSON.stringify(out);
}

/**
 * Combine N access labels into the **most-restrictive** label (the lattice
 * meet) — the primitive for derived-inherits and conflated-intersect. Inputs are
 * normalized; absent/garbage labels are ignored. Returns `undefined` only when
 * NO input carried a usable label (so an unlabeled set stays unlabeled).
 *
 * Rules (each chosen so the result is never less restrictive than any input):
 *   • classification / visibility → the highest-ranked token; on a tie between
 *     two *different* tokens, the canonical top sentinel for that axis.
 *   • labels[] → union (deduped, sorted): tags only add restrictions.
 *   • sourcePolicyRef → kept iff all contributors agree (one distinct value).
 *
 * @param {Array<unknown>} labels
 * @returns {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined}
 */
export function mergeAccessLabels(labels) {
  const normalized = (Array.isArray(labels) ? labels : [])
    .map((label) => normalizeAccessLabel(label))
    .filter((label) => label !== undefined);
  if (normalized.length === 0) return undefined;

  const out = {};

  let bestClass;
  let bestClassRank = 0;
  let classTie = false;
  for (const label of normalized) {
    if (label.classification == null) continue;
    const rank = classificationRank(label.classification);
    if (rank > bestClassRank) {
      bestClassRank = rank;
      bestClass = label.classification;
      classTie = false;
    } else if (rank === bestClassRank && label.classification !== bestClass) {
      classTie = true;
    }
  }
  if (bestClass != null) out.classification = classTie ? ACCESS_TOP_CLASSIFICATION : bestClass;

  let bestVisibility;
  let bestVisibilityRank = 0;
  let visibilityTie = false;
  for (const label of normalized) {
    if (label.visibility == null) continue;
    const rank = visibilityRank(label.visibility);
    if (rank > bestVisibilityRank) {
      bestVisibilityRank = rank;
      bestVisibility = label.visibility;
      visibilityTie = false;
    } else if (rank === bestVisibilityRank && label.visibility !== bestVisibility) {
      visibilityTie = true;
    }
  }
  if (bestVisibility != null) out.visibility = visibilityTie ? ACCESS_TOP_VISIBILITY : bestVisibility;

  const tagSet = new Set();
  for (const label of normalized) for (const tag of label.labels ?? []) tagSet.add(tag);
  if (tagSet.size > 0) out.labels = [...tagSet].sort();

  const refs = new Map();
  for (const label of normalized) {
    if (label.sourcePolicyRef) refs.set(refKey(label.sourcePolicyRef), label.sourcePolicyRef);
  }
  if (refs.size === 1) out.sourcePolicyRef = [...refs.values()][0];

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Invariant check: is label `a` at least as restrictive as label `b` on every
 * axis? True iff `a`'s classification + visibility rank ≥ `b`'s and `a`'s
 * `labels[]` is a superset of `b`'s. An absent (`undefined`) `a` is only
 * ≥ an absent `b`. Used by tests to assert the never-broaden guarantee.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function isMoreRestrictiveOrEqual(a, b) {
  const normalizedA = normalizeAccessLabel(a);
  const normalizedB = normalizeAccessLabel(b);
  if (normalizedB === undefined) return true;
  if (normalizedA === undefined) return false;
  if (classificationRank(normalizedA.classification) < classificationRank(normalizedB.classification)) {
    return false;
  }
  if (visibilityRank(normalizedA.visibility) < visibilityRank(normalizedB.visibility)) {
    return false;
  }
  const aTags = new Set(normalizedA.labels ?? []);
  for (const tag of normalizedB.labels ?? []) if (!aTags.has(tag)) return false;
  return true;
}
