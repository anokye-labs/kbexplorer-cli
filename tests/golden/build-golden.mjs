/**
 * Phase 0 / F0c — golden-output builders for the CLI's deterministic paths.
 *
 * These reduce this repo's own `content/` through the same deterministic library
 * functions the CLI uses at runtime, then canonicalize the result with the
 * project's byte-stable `canonicalStringify` (sorted keys, trailing newline) so
 * two runs produce identical bytes. The committed goldens lock the pre-refactor
 * output in place ahead of the kbexplorer-core adoption swap (F1c).
 *
 * Hermetic by construction: only the content-scoped, network-free paths are
 * snapshotted (config + authored markdown, and the JSON-LD normalization of the
 * committed derived extractions). The gh-dependent / time-stamped manifest
 * fields (issues, PRs, commits, releases, generatedAt) and the whole-repo file
 * tree are intentionally excluded — they aren't content and aren't stable.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { buildRepoManifest } from '../../src/lib/manifest-build.ts';
import { normalizeExtraction, canonicalStringify } from '../../src/lib/jsonld.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');
export const DERIVED_DIR = join(REPO_ROOT, 'content', 'derived');

/**
 * Canonical snapshot of the deterministic content/ projection of the manifest.
 * Routed through the real `buildRepoManifest()` production path (cli#258) so
 * this golden doubles as the objective `kbx manifest` parity gate: any drift
 * in `configRaw`/`authoredContent` between the old fork and the new thin
 * wrapper fails this test until the golden is knowingly regenerated.
 */
export async function buildContentManifestGolden(root = REPO_ROOT) {
  const manifest = await buildRepoManifest(root);
  const projection = {
    configRaw: manifest.configRaw,
    authoredContent: manifest.authoredContent,
  };
  return canonicalStringify(projection);
}

/**
 * Canonical snapshot of the JSON-LD normalization path applied to every
 * committed derived artifact, keyed by its recorded source path. Replays each
 * artifact's embedded extraction through `normalizeExtraction` — the same
 * deterministic step `derive` runs after the (fuzzy) LLM phase.
 */
export function buildContentJsonldGolden(derivedDir = DERIVED_DIR, root = REPO_ROOT) {
  const out = {};
  if (existsSync(derivedDir)) {
    const files = readdirSync(derivedDir)
      .filter((f) => f.endsWith('.jsonld'))
      .sort();
    for (const file of files) {
      const artifact = JSON.parse(readFileSync(join(derivedDir, file), 'utf-8'));
      const source = artifact.kbx?.source ?? artifact.kbexplorer?.source ?? {};
      const extraction = artifact.kbx?.extraction ?? artifact.kbexplorer?.extraction ?? { entities: [], relationships: [] };
      const key = source.path ?? relative(root, join(derivedDir, file)).replace(/\\/g, '/');
      out[key] = normalizeExtraction(extraction, { sourceRef: source.path ?? key });
    }
  }
  return canonicalStringify(out);
}
