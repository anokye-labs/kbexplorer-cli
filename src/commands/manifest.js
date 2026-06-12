/**
 * kbexplorer manifest — Regenerate repo manifest from local data.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getAppRoot } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';

export default async function manifest(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
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
  generateManifest(cwd);
}
