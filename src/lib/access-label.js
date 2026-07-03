/**
 * Access-label carry & lattice (E5 / issue #144).
 *
 * The core package (`@anokye-labs/kbexplorer-core` v0.3.0) declares the
 * {@link KBAccessLabel} / {@link AccessConfig} *types* but deliberately ships
 * **no engine**: "kbx labels; the host enforces." This module is the CLI's pure,
 * deterministic carry layer — the substrate E5 redaction / access-review and
 * search-excludes build on. It does three things and nothing else:
 *
 *   • {@link normalizeAccessLabel} — coerce a raw `access` block (from
 *     frontmatter, a structured entity, a relationship, or a composite source
 *     entry) into a clean, canonical {@link KBAccessLabel}; an empty/garbage
 *     label normalizes to `undefined` (= unlabeled).
 *   • {@link inheritAccess} — a node/edge keeps its OWN label; only when it has
 *     none does it inherit a fallback (e.g. its composite source's label). This
 *     never overrides a more-specific label and never broadens one.
 *   • {@link mergeAccessLabels} — combine N labels into the **most-restrictive**
 *     one (the meet of the access lattice). This is the single primitive both
 *     "derived facts inherit the most-restrictive input" and "E3-conflated
 *     referents intersect labels (never broaden)" are expressed with.
 *
 * ── The lattice ──
 * Classification is a total order, least → most restrictive:
 *
 *   absent  <  public  <  internal  <  confidential  <  restricted  <  unknown
 *
 * (`'unknown'` sorts ABOVE `'restricted'` because the default-safe boundary
 * withholds unknown-classified resources — when in doubt, lock it down.)
 * Visibility is likewise ordered `absent < public < internal < private`.
 *
 * Core's open unions allow bespoke classification/visibility tokens. An
 * UNRECOGNIZED token can't be ranked against the built-ins, so — to honor the
 * "never broaden" invariant — it is treated as the most-restrictive tier
 * (`'unknown'` / `'private'`). When a most-restrictive winner is a tie between
 * two *different* tokens, the canonical safe sentinel for that axis is chosen so
 * output stays deterministic (byte-identical for identical inputs, no
 * timestamps).
 *
 * `labels[]` tags (e.g. `'pii'`, `'legal-hold'`) only ADD restrictions, so the
 * merge is their union (deduped, sorted) — never an intersection, which would
 * drop a restriction and broaden access. `sourcePolicyRef` is a pointer, not a
 * restriction: it is preserved only when every contributing label agrees on it
 * (exactly one distinct value); otherwise it is dropped rather than guessed.
 *
 * @module lib/access-label
 */

/**
 * Classification rank, least → most restrictive. Absent maps to 0. A token not
 * in this map is unrecognized and treated as the top tier (see {@link ACCESS_TOP_CLASSIFICATION}).
 */
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimmedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
 * Normalize a raw `access` block into a canonical {@link KBAccessLabel}.
 *
 * Drops empties, trims strings, dedupes + sorts `labels[]`, and preserves a
 * plain-object `sourcePolicyRef` ({@link ExternalRef}) verbatim. A block with no
 * usable field normalizes to `undefined` (the "unlabeled" signal). Pure.
 *
 * @param {unknown} raw
 * @returns {import('@anokye-labs/kbexplorer-core').KBAccessLabel | undefined}
 */
export function normalizeAccessLabel(raw) {
  if (!isPlainObject(raw)) return undefined;
  const out = {};

  const classification = trimmedString(raw.classification);
  if (classification) out.classification = classification;

  const visibility = trimmedString(raw.visibility);
  if (visibility) out.visibility = visibility;

  if (Array.isArray(raw.labels)) {
    const labels = [
      ...new Set(
        raw.labels
          .map((l) => trimmedString(l))
          .filter((l) => l !== undefined)
      ),
    ].sort();
    if (labels.length > 0) out.labels = labels;
  }

  if (isPlainObject(raw.sourcePolicyRef) && Object.keys(raw.sourcePolicyRef).length > 0) {
    out.sourcePolicyRef = raw.sourcePolicyRef;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coerce a raw *frontmatter* `access` value into a canonical {@link KBAccessLabel}.
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
  const scalar = trimmedString(raw);
  if (scalar) return normalizeAccessLabel({ classification: scalar });
  return normalizeAccessLabel(raw);
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
    .map((l) => normalizeAccessLabel(l))
    .filter((l) => l !== undefined);
  if (normalized.length === 0) return undefined;

  const out = {};

  // ── classification: highest rank wins; tie between distinct tokens → top sentinel ──
  let bestClass;
  let bestClassRank = 0;
  let classTie = false;
  for (const l of normalized) {
    if (l.classification == null) continue;
    const rank = classificationRank(l.classification);
    if (rank > bestClassRank) {
      bestClassRank = rank;
      bestClass = l.classification;
      classTie = false;
    } else if (rank === bestClassRank && l.classification !== bestClass) {
      classTie = true;
    }
  }
  if (bestClass != null) out.classification = classTie ? ACCESS_TOP_CLASSIFICATION : bestClass;

  // ── visibility: highest rank wins; tie between distinct tokens → top sentinel ──
  let bestVis;
  let bestVisRank = 0;
  let visTie = false;
  for (const l of normalized) {
    if (l.visibility == null) continue;
    const rank = visibilityRank(l.visibility);
    if (rank > bestVisRank) {
      bestVisRank = rank;
      bestVis = l.visibility;
      visTie = false;
    } else if (rank === bestVisRank && l.visibility !== bestVis) {
      visTie = true;
    }
  }
  if (bestVis != null) out.visibility = visTie ? ACCESS_TOP_VISIBILITY : bestVis;

  // ── labels[]: union (deduped, sorted) — tags only add restrictions ──
  const tagSet = new Set();
  for (const l of normalized) for (const tag of l.labels ?? []) tagSet.add(tag);
  if (tagSet.size > 0) out.labels = [...tagSet].sort();

  // ── sourcePolicyRef: keep only when every contributor agrees ──
  const refs = new Map();
  for (const l of normalized) {
    if (l.sourcePolicyRef) refs.set(refKey(l.sourcePolicyRef), l.sourcePolicyRef);
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
  const na = normalizeAccessLabel(a);
  const nb = normalizeAccessLabel(b);
  if (nb === undefined) return true; // nothing is less restrictive than "unlabeled"
  if (na === undefined) return false;
  if (classificationRank(na.classification) < classificationRank(nb.classification)) return false;
  if (visibilityRank(na.visibility) < visibilityRank(nb.visibility)) return false;
  const aTags = new Set(na.labels ?? []);
  for (const tag of nb.labels ?? []) if (!aTags.has(tag)) return false;
  return true;
}
