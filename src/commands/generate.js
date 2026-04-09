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

export default async function generate(args) {
  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  // Check for catalogue.json (produced by kb-architect agent)
  const cataloguePath = resolve(cwd, 'catalogue.json');
  if (existsSync(cataloguePath)) {
    console.log('📋 Found catalogue.json — transforming to content...');
    const transformScript = resolve(appRoot || cwd, 'scripts', 'transform-catalogue.js');
    if (existsSync(transformScript)) {
      execSync(`node "${transformScript}" "${cataloguePath}" content`, {
        cwd,
        stdio: 'inherit',
      });
    } else {
      console.error('✗ transform-catalogue.js not found. Run `kbexplorer init` first.');
      process.exit(1);
    }
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
