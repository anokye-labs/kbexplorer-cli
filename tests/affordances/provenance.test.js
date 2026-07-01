/**
 * Sampled-content provenance (PE3-F3).
 *
 * Verifies the Derivation/SourceRef stamping for model-generated content is
 * deterministic, timestamp-free, idempotent, and uses the same provenance
 * surface (`derivation.inputs[]`) the affected/drift engines already consume —
 * and that a generate job stamps its produced changes end-to-end.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildDerivation,
  sampledSourceRef,
  stampProvenance,
  SAMPLE_GENERATOR,
} = await import('../../src/affordances/provenance.js');
const { extractInputRefs } = await import('../../src/lib/affected-graph.js');
const { createAffordanceContext } = await import('../../src/affordances/context.js');
const { executeAffordance } = await import('../../src/affordances/index.js');
const { JobStore } = await import('../../src/affordances/jobs/store.js');

describe('provenance — sampledSourceRef', () => {
  it('normalises strings and objects, dropping anything without a usable href', () => {
    assert.deepEqual(sampledSourceRef('a.md'), { href: 'a.md' });
    assert.deepEqual(sampledSourceRef({ href: 'b.md' }), { href: 'b.md' });
    assert.deepEqual(sampledSourceRef({ href: 'c.md', contentHash: { algo: 'sha256', hex: 'ab' } }), {
      href: 'c.md',
      contentHash: { algo: 'sha256', hex: 'ab' },
    });
    assert.equal(sampledSourceRef({ nope: 1 }), null);
    assert.equal(sampledSourceRef(''), null);
    assert.equal(sampledSourceRef(42), null);
  });
});

describe('provenance — buildDerivation', () => {
  it('is deterministic, sorted by href, and timestamp-free', () => {
    const a = buildDerivation({ inputs: ['z.md', 'a.md', 'm.md'] });
    const b = buildDerivation({ inputs: ['m.md', 'z.md', 'a.md'] });
    assert.deepEqual(a, b); // order-insensitive inputs canonicalise identically
    assert.deepEqual(
      a.inputs.map((r) => r.href),
      ['a.md', 'm.md', 'z.md']
    );
    assert.equal(a.generator, SAMPLE_GENERATOR);
    assert.equal(a.actionClass, 'sample');
    // No timestamp anywhere in the serialised provenance.
    assert.doesNotMatch(JSON.stringify(a), /\d{4}-\d{2}-\d{2}T/);
  });

  it('de-duplicates identical refs and records a request digest', () => {
    const d = buildDerivation({ inputs: ['a.md', 'a.md'], request: { refresh: true } });
    assert.equal(d.inputs.length, 1);
    assert.equal(typeof d.inputDigest, 'string');
    // A changed request changes the digest (recompute signal), nothing else.
    const d2 = buildDerivation({ inputs: ['a.md', 'a.md'], request: { refresh: false } });
    assert.notEqual(d.inputDigest, d2.inputDigest);
    assert.deepEqual(d.inputs, d2.inputs);
  });

  it('produces provenance the affected/drift engine can read back', () => {
    const derivation = buildDerivation({ inputs: ['src/a.md', 'src/b.md'] });
    const stamped = stampProvenance({ path: 'out.jsonld', contents: '{}' }, derivation);
    const refs = extractInputRefs(stamped);
    assert.deepEqual(
      refs.map((r) => r.href).sort(),
      ['src/a.md', 'src/b.md']
    );
  });
});

describe('provenance — stampProvenance (non-mutating)', () => {
  it('attaches a top-level derivation without mutating the original change', () => {
    const original = { path: 'p.md', contents: 'x' };
    const derivation = buildDerivation({ inputs: ['a.md'] });
    const stamped = stampProvenance(original, derivation);
    assert.notEqual(stamped, original);
    assert.equal('derivation' in original, false);
    assert.deepEqual(stamped.derivation, derivation);
    assert.equal(stamped.path, 'p.md');
  });

  it('preserves an existing provenance bag and re-stamps idempotently', () => {
    const derivation = buildDerivation({ inputs: ['a.md'] });
    const once = stampProvenance({ path: 'p.md', provenance: { note: 'keep' } }, derivation);
    assert.equal(once.provenance.note, 'keep');
    const twice = stampProvenance(once, derivation);
    assert.deepEqual(twice.derivation, once.derivation);
  });
});

describe('provenance — end-to-end through a generate job', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-prov-'));
    store = new JobStore();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stamps each generated change with the job derivation', async () => {
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: {
        jobStore: store,
        consentPolicy: 'allow',
        runGenerate: async () => ({
          changes: [
            { path: 'content/derived/a.jsonld', contents: '{"a":1}' },
            { path: 'content/derived/b.jsonld', contents: '{"b":2}' },
          ],
        }),
      },
    });

    const started = await executeAffordance(
      'start_generate',
      { request: { inputs: ['docs/org.md'] } },
      ctx
    );
    await store.settle(started.id);

    const raw = store._raw(started.id);
    assert.equal(raw.changes.length, 2);
    for (const change of raw.changes) {
      assert.equal(change.derivation.generator, SAMPLE_GENERATOR);
      assert.equal(change.derivation.actionClass, 'sample');
      assert.deepEqual(
        change.derivation.inputs.map((r) => r.href),
        ['docs/org.md']
      );
    }
    // The snapshot exposes the derivation for clients to disclose.
    assert.equal(store.get(started.id).derivation.generator, SAMPLE_GENERATOR);
  });
});
