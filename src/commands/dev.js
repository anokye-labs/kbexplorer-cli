/**
 * kbexplorer dev — Start dev server in local mode.
 *
 * Pipeline:
 *   1. Run our own generateManifest(host) once to know what to write.
 *   2. Spawn Vite in the template directory. The template's vite plugin will
 *      run its own (currently buggy in vendored mode — see template#220)
 *      generate-manifest.js at buildStart.
 *   3. After Vite is up, OVERWRITE .kbexplorer/src/generated/repo-manifest.json
 *      with the host-correct manifest so the UI shows the host's content.
 *   4. Unless --no-watch is set, watch host content/README/config and re-emit
 *      the manifest on change. Vite HMRs the JSON.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, watch as fsWatch, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getAppRoot, isTemplateRepo } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';

const DEBOUNCE_MS = 200;
const POST_VITE_WRITE_DELAY_MS = 1500;

export function manifestOutPath(appRoot) {
  return resolve(appRoot, 'src', 'generated', 'repo-manifest.json');
}

export function writeHostManifest(cwd, appRoot) {
  const manifest = generateManifest(cwd);
  const outPath = manifestOutPath(appRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return { outPath, manifest };
}

export function watchPaths(cwd, contentDir = 'content') {
  return [
    resolve(cwd, contentDir),
    resolve(cwd, 'README.md'),
    resolve(cwd, 'config.yaml'),
    resolve(cwd, contentDir, 'config.yaml'),
    resolve(cwd, '.kbexplorer.json'),
  ].filter((p) => existsSync(p));
}

export default async function dev(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);
  const noWatch = args.includes('--no-watch');
  const viteArgs = args.filter((a) => a !== '--no-watch');

  if (!appRoot) {
    console.error('✗ kbexplorer not found. Run `kbexplorer init` first.');
    process.exit(1);
  }

  // 1. Initial host manifest write (before Vite, so first render is correct
  //    even before the template plugin gets a chance to clobber).
  console.log('📋 Generating host manifest...');
  try {
    writeHostManifest(cwd, appRoot);
  } catch (err) {
    console.warn(`⚠ Manifest generation failed: ${err.message} — continuing anyway`);
  }

  // 2. Start Vite.
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

  // 3. After Vite's buildStart plugin has had a chance to run, overwrite the
  //    manifest with the host-correct one. Workaround for template#220.
  const overwriteTimer = setTimeout(() => {
    try {
      writeHostManifest(cwd, appRoot);
      console.log('✓ Wrote host-correct manifest (template-bug workaround)');
    } catch (err) {
      console.warn(`⚠ Post-Vite manifest write failed: ${err.message}`);
    }
  }, POST_VITE_WRITE_DELAY_MS);

  // 4. Watcher.
  const watchers = [];
  if (!noWatch) {
    let debounceTimer = null;
    const onChange = (label) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const { manifest } = writeHostManifest(cwd, appRoot);
          const ts = new Date().toLocaleTimeString();
          console.log(
            `[${ts}] 🔄 manifest regenerated (${label}) — ${Object.keys(manifest.authoredContent).length} content, ${manifest.tree.length} tree, ${manifest.issues.length} issues`
          );
        } catch (err) {
          console.warn(`⚠ Manifest regen failed: ${err.message}`);
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
        console.warn(`⚠ Watch failed for ${p}: ${err.message}`);
      }
    }
    console.log(`👀 Watching ${watchers.length} path(s) for content changes\n`);
  }

  const cleanup = (code) => {
    clearTimeout(overwriteTimer);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    process.exit(code ?? 0);
  };

  child.on('exit', cleanup);
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
}
