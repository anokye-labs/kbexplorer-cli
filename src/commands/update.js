/**
 * kbexplorer update — Check for template updates, ask before upgrading.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hasSubmodule, isTemplateRepo } from '../lib/detect-repo.js';
import { getCurrentTag, getLatestTag, getAvailableTags, checkoutTag } from '../lib/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer.trim()); });
  });
}

function refreshAssets(cwd) {
  const agentsDir = resolve(cwd, '.github', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentsSrc = resolve(ASSETS_DIR, 'agents');
  for (const f of readdirSync(agentsSrc)) {
    copyFileSync(resolve(agentsSrc, f), resolve(agentsDir, f));
  }
  console.log('✓ Refreshed agents in .github/agents/');

  const skillsDir = resolve(cwd, '.github', 'skills', 'kbexplorer', 'references');
  mkdirSync(skillsDir, { recursive: true });
  const skillsSrc = resolve(ASSETS_DIR, 'skills', 'kbexplorer');
  copyFileSync(resolve(skillsSrc, 'SKILL.md'), resolve(cwd, '.github', 'skills', 'kbexplorer', 'SKILL.md'));
  const refsSrc = resolve(skillsSrc, 'references');
  for (const f of readdirSync(refsSrc)) {
    copyFileSync(resolve(refsSrc, f), resolve(skillsDir, f));
  }
  console.log('✓ Refreshed skills in .github/skills/kbexplorer/');
}

export default async function update(args) {
  const cwd = process.cwd();
  const force = args.includes('--force') || args.includes('-f');

  // Refresh agents/skills (always — these come from the CLI package, not the submodule)
  refreshAssets(cwd);

  // Update submodule
  if (!isTemplateRepo(cwd) && hasSubmodule(cwd)) {
    const currentTag = getCurrentTag(cwd);
    const latestTag = getLatestTag();

    console.log(`\n📦 Template submodule`);
    console.log(`  Current: ${currentTag || 'unknown'}`);
    console.log(`  Latest:  ${latestTag || 'unknown'}`);

    if (!latestTag) {
      console.log('  ⚠ Could not fetch latest tag from remote');
      console.log('\n✅ Agents/skills refreshed. Template unchanged.');
      return;
    }

    if (currentTag === latestTag) {
      console.log('  ✓ Already on latest release');
      console.log('\n✅ Everything up to date.');
      return;
    }

    // Show what's new
    console.log(`\n  New version available: ${currentTag || '?'} → ${latestTag}`);
    try {
      const submodulePath = resolve(cwd, '.kbexplorer');
      execSync('git fetch --tags', { cwd: submodulePath, stdio: 'pipe' });
      const log = execSync(
        `git log --oneline ${currentTag?.startsWith('v') ? currentTag + '..' + latestTag : latestTag + ' -10'}`,
        { cwd: submodulePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (log) {
        console.log('\n  Changes:');
        for (const line of log.split('\n').slice(0, 10)) {
          console.log(`    ${line}`);
        }
      }
    } catch { /* couldn't get log — that's ok */ }

    if (!force) {
      const answer = await ask(`\n  Update to ${latestTag}? (y/N): `);
      if (!answer.toLowerCase().startsWith('y')) {
        console.log('  Skipped. Run with --force to skip this prompt.');
        console.log('\n✅ Agents/skills refreshed. Template unchanged.');
        return;
      }
    }

    // Do the update
    try {
      checkoutTag(latestTag, cwd);
      execSync('git add .kbexplorer', { cwd });
      execSync('npm install --no-audit --no-fund', {
        cwd: resolve(cwd, '.kbexplorer'),
        stdio: 'inherit',
      });
      console.log(`  ✓ Updated to ${latestTag}`);
    } catch (err) {
      console.error('  ✗ Update failed:', err.message);
    }
  }

  console.log('\n✅ Update complete.');
}
