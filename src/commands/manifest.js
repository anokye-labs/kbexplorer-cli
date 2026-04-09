/**
 * kbexplorer manifest — Regenerate repo manifest from local data.
 */

import { resolve } from 'node:path';
import { getAppRoot } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';

export default async function manifest(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
    process.exit(1);
  }

  generateManifest(cwd);
}
