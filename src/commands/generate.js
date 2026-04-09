/**
 * kbexplorer generate — Run content generation pipeline.
 *
 * This is a placeholder — the actual pipeline orchestration happens via
 * the kb-architect and kb-writer agents in Copilot CLI. This command
 * handles the non-agent parts: transform catalogue + regenerate manifest.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getAppRoot } from '../lib/detect-repo.js';
import { transformCatalogue } from '../lib/transform.js';

export default async function generate(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  // Check for catalogue.json (produced by kb-architect agent)
  const cataloguePath = resolve(cwd, 'catalogue.json');
  if (existsSync(cataloguePath)) {
    console.log('📋 Found catalogue.json — transforming to content...');
    const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf-8'));
    const contentDir = resolve(cwd, 'content');
    transformCatalogue(catalogue, contentDir);
  } else {
    console.log('No catalogue.json found.');
    console.log('');
    console.log('To generate content, use the kb-architect agent in Copilot CLI:');
    console.log('  1. Ask: "Use the kb-architect agent to analyze this repo"');
    console.log('  2. The agent will produce catalogue.json');
    console.log('  3. Run: npx kbexplorer generate');
    console.log('');
    console.log('Or run the full pipeline:');
    console.log('  Ask: "Use /kb:generate to create content for this repo"');
    process.exit(0);
  }

  // Regenerate manifest
  if (appRoot) {
    console.log('\n📋 Regenerating manifest...');
    const manifestScript = resolve(appRoot, 'scripts', 'generate-manifest.js');
    if (existsSync(manifestScript)) {
      execSync(`node "${manifestScript}"`, {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, VITE_KB_LOCAL: 'true' },
      });
    }
  }

  console.log('\n✅ Content generated. Run `npx kbexplorer dev` to preview.');
}
