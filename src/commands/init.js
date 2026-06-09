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
  rmSync,
  renameSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { detectGitRemote, detectBranch, isTemplateRepo, hasSubmodule } from '../lib/detect-repo.js';
import { getLatestTag, checkoutTag, checkoutRef, resolveHeadSha, TEMPLATE_REPO } from '../lib/version.js';
import { parseInitArgs } from '../lib/args.js';
import { writeSourceRecord, readSourceRecord, classifyRef, SOURCE_FILE } from '../lib/source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');

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

function safeRemove(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* best effort */ }
}

/**
 * Install the template as a git submodule (default). Returns source-record fields.
 */
function installSubmodule(cwd, templateUrl, ref) {
  const refType = classifyRef(ref);
  let resolvedRef = ref;
  let latestTag = null;
  let pinDesc = ref ? ` @ ${ref}` : '';
  if (refType === 'release') {
    latestTag = getLatestTag(templateUrl);
    resolvedRef = latestTag;
    pinDesc = latestTag ? ` (pinned to ${latestTag})` : '';
  }
  console.log(`📦 Adding .kbexplorer submodule from ${templateUrl}${pinDesc}...`);
  execSync(`git submodule add ${templateUrl} .kbexplorer`, { cwd, stdio: 'inherit' });
  try {
    if (refType === 'release' && latestTag) {
      checkoutTag(latestTag, cwd);
    } else if (ref) {
      checkoutRef(ref, cwd);
    }
    execSync('git add .kbexplorer .gitmodules', { cwd, stdio: 'pipe' });
  } catch (err) {
    console.warn(`⚠ Could not pin submodule to ${resolvedRef || ref}: ${err.message}`);
  }
  const resolvedCommit = resolveHeadSha(resolve(cwd, '.kbexplorer'));
  console.log(
    resolvedRef
      ? `✓ Submodule added and pinned to ${resolvedRef}`
      : '✓ Submodule added (no release tags found, using default branch)',
  );
  return { ref: resolvedRef ?? null, refType, resolvedCommit };
}

/**
 * Install the template as a one-time vendored copy (no submodule). Clones into a
 * sibling temp dir, strips .git, validates, then renames into place so a failed
 * clone never leaves a half-installed `.kbexplorer`.
 */
function installVendor(cwd, templateUrl, ref) {
  const refType = classifyRef(ref);
  let resolvedRef = ref;
  if (refType === 'release') {
    resolvedRef = getLatestTag(templateUrl);
  }
  const branchArg = resolvedRef ? `--branch ${resolvedRef} ` : '';
  const tmp = resolve(cwd, `.kbexplorer.tmp-${Date.now()}`);
  console.log(`📦 Vendoring template from ${templateUrl}${resolvedRef ? ` @ ${resolvedRef}` : ''}...`);
  try {
    execSync(`git clone --depth 1 ${branchArg}${templateUrl} "${tmp}"`, { cwd, stdio: 'inherit' });
  } catch (err) {
    safeRemove(tmp);
    throw new Error(`Failed to clone template: ${err.message}`);
  }
  const resolvedCommit = resolveHeadSha(tmp);
  safeRemove(resolve(tmp, '.git'));
  if (!existsSync(resolve(tmp, 'package.json'))) {
    safeRemove(tmp);
    throw new Error('Cloned template has no package.json — aborting.');
  }
  renameSync(tmp, resolve(cwd, '.kbexplorer'));
  console.log(`✓ Vendored template into .kbexplorer/${resolvedRef ? ` (${resolvedRef})` : ''}`);
  return { ref: resolvedRef ?? null, refType, resolvedCommit };
}

function printInitHelp() {
  console.log(`
  kbexplorer init — set up the knowledge base in this repo

  Usage: kbexplorer init [options]

  Options:
    --template, -t <url>       Install from a custom template repo
                               (default: anokye-labs/kbexplorer-template)
    --ref, --branch <ref>      Install a specific tag or branch
                               (default: latest release tag)
    --vendor, --no-submodule   One-time copy instead of a git submodule
    --help, -h                 Show this help

  Examples:
    kbexplorer init
    kbexplorer init --template https://github.com/my-org/my-template.git
    kbexplorer init --vendor --ref main
`);
}

export default async function init(args) {
  const opts = parseInitArgs(args);
  if (opts.help) {
    printInitHelp();
    return;
  }
  const cwd = process.cwd();
  const templateUrl = opts.template || TEMPLATE_REPO;
  const mode = opts.vendor ? 'vendor' : 'submodule';
  const prompt = createPrompt();
  const selfHosted = isTemplateRepo(cwd);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     kbexplorer — Interactive Setup       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Step 1: Install the template (submodule by default, or a vendored copy)
  if (!selfHosted && !hasSubmodule(cwd)) {
    try {
      const result = opts.vendor
        ? installVendor(cwd, templateUrl, opts.ref)
        : installSubmodule(cwd, templateUrl, opts.ref);
      writeSourceRecord(cwd, {
        template: templateUrl,
        ref: result.ref,
        refType: result.refType,
        resolvedCommit: result.resolvedCommit,
        mode,
      });
      console.log(`✓ Recorded template source in ${SOURCE_FILE}`);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      prompt.close();
      process.exit(1);
    }
  } else if (selfHosted) {
    console.log('📍 Self-hosted mode (template repo)');
  } else {
    // .kbexplorer already present — never reinstall or silently convert modes.
    const existing = readSourceRecord(cwd);
    console.log('📍 .kbexplorer already present — skipping install.');
    if (existing && existing.mode !== mode) {
      console.warn(
        `⚠ Existing install mode is "${existing.mode}", but "${mode}" was requested. ` +
        'Mode conversion is not automatic — remove .kbexplorer first to reinstall.',
      );
    }
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

  // Install deps in the template (submodule or vendored copy)
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

  if (mode === 'vendor' && !selfHosted && hasSubmodule(cwd)) {
    console.log('\nℹ Vendored template lives in .kbexplorer/ (one-time copy, not a submodule).');
    console.log('  • Commit it to version your customizations, or');
    console.log('  • add ".kbexplorer/" to .gitignore to treat it as a re-fetchable dependency.');
    console.log('  Run `kbexplorer update` to fetch a newer template version (never clobbers).');
  }

  prompt.close();

  console.log('\n───────────────────────────────────────────');
  console.log('✅ kbexplorer is configured!');
  console.log('');
  console.log('  Get started:');
  console.log('    npx kbexplorer dev               Start the dev server');
  console.log('    npx kbexplorer generate          Build a catalogue + content');
  console.log('');
  console.log('  Lifecycle helpers:');
  console.log('    npx kbexplorer scaffold <slug> --cluster <id>   Add a single page');
  console.log('    npx kbexplorer audit                            Validate frontmatter integrity');
  console.log('    npx kbexplorer affected <git-ref>               Diff → impacted nodes');
  console.log('    npx kbexplorer links                            Graph health report');
  console.log('');
  console.log('  Skill docs:');
  console.log('    .github/skills/kbexplorer/SKILL.md and references/');
  console.log('───────────────────────────────────────────\n');
}
