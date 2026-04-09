/**
 * kbexplorer manifest — Regenerate repo manifest from local data.
 */

import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getAppRoot } from '../lib/detect-repo.js';

export default async function manifest(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
    process.exit(1);
  }

  const manifestScript = resolve(appRoot, 'scripts', 'generate-manifest.js');
  execSync(`node "${manifestScript}"`, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, VITE_KB_LOCAL: 'true' },
  });
}
