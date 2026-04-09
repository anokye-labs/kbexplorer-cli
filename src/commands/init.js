/**
 * kbexplorer init — Add submodule, install agents/skills, configure.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { detectGitRemote, detectBranch, isTemplateRepo, hasSubmodule } from '../lib/detect-repo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');
const TEMPLATE_REPO = 'https://github.com/anokye-labs/kbexplorer-template.git';

function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question, defaultValue) {
      return new Promise((res) => {
        const suffix = defaultValue != null ? ` [${defaultValue}]` : '';
        rl.question(`${question}${suffix}: `, (answer) => {
          res(answer.trim() || defaultValue || '');
        });
      });
    },
    async choose(question, options, defaultIndex = 0) {
      console.log(`\n${question}`);
      options.forEach((opt, i) => {
        const marker = i === defaultIndex ? '→' : ' ';
        console.log(`  ${marker} ${i + 1}. ${opt}`);
      });
      const answer = await this.ask(`Choose (1-${options.length})`, String(defaultIndex + 1));
      const idx = parseInt(answer, 10) - 1;
      return idx >= 0 && idx < options.length ? idx : defaultIndex;
    },
    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? 'Y/n' : 'y/N';
      const answer = await this.ask(`${question} (${hint})`);
      if (!answer) return defaultYes;
      return answer.toLowerCase().startsWith('y');
    },
    close() { rl.close(); },
  };
}

function copyAssets(cwd) {
  // Copy agents
  const agentsDir = resolve(cwd, '.github', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentsSrc = resolve(ASSETS_DIR, 'agents');
  for (const f of readdirSync(agentsSrc)) {
    copyFileSync(resolve(agentsSrc, f), resolve(agentsDir, f));
  }
  console.log(`✓ Installed agents to .github/agents/`);

  // Copy skills
  const skillsDir = resolve(cwd, '.github', 'skills', 'kbexplorer', 'references');
  mkdirSync(skillsDir, { recursive: true });
  const skillsSrc = resolve(ASSETS_DIR, 'skills', 'kbexplorer');
  copyFileSync(resolve(skillsSrc, 'SKILL.md'), resolve(cwd, '.github', 'skills', 'kbexplorer', 'SKILL.md'));
  const refsSrc = resolve(skillsSrc, 'references');
  for (const f of readdirSync(refsSrc)) {
    copyFileSync(resolve(refsSrc, f), resolve(skillsDir, f));
  }
  console.log(`✓ Installed skills to .github/skills/kbexplorer/`);
}

export default async function init(args) {
  const cwd = process.cwd();
  const prompt = createPrompt();
  const selfHosted = isTemplateRepo(cwd);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     kbexplorer — Interactive Setup       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Step 1: Add submodule (if not self-hosted and not already present)
  if (!selfHosted && !hasSubmodule(cwd)) {
    console.log('📦 Adding .kbexplorer submodule...');
    try {
      execSync(`git submodule add ${TEMPLATE_REPO} .kbexplorer`, {
        cwd,
        stdio: 'inherit',
      });
      console.log('✓ Submodule added');
    } catch (err) {
      console.error('✗ Failed to add submodule:', err.message);
      prompt.close();
      process.exit(1);
    }
  } else if (selfHosted) {
    console.log('📍 Self-hosted mode (template repo)');
  } else {
    console.log('📍 .kbexplorer submodule already present');
  }

  // Step 2: Install agents/skills
  copyAssets(cwd);

  // Step 3: Interactive config
  const detected = detectGitRemote(cwd);
  const detectedBranch = detectBranch(cwd);

  const owner = await prompt.ask('GitHub owner', detected?.owner ?? '');
  const repo = await prompt.ask('GitHub repo', detected?.repo ?? '');
  const branch = await prompt.ask('Branch', detectedBranch);
  const title = await prompt.ask('Knowledge base title', `${repo} Knowledge Base`);

  const contentModeIdx = await prompt.choose(
    'Content mode:',
    ['Repo-aware (issues, PRs, README, file tree)', 'Authored (markdown files)', 'Both'],
    0,
  );
  let contentPath;
  if (contentModeIdx === 1 || contentModeIdx === 2) {
    contentPath = await prompt.ask('Content directory', 'content');
  }

  const visualModes = ['emoji', 'sprites', 'heroes', 'none'];
  const visualIdx = await prompt.choose('Visual mode:', visualModes, 0);

  const themes = ['dark', 'light', 'sepia'];
  const themeIdx = await prompt.choose('Default theme:', themes, 0);

  // Step 4: Write config files
  const envLines = [
    `VITE_KB_OWNER=${owner}`,
    `VITE_KB_REPO=${repo}`,
    `VITE_KB_BRANCH=${branch}`,
    `VITE_KB_TITLE=${title}`,
  ];
  if (contentPath) envLines.push(`VITE_KB_PATH=${contentPath}`);

  writeFileSync(resolve(cwd, '.env.kbexplorer'), envLines.join('\n') + '\n', 'utf-8');
  console.log('✓ Created .env.kbexplorer');

  // Update .gitignore
  const gitignorePath = resolve(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.env.kbexplorer')) {
      writeFileSync(gitignorePath, content.trimEnd() + '\n.env.kbexplorer\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, '.env.kbexplorer\n', 'utf-8');
  }
  console.log('✓ Updated .gitignore');

  // Add npm scripts
  const pkgPath = resolve(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts['kb:dev'] = 'kbexplorer dev';
    pkg.scripts['kb:build'] = 'kbexplorer build';
    pkg.scripts['kb:generate'] = 'kbexplorer generate';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log('✓ Added kb:dev, kb:build, kb:generate scripts');
  }

  // Install deps in submodule
  if (!selfHosted && hasSubmodule(cwd)) {
    console.log('\n📦 Installing kbexplorer dependencies...');
    try {
      execSync('npm install --no-audit --no-fund', {
        cwd: resolve(cwd, '.kbexplorer'),
        stdio: 'inherit',
      });
      console.log('✓ Dependencies installed');
    } catch {
      console.warn('⚠ npm install failed — run manually in .kbexplorer/');
    }
  }

  prompt.close();

  console.log('\n───────────────────────────────────────────');
  console.log('✅ kbexplorer is configured!');
  console.log('');
  console.log('  Run: npx kbexplorer dev');
  console.log('  Or:  npx kbexplorer generate');
  console.log('───────────────────────────────────────────\n');
}
