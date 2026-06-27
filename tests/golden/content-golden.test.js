/**
 * Phase 0 / T0c.1 — golden snapshots of the CLI's deterministic content paths.
 *
 * Diffs the canonicalized manifest projection and JSON-LD normalization of this
 * repo's own `content/` byte-for-byte against committed fixtures. Any change to
 * those deterministic paths must regenerate the goldens (`GOLDEN_UPDATE=1`),
 * making the diff visible in review — the guardrail F1c relies on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildContentManifestGolden, buildContentJsonldGolden } from './build-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const MANIFEST_GOLDEN = join(FIXTURES, 'content-manifest.golden.json');
const JSONLD_GOLDEN = join(FIXTURES, 'content-jsonld.golden.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

describe('golden: deterministic content manifest projection (T0c.1)', () => {
  it('serializes byte-for-byte identical to the committed golden', () => {
    const actual = buildContentManifestGolden();
    if (UPDATE) writeFileSync(MANIFEST_GOLDEN, actual);
    assert.equal(actual, readFileSync(MANIFEST_GOLDEN, 'utf-8'));
  });

  it('is deterministic: two builds produce identical bytes', () => {
    assert.equal(buildContentManifestGolden(), buildContentManifestGolden());
  });
});

describe('golden: JSON-LD normalization of derived content (T0c.1)', () => {
  it('serializes byte-for-byte identical to the committed golden', () => {
    const actual = buildContentJsonldGolden();
    if (UPDATE) writeFileSync(JSONLD_GOLDEN, actual);
    assert.equal(actual, readFileSync(JSONLD_GOLDEN, 'utf-8'));
  });

  it('is deterministic: two builds produce identical bytes', () => {
    assert.equal(buildContentJsonldGolden(), buildContentJsonldGolden());
  });
});
