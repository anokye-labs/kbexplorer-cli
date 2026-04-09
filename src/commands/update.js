/**
 * kbexplorer update — Pull latest template + refresh agents/skills.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { hasSubmodule, isTemplateRepo } from '../lib/detect-repo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');

export default async function update(args) {
  const cwd = process.cwd();

  // Update submodule
  if (!isTemplateRepo(cwd) && hasSubmodule(cwd)) {
    console.log('📦 Updating .kbexplorer submodule...');
    try {
      execSync('git -C .kbexplorer pull origin main', { cwd, stdio: 'inherit' });
      execSync('npm install --no-audit --no-fund', {
        cwd: resolve(cwd, '.kbexplorer'),
        stdio: 'inherit',
      });
      console.log('✓ Submodule updated');
    } catch (err) {
      console.warn('⚠ Submodule update failed:', err.message);
    }
  }

  // Refresh agents
  const agentsDir = resolve(cwd, '.github', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentsSrc = resolve(ASSETS_DIR, 'agents');
  for (const f of readdirSync(agentsSrc)) {
    copyFileSync(resolve(agentsSrc, f), resolve(agentsDir, f));
  }
  console.log('✓ Refreshed agents in .github/agents/');

  // Refresh skills
  const skillsDir = resolve(cwd, '.github', 'skills', 'kbexplorer', 'references');
  mkdirSync(skillsDir, { recursive: true });
  const skillsSrc = resolve(ASSETS_DIR, 'skills', 'kbexplorer');
  copyFileSync(resolve(skillsSrc, 'SKILL.md'), resolve(cwd, '.github', 'skills', 'kbexplorer', 'SKILL.md'));
  const refsSrc = resolve(skillsSrc, 'references');
  for (const f of readdirSync(refsSrc)) {
    copyFileSync(resolve(refsSrc, f), resolve(skillsDir, f));
  }
  console.log('✓ Refreshed skills in .github/skills/kbexplorer/');

  console.log('\n✅ Update complete.');
}
