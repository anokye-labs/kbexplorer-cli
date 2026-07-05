/**
 * kbx build — Production build.
 *
 * Mirrors `dev`'s host-root threading so the build ships the HOST repo's
 * authored content, not the template's own demo content:
 *   1. Generate the manifest via {@link writeHostManifest} with
 *      VITE_KB_HOST_ROOT pointed at the host repo (identical to `dev`).
 *   2. Spawn the Vite build with the SAME VITE_KB_HOST_ROOT. The template's
 *      vite plugin re-runs generate-manifest.js at buildStart, so it must see
 *      the host root — otherwise the template's detectHostRoot() falls back to
 *      its own directory and bakes the template's demo nodes into dist/.
 */

import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getAppRoot, isTemplateRepo } from '../lib/detect-repo.ts';
import { writeHostManifest } from './dev.ts';
import { parseBuildArgs } from '../lib/args.ts';

/**
 * Environment for the Vite production build. Threads VITE_KB_HOST_ROOT (the
 * host repo) so the template's build-time manifest reflects the host's authored
 * content — identical to how `dev` spawns Vite. Omitting VITE_KB_HOST_ROOT is
 * the bug that makes `kbx build` silently ship the template's demo content.
 *
 * @param {string} cwd host repo root (process.cwd())
 * @param {string} [basePath] optional --base value
 */
export function buildViteEnv(cwd: string, basePath?: string | null): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITE_KB_LOCAL: 'true',
    VITE_ENV_DIR: cwd,
    VITE_KB_HOST_ROOT: cwd,
    ...(basePath ? { VITE_BASE_PATH: basePath } : {}),
  };
}

export default async function build(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbx not found. Run `kbx init` first.');
    process.exit(1);
  }

  const opts = parseBuildArgs(args);
  const basePath = opts.base;

  // Generate the manifest against the HOST repo (identical to `dev`). Seeds an
  // initial host-correct manifest before Vite spins up; the vite plugin re-runs
  // the same script at buildStart with the same VITE_KB_HOST_ROOT.
  console.log('📋 Generating manifest...');
  try {
    const r = await writeHostManifest(cwd, appRoot);
    if (r.via === 'cli-fallback') {
      console.warn('⚠ Used CLI fallback generator — manifest may be missing template-derived fields');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Manifest generation failed: ${message} — continuing anyway`);
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
    env: buildViteEnv(cwd, basePath),
  });

  child.on('exit', async (code) => {
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
