#!/usr/bin/env node
/**
 * Playwright verifier for the dogfood preview.
 *
 * Assumes `node scripts/preview-self-kb.js` is running in another shell.
 * Navigates to the dev server, waits for the graph to render, captures
 * screenshots, and reports console errors.
 *
 * Usage:
 *   node scripts/verify-self-kb.js
 *   node scripts/verify-self-kb.js --url http://localhost:5173
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, watch as fsWatch, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_DIR = join(REPO_ROOT, 'dist-screenshots');
const DEFAULT_URL = 'http://localhost:5173';

function argOf(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function log(msg) { console.log(`[verify] ${msg}`); }

async function tryImportPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {}
  try {
    return (await import('@playwright/test')).chromium;
  } catch {}
  return null;
}

function autoInstallPlaywright() {
  const isWin = process.platform === 'win32';
  log('Installing Playwright (one-time, --no-save)…');
  const install = spawnSync('npm', ['install', '--no-save', 'playwright'], {
    cwd: REPO_ROOT, stdio: 'inherit', shell: isWin,
  });
  if (install.status !== 0) {
    log(`npm install exited with status ${install.status}`);
    return false;
  }
  log('Downloading Chromium browser…');
  const browsers = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: REPO_ROOT, stdio: 'inherit', shell: isWin,
  });
  if (browsers.status !== 0) {
    log(`playwright install chromium exited with status ${browsers.status}`);
    return false;
  }
  return true;
}

async function loadChromium() {
  let chromium = await tryImportPlaywright();
  if (chromium) return chromium;

  if (process.argv.includes('--no-auto-install')) {
    console.error('[verify] Playwright is not installed and --no-auto-install was set.');
    console.error('  Install manually: npm install --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }

  if (process.env.KBEXPLORER_VERIFY_REEXECED === '1') {
    console.error('[verify] Playwright still not importable after auto-install. Install manually:');
    console.error('  npm install --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }

  if (!autoInstallPlaywright()) {
    console.error('[verify] Auto-install failed. Install manually:');
    console.error('  npm install --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }

  // Node's ESM loader caches failed imports, so re-exec ourselves with a fresh
  // module cache now that playwright is on disk.
  log('Re-executing with fresh module cache…');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, KBEXPLORER_VERIFY_REEXECED: '1' },
  });
  process.exit(child.status ?? 1);
}

const url = argOf('--url', DEFAULT_URL);
const watchMode = process.argv.includes('--watch');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const chromium = await loadChromium();

async function runVerifyPass(browser, label = 'verify') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const IGNORED_CONSOLE_PATTERNS = [/@griffel\/react/];
  const isIgnored = (t) => IGNORED_CONSOLE_PATTERNS.some((re) => re.test(t));
  page.on('pageerror', (err) => {
    if (!isIgnored(err.message)) consoleErrors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnored(msg.text())) {
      consoleErrors.push(`console.error: ${msg.text()}`);
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (err) {
    await ctx.close();
    return { ok: false, reason: `Failed to load ${url}: ${err.message}` };
  }

  await page.waitForSelector('canvas, .react-flow, [class*="ReactFlow"], main', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const title = await page.title();
  const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  const missing = ['kbexplorer'].filter((s) => !visibleText.toLowerCase().includes(s));

  const stamp = label === 'verify' ? '' : `-${label}`;
  const homePath = join(SCREENSHOT_DIR, `home${stamp}.png`);
  await page.screenshot({ path: homePath, fullPage: true });
  await page.goto(`${url}/#/node/home`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  const nodePath = join(SCREENSHOT_DIR, `node-home${stamp}.png`);
  await page.screenshot({ path: nodePath, fullPage: true });

  await ctx.close();
  return {
    ok: missing.length === 0 && consoleErrors.length === 0,
    title,
    missingSnippets: missing,
    consoleErrors,
    screenshots: [homePath, nodePath],
  };
}

function hostWatchPaths(cwd) {
  return [
    resolve(cwd, 'content'),
    resolve(cwd, 'README.md'),
    resolve(cwd, 'config.yaml'),
    resolve(cwd, '.kbexplorer.json'),
  ].filter((p) => existsSync(p));
}

log(`Launching Chromium against ${url}`);
const browser = await chromium.launch({ headless: true });

if (!watchMode) {
  const result = await runVerifyPass(browser);
  await browser.close();
  console.log('\n=== verify report ===');
  console.log(JSON.stringify({ url, ...result }, null, 2));
  if (!result.ok) {
    console.error('[verify] FAIL — see report above.');
    process.exit(1);
  }
  log('PASS');
  process.exit(0);
}

// Watch mode: run once, then re-run on host content changes.
log('Watch mode: re-runs on content/README/config changes. Ctrl-C to exit.');
let passCount = 0;
async function runAndReport(label) {
  passCount += 1;
  const tag = `pass${passCount}`;
  const t0 = Date.now();
  const result = await runVerifyPass(browser, tag);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const ts = new Date().toLocaleTimeString();
  if (result.ok) {
    log(`[${ts}] ✓ PASS (${dt}s, ${label}) — title="${result.title}"`);
  } else {
    log(`[${ts}] ✗ FAIL (${dt}s, ${label})`);
    if (result.reason) log(`        ${result.reason}`);
    if (result.missingSnippets?.length) log(`        missing: ${result.missingSnippets.join(', ')}`);
    for (const e of result.consoleErrors || []) log(`        ${e}`);
  }
}

await runAndReport('initial');

const watchers = [];
let debounce = null;
const onChange = (filename, dir) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => runAndReport(filename || dir), 600);
};
for (const p of hostWatchPaths(REPO_ROOT)) {
  try {
    watchers.push(fsWatch(p, { recursive: true }, (_evt, filename) => onChange(filename, p)));
  } catch (err) {
    log(`Watch failed for ${p}: ${err.message}`);
  }
}
log(`Watching ${watchers.length} path(s)`);

const cleanup = async () => {
  for (const w of watchers) { try { w.close(); } catch {} }
  await browser.close();
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
