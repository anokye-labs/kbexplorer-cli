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
import { mkdirSync } from 'node:fs';
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
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const chromium = await loadChromium();
log(`Launching Chromium against ${url}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
// Third-party noise we choose to ignore (template/Fluent UI churn, not ours).
const IGNORED_CONSOLE_PATTERNS = [
  /@griffel\/react/,
];
function isIgnored(text) {
  return IGNORED_CONSOLE_PATTERNS.some((re) => re.test(text));
}
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
  console.error(`[verify] Failed to load ${url}: ${err.message}`);
  console.error('[verify] Is `node scripts/preview-self-kb.js` running?');
  await browser.close();
  process.exit(1);
}

const graphSelector = 'canvas, .react-flow, [class*="ReactFlow"], main';
await page.waitForSelector(graphSelector, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);

const title = await page.title();
log(`Title: ${title}`);

const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
const expectedSnippets = ['kbexplorer'];
const missing = expectedSnippets.filter((s) => !visibleText.toLowerCase().includes(s));

const homePath = join(SCREENSHOT_DIR, 'home.png');
await page.screenshot({ path: homePath, fullPage: true });
log(`Screenshot: ${homePath}`);

await page.goto(`${url}/#/node/home`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1500);
const nodePath = join(SCREENSHOT_DIR, 'node-home.png');
await page.screenshot({ path: nodePath, fullPage: true });
log(`Screenshot: ${nodePath}`);

await browser.close();

const report = {
  url,
  title,
  missingSnippets: missing,
  consoleErrors,
  screenshots: [homePath, nodePath],
};
console.log('\n=== verify report ===');
console.log(JSON.stringify(report, null, 2));

if (missing.length || consoleErrors.length) {
  console.error('[verify] FAIL — missing snippets or console errors. See report above.');
  process.exit(1);
}
log('PASS');
