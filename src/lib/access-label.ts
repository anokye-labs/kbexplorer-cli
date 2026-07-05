import {
  coerceAccessLabel,
  DEFAULT_ACCESS_EXCLUSION,
  isExcludedByDefault,
  normalizeAccessLabel as coreNormalizeAccessLabel,
  resolveAccessExclusion,
  type AccessClassification,
  type AccessVisibility,
  type KBAccessLabel,
} from '@anokye-labs/kbexplorer-core';

export { DEFAULT_ACCESS_EXCLUSION, coerceAccessLabel, isExcludedByDefault, resolveAccessExclusion };

export const CLASSIFICATION_RANK = Object.freeze({
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
  unknown: 5,
});

export const VISIBILITY_RANK = Object.freeze({
  public: 1,
  internal: 2,
  private: 3,
});

export const ACCESS_TOP_CLASSIFICATION = 'unknown' as const;
export const ACCESS_TOP_VISIBILITY = 'private' as const;

const hasOwn = <T extends object>(value: T, key: PropertyKey): key is keyof T =>
  Object.prototype.hasOwnProperty.call(value, key);

const classificationRank = (token: AccessClassification | null | undefined): number =>
  token == null
    ? 0
    : hasOwn(CLASSIFICATION_RANK, token)
      ? CLASSIFICATION_RANK[token]
      : CLASSIFICATION_RANK[ACCESS_TOP_CLASSIFICATION];

const visibilityRank = (token: AccessVisibility | null | undefined): number =>
  token == null
    ? 0
    : hasOwn(VISIBILITY_RANK, token)
      ? VISIBILITY_RANK[token]
      : VISIBILITY_RANK[ACCESS_TOP_VISIBILITY];

export const normalizeAccessLabel = (raw: unknown): KBAccessLabel | undefined =>
  coreNormalizeAccessLabel(raw);

export const inheritAccess = (
  own: unknown,
  fallback: unknown,
): KBAccessLabel | undefined => normalizeAccessLabel(own) ?? normalizeAccessLabel(fallback);

export function mergeAccessLabels(labels: unknown): KBAccessLabel | undefined {
  const normalized = (Array.isArray(labels) ? labels : [])
    .map((label) => normalizeAccessLabel(label))
    .filter((label): label is KBAccessLabel => label !== undefined);

  if (normalized.length === 0) return undefined;

  const out: KBAccessLabel = {};

  let bestClass: AccessClassification | undefined;
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

  if (bestClass != null) {
    out.classification = classTie ? ACCESS_TOP_CLASSIFICATION : bestClass;
  }

  let bestVisibility: AccessVisibility | undefined;
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

  if (bestVisibility != null) {
    out.visibility = visibilityTie ? ACCESS_TOP_VISIBILITY : bestVisibility;
  }

  const tagSet = new Set<string>();
  for (const label of normalized) {
    for (const tag of label.labels ?? []) tagSet.add(tag);
  }
  if (tagSet.size > 0) out.labels = [...tagSet].sort();

  const refs = new Map<string, NonNullable<KBAccessLabel['sourcePolicyRef']>>();
  for (const label of normalized) {
    if (!label.sourcePolicyRef) continue;
    const sourcePolicyRef = label.sourcePolicyRef as unknown as Record<string, unknown>;
    const key = JSON.stringify(
      Object.keys(sourcePolicyRef)
        .sort()
        .reduce<Record<string, unknown>>((acc, entryKey) => {
          acc[entryKey] = sourcePolicyRef[entryKey];
          return acc;
        }, {}),
    );
    refs.set(key, label.sourcePolicyRef);
  }
  if (refs.size === 1) out.sourcePolicyRef = [...refs.values()][0];

  return Object.keys(out).length > 0 ? out : undefined;
}

export const isMoreRestrictiveOrEqual = (a: unknown, b: unknown): boolean => {
  const normalizedA = normalizeAccessLabel(a);
  const normalizedB = normalizeAccessLabel(b);
  if (normalizedB === undefined) return true;
  if (normalizedA === undefined) return false;
  if (classificationRank(normalizedA.classification) < classificationRank(normalizedB.classification)) {
    return false;
  }
  if (visibilityRank(normalizedA.visibility) < visibilityRank(normalizedB.visibility)) return false;
  const aTags = new Set(normalizedA.labels ?? []);
  for (const tag of normalizedB.labels ?? []) {
    if (!aTags.has(tag)) return false;
  }
  return true;
};
