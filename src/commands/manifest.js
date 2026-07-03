/**
 * kbx manifest — Regenerate repo manifest from local data.
 *
 * Primary path: invoke the template's own generate-manifest.js (with
 * VITE_KB_HOST_ROOT pointing at the host repo). This preserves the
 * full enriched schema the template script may add (themeFileRaw, nodemap*, …).
 *
 * Fallback path: when the template script is absent or exits non-zero, the
 * CLI's own generateManifest() is used and the result is written to
 * <appRoot>/src/generated/repo-manifest.json — exactly the same location the
 * template script writes to, so `dev` and `build` find it without changes.
 *
 * KBX_GH_API_BASE / KBX_GH_TOKEN are already in process.env and
 * are inherited by both paths — no extra wiring needed.
 */

import { resolve, dirname } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getAppRoot } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';
import { manifestOutPath } from './dev.js';
import { parseManifestArgs } from '../lib/args.js';

export default async function manifest(args) {
  parseManifestArgs(args);
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbx not found. Run `kbx init` first.');
    process.exit(1);
  }

  const templateScript = resolve(appRoot, 'scripts', 'generate-manifest.js');
  if (existsSync(templateScript)) {
    const r = spawnSync('node', [templateScript], {
      cwd: appRoot,
      stdio: 'inherit',
      env: { ...process.env, VITE_KB_LOCAL: 'true', VITE_KB_HOST_ROOT: cwd },
    });
    if (r.status === 0) return;
    console.warn(`⚠ Template manifest script exited ${r.status}; falling back to CLI generator`);
  }

  // Fallback: generate via CLI and write to the standard output path.
  const manifestData = await generateManifest(cwd);
  const outPath = manifestOutPath(appRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifestData, null, 2), 'utf-8');
  console.log(`✓ Manifest written to ${outPath}`);
}


