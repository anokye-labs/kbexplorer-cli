/**
 * kbexplorer build — Production build.
 */

import { resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { getAppRoot, isTemplateRepo } from '../lib/detect-repo.js';

export default async function build(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
    process.exit(1);
  }

  // Parse --base flag
  const baseIdx = args.indexOf('--base');
  const basePath = baseIdx >= 0 ? args[baseIdx + 1] : undefined;

  // Generate manifest
  console.log('📋 Generating manifest...');
  try {
    const manifestScript = resolve(appRoot, 'scripts', 'generate-manifest.js');
    execSync(`node "${manifestScript}"`, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, VITE_KB_LOCAL: 'true' },
    });
  } catch {
    console.warn('⚠ Manifest generation failed — continuing anyway');
  }

  // Build
  console.log('\n🔨 Building...\n');
  const outDir = isTemplateRepo(cwd) ? resolve(cwd, 'dist') : resolve(cwd, 'dist', 'kb');

  const viteArgs = ['vite', 'build', '--outDir', outDir, '--emptyOutDir'];
  if (basePath) viteArgs.push('--base', basePath);

  const child = spawn('npx', viteArgs, {
    cwd: appRoot,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      VITE_KB_LOCAL: 'true',
      VITE_ENV_DIR: cwd,
      ...(basePath ? { VITE_BASE_PATH: basePath } : {}),
    },
  });

  child.on('exit', (code) => {
    if (code === 0) {
      // Copy index.html to 404.html for SPA routing
      try {
        const { copyFileSync } = await import('node:fs');
        copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'));
        console.log('✓ Copied 404.html for SPA routing');
      } catch { /* ignore */ }
      console.log(`\n✅ Built to ${outDir}`);
    }
    process.exit(code ?? 0);
  });
}
