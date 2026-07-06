/**
 * kbexplorer dev — Start dev server in local mode.
 *
 * Pipeline:
 *   1. Run the template's generate-manifest.js with VITE_KB_HOST_ROOT pointed at
 *      the host repo to seed an initial, schema-complete manifest before Vite
 *      spins up. The template's detectHostRoot() honors VITE_KB_HOST_ROOT, so no
 *      post-install patching of the template script is needed.
 *   2. Spawn Vite in the template directory. The template's vite plugin re-runs
 *      the same script at buildStart, so the in-server manifest is already
 *      host-correct (no post-spawn overwrite needed).
 *   3. Unless --no-watch is set, watch host content/README/config and re-run
 *      the template script on change. Vite HMRs the JSON.
 */

import { spawn, spawnSync } from 'node:child_process';
import { watch as fsWatch, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getAppRoot, isTemplateRepo } from '../lib/detect-repo.ts';
import { buildRepoManifest } from '../lib/manifest-build.ts';
import { parseDevArgs } from '../lib/args.ts';

const DEBOUNCE_MS = 200;

type WriteHostManifestResult =
  | { outPath: string; via: 'template-script' }
  | {
      outPath: string;
      via: 'cli-fallback';
      manifest: Awaited<ReturnType<typeof buildRepoManifest>>;
    };

export function manifestOutPath(appRoot: string): string {
  return resolve(appRoot, 'src', 'generated', 'repo-manifest.json');
}

/**
 * Regenerate the manifest by invoking the template's own generate-manifest.js
 * with VITE_KB_HOST_ROOT pointing at the host repo. This preserves the
 * template's full enriched schema (themeFileRaw, nodemap*, etc.) which the
 * engine's buildManifest() doesn't know about.
 *
 * Falls back to the engine-backed thin builder if the template script is
 * missing or exits non-zero — better a partial manifest than a blank UI.
 */
export async function writeHostManifest(cwd: string, appRoot: string): Promise<WriteHostManifestResult> {
  const script = resolve(appRoot, 'scripts', 'generate-manifest.js');
  if (existsSync(script)) {
    const r = spawnSync('node', [script], {
      cwd: appRoot,
      env: { ...process.env, VITE_KB_HOST_ROOT: cwd, VITE_KB_LOCAL: 'true' },
      encoding: 'utf-8',
    });
    if (r.status === 0) return { outPath: manifestOutPath(appRoot), via: 'template-script' };
    console.warn(`⚠ Template manifest script exited ${r.status}; falling back. stderr: ${r.stderr?.slice(0, 200)}`);
  }
  const manifest = await buildRepoManifest(cwd);
  const outPath = manifestOutPath(appRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return { outPath, via: 'cli-fallback', manifest };
}

export function watchPaths(cwd: string, contentDir = 'content'): string[] {
  return [
    resolve(cwd, contentDir),
    resolve(cwd, 'README.md'),
    resolve(cwd, 'config.yaml'),
    resolve(cwd, contentDir, 'config.yaml'),
    resolve(cwd, '.kbx.json'),
  ].filter((p): p is string => existsSync(p));
}

export default async function dev(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);
  const opts = parseDevArgs(args);
  const noWatch = opts.noWatch;
  const viteArgs = opts.viteArgs;

  if (!appRoot) {
    const { hasLegacyDir } = await import('../lib/detect-repo.ts');
    if (hasLegacyDir(cwd)) {
      console.error('✗ Found legacy .kbexplorer/ directory. Rename it to .kbx/ or re-run `kbx init`.');
    } else {
      console.error('✗ kbx not found. Run `kbx init` first.');
    }
    process.exit(1);
  }

  // 1. Initial manifest write via patched template script.
  console.log('📋 Generating host manifest...');
  try {
    const r = await writeHostManifest(cwd, appRoot);
    if (r.via === 'cli-fallback') {
      console.warn('⚠ Used CLI fallback generator — UI may be missing template-derived fields');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Manifest generation failed: ${message} — continuing anyway`);
  }

  // 2. Start Vite. The template plugin will re-run the same patched script.
  console.log('\n🚀 Starting dev server...\n');
  const envDir = isTemplateRepo(cwd) ? cwd : cwd;
  const child = spawn('npx', ['vite', '--open', ...viteArgs], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      VITE_KB_LOCAL: 'true',
      VITE_ENV_DIR: envDir,
      VITE_KB_HOST_ROOT: cwd,
    },
  });

  // 3. Watcher.
  const watchers: Array<ReturnType<typeof fsWatch>> = [];
  if (!noWatch) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (label: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          await writeHostManifest(cwd, appRoot);
          const ts = new Date().toLocaleTimeString();
          console.log(`[${ts}] 🔄 manifest regenerated (${label})`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`⚠ Manifest regen failed: ${message}`);
        }
      }, DEBOUNCE_MS);
    };

    for (const p of watchPaths(cwd)) {
      try {
        const w = fsWatch(p, { recursive: true }, (_evt, filename) => {
          onChange(filename || p);
        });
        watchers.push(w);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`⚠ Watch failed for ${p}: ${message}`);
      }
    }
    console.log(`👀 Watching ${watchers.length} path(s) for content changes\n`);
  }

  const cleanup = (code: number | null): void => {
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    process.exit(code ?? 0);
  };

  child.on('exit', cleanup);
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
}
