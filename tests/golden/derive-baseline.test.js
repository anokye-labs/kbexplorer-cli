/**
 * Phase 0 / T0c.2 — derive determinism baseline for a sample source.
 *
 * Pins `derive --check` over the committed `docs/samples/platform-squad.md`
 * baseline: the committed artifact is up to date (no drift) and a fresh emit
 * from its embedded extraction is byte-identical. Separately proves the gate
 * actually fires: in an isolated temp copy, a deliberate edit to the source
 * flips `--check` to drift. Hermetic — the (fuzzy) LLM phase is never invoked;
 * the embedded extraction is replayed via the injectable `runExtraction` seam.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync, appendFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveSource } from '../../src/commands/derive.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SOURCE = 'docs/samples/platform-squad.md';
const OUT_DIR = join(ROOT, 'content', 'derived');
const ARTIFACT = join(OUT_DIR, 'platform-squad.jsonld');

describe('golden: derive determinism baseline (T0c.2)', () => {
  it('committed artifact is up to date — `derive --check` reports no drift', async () => {
    const r = await deriveSource(SOURCE, { cwd: ROOT, outDir: OUT_DIR, check: true });
    assert.equal(r.drift, false, r.reason);
    assert.equal(r.status, 'ok');
  });

  it('a fresh deterministic emit is byte-identical to the committed artifact', async () => {
    const committed = readFileSync(ARTIFACT, 'utf-8');
    const r = await deriveSource(SOURCE, { cwd: ROOT, outDir: OUT_DIR, check: true });
    assert.equal(r.bytes, committed);
  });
});

describe('golden: derive drift gate fires on source change (T0c.2)', () => {
  const sandbox = join(tmpdir(), `kbe-derive-baseline-${process.pid}`);
  const srcAbs = join(sandbox, SOURCE); // absolute: readSource resolves off the real FS
  const outDir = join(sandbox, 'content', 'derived');
  // Replay the committed embedded extraction instead of calling the LLM.
  const extraction = JSON.parse(readFileSync(ARTIFACT, 'utf-8')).kbx.extraction;

  before(() => {
    mkdirSync(join(sandbox, 'docs', 'samples'), { recursive: true });
    copyFileSync(join(ROOT, SOURCE), srcAbs);
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it('emits, verifies clean, then drifts after a source edit', async () => {
    // 1. Emit the artifact in the sandbox from the replayed extraction.
    const created = await deriveSource(srcAbs, {
      cwd: sandbox,
      outDir,
      runExtraction: () => extraction,
    });
    assert.equal(created.drift, false);

    // 2. `--check` is clean against the freshly emitted artifact.
    const clean = await deriveSource(srcAbs, { cwd: sandbox, outDir, check: true });
    assert.equal(clean.drift, false, clean.reason);

    // 3. Mutate the source → `--check` must report drift (non-zero in the CLI).
    appendFileSync(srcAbs, '\n<!-- drift probe -->\n');
    const drifted = await deriveSource(srcAbs, { cwd: sandbox, outDir, check: true });
    assert.equal(drifted.drift, true);
    assert.match(drifted.reason, /source changed/);
  });
});
