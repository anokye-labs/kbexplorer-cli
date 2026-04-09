/**
 * kbexplorer dev — Start dev server in local mode.
 */

import { spawn } from 'node:child_process';
import { getAppRoot, isTemplateRepo } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';

export default async function dev(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
    process.exit(1);
  }

  // Generate manifest
  console.log('📋 Generating manifest...');
  try {
    generateManifest(cwd);
  } catch {
    console.warn('⚠ Manifest generation failed — continuing anyway');
  }

  // Start Vite
  console.log('\n🚀 Starting dev server...\n');
  const envDir = isTemplateRepo(cwd) ? cwd : cwd;
  const child = spawn('npx', ['vite', '--open', ...args], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      VITE_KB_LOCAL: 'true',
      VITE_ENV_DIR: envDir,
    },
  });

  child.on('exit', (code) => process.exit(code ?? 0));
}
