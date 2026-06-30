import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccessLabel,
  mergeAccessLabels,
  inheritAccess,
  isMoreRestrictiveOrEqual,
  CLASSIFICATION_RANK,
  VISIBILITY_RANK,
} from '../../src/lib/access-label.js';

describe('normalizeAccessLabel', () => {
  it('returns undefined for non-objects and empty blocks', () => {
    for (const v of [undefined, null, 'public', 42, [], {}, { labels: [] }, { classification: '  ' }]) {
      assert.equal(normalizeAccessLabel(v), undefined);
    }
  });

  it('trims, dedupes + sorts labels, and keeps only present fields', () => {
    assert.deepEqual(
      normalizeAccessLabel({
        classification: ' confidential ',
        visibility: 'internal',
        labels: ['pii', 'legal-hold', 'pii', '  '],
        extra: 'dropped',
      }),
      { classification: 'confidential', visibility: 'internal', labels: ['legal-hold', 'pii'] }
    );
  });

  it('preserves a non-empty sourcePolicyRef verbatim and drops an empty one', () => {
    const ref = { scheme: 'policy', id: 'p1' };
    assert.deepEqual(normalizeAccessLabel({ sourcePolicyRef: ref }), { sourcePolicyRef: ref });
    assert.equal(normalizeAccessLabel({ sourcePolicyRef: {} }), undefined);
  });

  it('is deterministic regardless of input label order', () => {
    const a = normalizeAccessLabel({ labels: ['b', 'a', 'c'] });
    const b = normalizeAccessLabel({ labels: ['c', 'a', 'b'] });
    assert.deepEqual(a, b);
  });
});

describe('mergeAccessLabels — most-restrictive (never broaden)', () => {
  it('returns undefined when no input carries a usable label', () => {
    assert.equal(mergeAccessLabels([undefined, {}, null]), undefined);
    assert.equal(mergeAccessLabels([]), undefined);
  });

  it('picks the highest classification rank', () => {
    const merged = mergeAccessLabels([
      { classification: 'public' },
      { classification: 'restricted' },
      { classification: 'internal' },
    ]);
    assert.equal(merged.classification, 'restricted');
  });

  it('treats unknown as more restrictive than restricted', () => {
    assert.ok(CLASSIFICATION_RANK.unknown > CLASSIFICATION_RANK.restricted);
    const merged = mergeAccessLabels([{ classification: 'restricted' }, { classification: 'unknown' }]);
    assert.equal(merged.classification, 'unknown');
  });

  it('picks the highest visibility rank', () => {
    assert.ok(VISIBILITY_RANK.private > VISIBILITY_RANK.internal);
    const merged = mergeAccessLabels([{ visibility: 'internal' }, { visibility: 'private' }]);
    assert.equal(merged.visibility, 'private');
  });

  it('unions labels[] (tags only add restrictions)', () => {
    const merged = mergeAccessLabels([{ labels: ['pii'] }, { labels: ['legal-hold', 'pii'] }]);
    assert.deepEqual(merged.labels, ['legal-hold', 'pii']);
  });

  it('keeps sourcePolicyRef only when all contributors agree', () => {
    const ref = { id: 'p1' };
    assert.deepEqual(
      mergeAccessLabels([{ sourcePolicyRef: ref }, { sourcePolicyRef: { id: 'p1' } }]).sourcePolicyRef,
      ref
    );
    assert.equal(
      mergeAccessLabels([{ sourcePolicyRef: { id: 'p1' } }, { sourcePolicyRef: { id: 'p2' } }]),
      undefined
    );
  });

  it('unrecognized classification tokens are treated as the top tier and tie → unknown', () => {
    // Unknown custom token ranks at the top; tie with a different top-tier token
    // collapses to the canonical safe sentinel.
    const merged = mergeAccessLabels([{ classification: 'ts-sci' }, { classification: 'unknown' }]);
    assert.equal(merged.classification, 'unknown');
  });

  it('result is never less restrictive than any input', () => {
    const inputs = [
      { classification: 'internal', labels: ['a'] },
      { classification: 'confidential', visibility: 'private' },
      { labels: ['b'] },
    ];
    const merged = mergeAccessLabels(inputs);
    for (const input of inputs) assert.ok(isMoreRestrictiveOrEqual(merged, input));
  });

  it('is order-independent / deterministic', () => {
    const a = mergeAccessLabels([{ classification: 'internal' }, { labels: ['x', 'y'] }]);
    const b = mergeAccessLabels([{ labels: ['y', 'x'] }, { classification: 'internal' }]);
    assert.deepEqual(a, b);
  });
});

describe('inheritAccess', () => {
  it('keeps the own label when present (no override, no broaden)', () => {
    assert.deepEqual(
      inheritAccess({ classification: 'public' }, { classification: 'restricted' }),
      { classification: 'public' }
    );
  });

  it('inherits the fallback only when unlabeled', () => {
    assert.deepEqual(inheritAccess(undefined, { classification: 'internal' }), {
      classification: 'internal',
    });
    assert.equal(inheritAccess(undefined, undefined), undefined);
  });
});

describe('isMoreRestrictiveOrEqual', () => {
  it('everything is >= an absent label; absent is not >= a present one', () => {
    assert.ok(isMoreRestrictiveOrEqual({ classification: 'public' }, undefined));
    assert.ok(!isMoreRestrictiveOrEqual(undefined, { classification: 'public' }));
    assert.ok(isMoreRestrictiveOrEqual(undefined, undefined));
  });

  it('requires superset labels and >= ranks', () => {
    assert.ok(
      isMoreRestrictiveOrEqual(
        { classification: 'restricted', labels: ['a', 'b'] },
        { classification: 'internal', labels: ['a'] }
      )
    );
    assert.ok(
      !isMoreRestrictiveOrEqual({ classification: 'internal' }, { classification: 'restricted' })
    );
    assert.ok(!isMoreRestrictiveOrEqual({ labels: ['a'] }, { labels: ['a', 'b'] }));
  });
});
