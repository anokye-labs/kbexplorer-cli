import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCompositeConfig,
  CompositeConfigError,
  CompositeConfigErrorCode,
  DEFAULT_INGESTION,
} from '../../src/lib/composite-config.ts';

const TWO_SOURCES = {
  kbx: {
    sources: [
      { sourceId: 'docs', kind: 'rich-markdown', module: '@scope/p', options: { cluster: 'docs' } },
      {
        sourceId: 'specs',
        kind: 'rich-markdown',
        module: '@scope/p',
        options: { cluster: 'specs' },
      },
    ],
  },
};

describe('normalizeCompositeConfig — shape & envelopes', () => {
  it('accepts the kbx-enveloped form and defaults the ingestion policy', () => {
    const cfg = normalizeCompositeConfig(TWO_SOURCES, { env: {} });
    assert.equal(cfg.sources.length, 2);
    assert.deepEqual(
      cfg.sources.map((s) => s.sourceId),
      ['docs', 'specs']
    );
    assert.equal(cfg.ingestion.failureMode, DEFAULT_INGESTION.failureMode);
    assert.equal(cfg.ingestion.concurrency, 1);
    assert.deepEqual(cfg.ingestion.budgets, {});
  });

  it('accepts a root-level (un-enveloped) sources array', () => {
    const cfg = normalizeCompositeConfig(
      { sources: [{ sourceId: 'a', module: '@scope/p' }] },
      { env: {} }
    );
    assert.equal(cfg.sources[0].sourceId, 'a');
  });

  it('rejects a non-object config', () => {
    assert.throws(() => normalizeCompositeConfig(null), CompositeConfigError);
    assert.throws(() => normalizeCompositeConfig('x'), CompositeConfigError);
  });

  it('requires a non-empty sources array', () => {
    assert.throws(
      () => normalizeCompositeConfig({ sources: [] }, { env: {} }),
      (e) => e.code === CompositeConfigErrorCode.INVALID
    );
    assert.throws(
      () => normalizeCompositeConfig({ ingestion: {} }, { env: {} }),
      (e) => e.code === CompositeConfigErrorCode.INVALID
    );
  });

  it('rejects duplicate sourceIds', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          {
            sources: [
              { sourceId: 'x', module: '@p' },
              { sourceId: 'x', module: '@p' },
            ],
          },
          { env: {} }
        ),
      (e) => e.code === CompositeConfigErrorCode.DUPLICATE_SOURCE
    );
  });

  it('requires a module or kind to resolve a provider', () => {
    assert.throws(
      () => normalizeCompositeConfig({ sources: [{ sourceId: 'x' }] }, { env: {} }),
      (e) => e.code === CompositeConfigErrorCode.MISSING_RESOLVER
    );
  });

  it('allows a kind-only source (host resolver supplies the provider)', () => {
    const cfg = normalizeCompositeConfig(
      { sources: [{ sourceId: 'x', kind: 'orgchart' }] },
      { env: {} }
    );
    assert.equal(cfg.sources[0].kind, 'orgchart');
    assert.equal(cfg.sources[0].module, null);
  });
});

describe('normalizeCompositeConfig — credentials via env', () => {
  it('resolves credential env-var names into values from env', () => {
    const cfg = normalizeCompositeConfig(
      { sources: [{ sourceId: 'gh', module: '@p', credentials: { token: 'GH_TOKEN' } }] },
      { env: { GH_TOKEN: 'secret-123' } }
    );
    assert.deepEqual(cfg.sources[0].credentials, { token: 'secret-123' });
    assert.deepEqual(cfg.sources[0].credentialEnv, { token: 'GH_TOKEN' });
    assert.equal(cfg.warnings.length, 0);
  });

  it('warns (does not throw) when a referenced env var is unset', () => {
    const cfg = normalizeCompositeConfig(
      { sources: [{ sourceId: 'gh', module: '@p', credentials: { token: 'MISSING' } }] },
      { env: {} }
    );
    assert.deepEqual(cfg.sources[0].credentials, {});
    assert.equal(cfg.warnings.length, 1);
    assert.match(cfg.warnings[0], /MISSING/);
  });

  it('rejects a credential mapped to a non-string env name', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'gh', module: '@p', credentials: { token: 42 } }] },
          { env: {} }
        ),
      CompositeConfigError
    );
  });
});

describe('normalizeCompositeConfig — ingestion policy', () => {
  it('accepts a valid ingestion block', () => {
    const cfg = normalizeCompositeConfig(
      {
        sources: [{ sourceId: 'a', module: '@p' }],
        ingestion: { failureMode: 'best-effort', concurrency: 4, budgets: { maxNodes: 10 } },
      },
      { env: {} }
    );
    assert.equal(cfg.ingestion.failureMode, 'best-effort');
    assert.equal(cfg.ingestion.concurrency, 4);
    assert.deepEqual(cfg.ingestion.budgets, { maxNodes: 10 });
  });

  it('rejects an unknown failureMode', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'a', module: '@p' }], ingestion: { failureMode: 'explode' } },
          { env: {} }
        ),
      (e) => e.code === CompositeConfigErrorCode.INVALID_FAILURE_MODE
    );
  });

  it('rejects a non-positive concurrency', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'a', module: '@p' }], ingestion: { concurrency: 0 } },
          { env: {} }
        ),
      CompositeConfigError
    );
  });

  it('rejects unknown and non-integer budgets', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'a', module: '@p' }], ingestion: { budgets: { bogus: 1 } } },
          { env: {} }
        ),
      (e) => e.code === CompositeConfigErrorCode.INVALID_BUDGET
    );
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'a', module: '@p' }], ingestion: { budgets: { maxNodes: -1 } } },
          { env: {} }
        ),
      (e) => e.code === CompositeConfigErrorCode.INVALID_BUDGET
    );
  });
});
