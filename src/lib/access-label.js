/**
 * CLI access-label carry & lattice (E5 / issue #144).
 *
 * The CLI keeps the lattice/merge helpers here to preserve the prior semantics
 * when the installed core runtime does not expose the newer access-label helpers.
 * The normalization/coercion/exclusion behavior remains deterministic and never
 * broadens labels.
 *
 * @module lib/access-label
 */

const KNOWN_CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted', 'unknown']);
const KNOWN_VISIBILITIES = new Set(['public', 'internal', 'private']);

function normalizeScalar(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return undefined;
  const out = [];
  const seen = new Set();
  for (const label of labels) {
    const normalized = normalizeScalar(label);
    if (normalized == null) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  out.sort();
  return out.length > 0 ? out : undefined;
}

function normalizeSourcePolicyRef(ref) {
  if (ref == null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
  return Object.keys(ref).length > 0 ? ref : undefined;
}

export const DEFAULT_ACCESS_EXCLUSION = Object.freeze({ classification: 'restricted', visibility: 'private' });

export function normalizeAccessLabel(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const normalized = {};
  const classification = normalizeScalar(raw.classification);
  if (classification != null) normalized.classification = classification;
  const visibility = normalizeScalar(raw.visibility);
  if (visibility != null) normalized.visibility = visibility;
  const labels = normalizeLabels(raw.labels);
  if (labels != null) normalized.labels = labels;
  const sourcePolicyRef = normalizeSourcePolicyRef(raw.sourcePolicyRef);
  if (sourcePolicyRef != null) normalized.sourcePolicyRef = sourcePolicyRef;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function coerceAccessLabel(raw) {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    const normalized = normalizeScalar(raw);
    return normalized == null ? undefined : { classification: normalized };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return normalizeAccessLabel(raw);
  return undefined;
}

export function resolveAccessExclusion(label, config = {}) {
  const normalized = normalizeAccessLabel(label);
  if (normalized == null) return undefined;
  const exclusion = normalizeAccessLabel(config.exclusion ?? DEFAULT_ACCESS_EXCLUSION);
  return exclusion != null && isMoreRestrictiveOrEqual(exclusion, normalized) ? normalized : undefined;
}

export function isExcludedByDefault(label, config = {}) {
  const normalized = normalizeAccessLabel(label);
  if (normalized == null) return false;
  const exclusion = normalizeAccessLabel(config.exclusion ?? DEFAULT_ACCESS_EXCLUSION);
  return exclusion != null && isMoreRestrictiveOrEqual(exclusion, normalized);
}

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
