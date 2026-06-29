/**
 * kbx init — Add submodule, install agents/skills, configure.
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
import { validateRuntimeBlock, RuntimeConfigError } from '../lib/runtime-config.js';

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
  const skillsDir = resolve(cwd, '.github', 'skills', 'kbx', 'references');
  mkdirSync(skillsDir, { recursive: true });
  const skillsSrc = resolve(ASSETS_DIR, 'skills', 'kbx');
  copyFileSync(resolve(skillsSrc, 'SKILL.md'), resolve(cwd, '.github', 'skills', 'kbx', 'SKILL.md'));
  const refsSrc = resolve(skillsSrc, 'references');
  for (const f of readdirSync(refsSrc)) {
    copyFileSync(resolve(refsSrc, f), resolve(skillsDir, f));
  }
  console.log(`✓ Installed skills to .github/skills/kbx/`);
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
  console.log(`📦 Adding .kbx submodule from ${templateUrl}${pinDesc}...`);
  execSync(`git submodule add ${templateUrl} .kbx`, { cwd, stdio: 'inherit' });
  try {
    if (refType === 'release' && latestTag) {
      checkoutTag(latestTag, cwd);
    } else if (ref) {
      checkoutRef(ref, cwd);
    }
    execSync('git add .kbx .gitmodules', { cwd, stdio: 'pipe' });
  } catch (err) {
    console.warn(`⚠ Could not pin submodule to ${resolvedRef || ref}: ${err.message}`);
  }
  const resolvedCommit = resolveHeadSha(resolve(cwd, '.kbx'));
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
 * clone never leaves a half-installed `.kbx`.
 */
function installVendor(cwd, templateUrl, ref) {
  const refType = classifyRef(ref);
  let resolvedRef = ref;
  if (refType === 'release') {
    resolvedRef = getLatestTag(templateUrl);
  }
  const branchArg = resolvedRef ? `--branch ${resolvedRef} ` : '';
  const tmp = resolve(cwd, `.kbx.tmp-${Date.now()}`);
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
  renameSync(tmp, resolve(cwd, '.kbx'));
  console.log(`✓ Vendored template into .kbx/${resolvedRef ? ` (${resolvedRef})` : ''}`);
  return { ref: resolvedRef ?? null, refType, resolvedCommit };
}

function printInitHelp() {
  console.log(`
  kbx init — set up the knowledge base in this repo

  Usage: kbx init [options]

  Options:
    --template, -t <url>       Install from a custom template repo
                               (default: anokye-labs/kbexplorer-template)
    --ref, --branch <ref>      Install a specific template tag or branch
                               (default: latest release tag)
    --vendor, --no-submodule   One-time copy instead of a git submodule
    --mode <submodule|vendor>  Install mode (alternative to --vendor)
    --help, -h                 Show this help

  Non-interactive (CI / templated onboarding):
    --yes, -y                  Take all config from flags/--config + detection
    --owner <name>             GitHub owner (default: detected git remote)
    --repo <name>              GitHub repo (default: detected git remote)
    --kb-branch <name>         KB content branch (default: detected branch)
    --title <text>             KB title (default: "<repo> Knowledge Base")
    --content-mode <m>         repo | authored | both (default: repo)
    --content <dir>            Content dir for authored/both (default: content)
    --visual <m>               emoji | sprites | heroes | none (default: emoji)
    --theme <t>                dark | light | sepia (default: dark)
    --runtime <name>           copilot | claude | custom | skip (default: copilot)
    --runtime-command <cmd>    Custom runtime command (with --runtime custom)
    --runtime-args <tmpl>      Custom runtime args template (use {prompt})
    --runtime-output <fmt>     Custom runtime output format (text | jsonl)
    --config <file>            JSON file of defaults for any of the above

  Examples:
    kbx init
    kbx init --template https://github.com/my-org/my-template.git
    kbx init --vendor --ref main
    kbx init --yes --mode vendor --ref <sha> --owner acme --repo widgets --title "Acme KB"
`);
}

/** Load a JSON defaults file for non-interactive init. Exits 1 on read/parse error. */
function loadInitConfigFile(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    console.error(`✗ Could not read --config file "${absPath}": ${err.message}`);
    process.exit(1);
  }
}

const CONTENT_MODES = ['repo', 'authored', 'both'];
const VISUAL_MODES = ['emoji', 'sprites', 'heroes', 'none'];
const THEMES = ['dark', 'light', 'sepia'];
const RUNTIME_NAMES = ['copilot', 'claude', 'custom', 'skip'];

/**
 * Resolve the full init configuration non-interactively from flags, an optional
 * `--config` JSON file, and git detection — mirroring the defaults the
 * interactive prompts use, so a headless run produces an identical scaffold.
 *
 * Exits 1 with a clear, aggregated error list when a required value is missing
 * or an enum value is invalid.
 *
 * @returns {{ owner, repo, branch, title, contentPath: string|undefined, runtimeBlock: object|null }}
 */
function resolveHeadlessConfig(opts, cwd) {
  const fileCfg = opts.config ? loadInitConfigFile(resolve(cwd, opts.config)) : {};
  const detected = detectGitRemote(cwd);
  const detectedBranch = detectBranch(cwd);
  const errors = [];
  const pick = (flagVal, cfgKey, fallback) =>
    flagVal != null ? flagVal : fileCfg[cfgKey] != null ? fileCfg[cfgKey] : fallback;

  const owner = pick(opts.owner, 'owner', detected?.owner ?? null);
  const repo = pick(opts.repo, 'repo', detected?.repo ?? null);
  if (!owner) errors.push('owner is required (pass --owner, set it in --config, or run inside a git repo with an origin remote)');
  if (!repo) errors.push('repo is required (pass --repo, set it in --config, or run inside a git repo with an origin remote)');

  const branch = pick(opts.kbBranch, 'branch', detectedBranch || 'main');
  const title = pick(opts.title, 'title', repo ? `${repo} Knowledge Base` : null);
  if (!title) errors.push('title could not be derived (pass --title or --repo)');

  const contentMode = String(pick(opts.contentMode, 'contentMode', 'repo')).toLowerCase();
  if (!CONTENT_MODES.includes(contentMode)) {
    errors.push(`--content-mode must be one of ${CONTENT_MODES.join('|')} (got "${contentMode}")`);
  }
  const contentPath = contentMode === 'repo' ? undefined : String(pick(opts.content, 'content', 'content'));

  const visual = String(pick(opts.visual, 'visual', 'emoji')).toLowerCase();
  if (!VISUAL_MODES.includes(visual)) {
    errors.push(`--visual must be one of ${VISUAL_MODES.join('|')} (got "${visual}")`);
  }
  const theme = String(pick(opts.theme, 'theme', 'dark')).toLowerCase();
  if (!THEMES.includes(theme)) {
    errors.push(`--theme must be one of ${THEMES.join('|')} (got "${theme}")`);
  }

  // Runtime block — mirror the interactive choices. copilot/skip → no block.
  let runtimeBlock = null;
  const runtimeFromFile = fileCfg.runtime && typeof fileCfg.runtime === 'object' ? fileCfg.runtime : null;
  const runtimeName = String(pick(opts.runtime, 'runtimeName', runtimeFromFile?.agent ?? 'copilot')).toLowerCase();
  if (!RUNTIME_NAMES.includes(runtimeName)) {
    errors.push(`--runtime must be one of ${RUNTIME_NAMES.join('|')} (got "${runtimeName}")`);
  } else if (runtimeName === 'custom') {
    const command = pick(opts.runtimeCommand, 'runtimeCommand', runtimeFromFile?.command ?? null);
    if (!command) {
      errors.push('--runtime custom requires --runtime-command (or runtime.command in --config)');
    }
    const argsRaw = opts.runtimeArgs != null ? opts.runtimeArgs : null;
    const argsTemplate = argsRaw != null
      ? argsRaw.trim().split(/\s+/).filter(Boolean)
      : Array.isArray(runtimeFromFile?.argsTemplate)
        ? runtimeFromFile.argsTemplate
        : ['-p', '{prompt}'];
    const outputFormat = pick(opts.runtimeOutput, 'runtimeOutput', runtimeFromFile?.outputFormat ?? 'text');
    runtimeBlock = {
      agent: 'custom',
      command: command ?? 'my-agent',
      argsTemplate,
      ...(outputFormat && outputFormat !== 'text' ? { outputFormat } : {}),
    };
  } else if (runtimeName === 'claude') {
    runtimeBlock = { agent: 'claude' };
  }
  // copilot / skip → null (keeps .kbx.json minimal, same as interactive)

  if (errors.length) {
    console.error('✗ Cannot run `init --yes` — missing or invalid configuration:');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }

  return { owner, repo, branch, title, contentPath, runtimeBlock };
}

export default async function init(args) {
  const opts = parseInitArgs(args);
  if (opts.help) {
    printInitHelp();
    return;
  }
  const cwd = process.cwd();
  const templateUrl = opts.template || TEMPLATE_REPO;
  const mode = opts.mode || (opts.vendor ? 'vendor' : 'submodule');
  if (mode !== 'submodule' && mode !== 'vendor') {
    console.error(`✗ Invalid --mode "${mode}" (expected submodule|vendor).`);
    process.exit(1);
  }
  const isVendor = mode === 'vendor';
  const prompt = opts.yes ? null : createPrompt();
  const selfHosted = isTemplateRepo(cwd);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     kbx — Interactive Setup              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Step 1: Install the template (submodule by default, or a vendored copy)
  if (!selfHosted && !hasSubmodule(cwd)) {
    try {
      const result = isVendor
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
      prompt?.close();
      process.exit(1);
    }
  } else if (selfHosted) {
    console.log('📍 Self-hosted mode (template repo)');
  } else {
    // .kbx already present — never reinstall or silently convert modes.
    const existing = readSourceRecord(cwd);
    console.log('📍 .kbx already present — skipping install.');
    if (existing && existing.mode !== mode) {
      console.warn(
        `⚠ Existing install mode is "${existing.mode}", but "${mode}" was requested. ` +
        'Mode conversion is not automatic — remove .kbx first to reinstall.',
      );
    }
  }

  // Step 2: Install agents/skills
  copyAssets(cwd);

  // Step 3: Configuration — interactive prompts or headless (--yes) resolution.
  let owner;
  let repo;
  let branch;
  let title;
  let contentPath;
  let runtimeBlock = null;

  if (opts.yes) {
    ({ owner, repo, branch, title, contentPath, runtimeBlock } = resolveHeadlessConfig(opts, cwd));
    console.log(
      `✓ Non-interactive config (owner=${owner}, repo=${repo}, branch=${branch}, mode=${mode})`,
    );
  } else {
    const detected = detectGitRemote(cwd);
    const detectedBranch = detectBranch(cwd);

    owner = await prompt.ask('GitHub owner', detected?.owner ?? '');
    repo = await prompt.ask('GitHub repo', detected?.repo ?? '');
    branch = await prompt.ask('Branch', detectedBranch);
    title = await prompt.ask('Knowledge base title', `${repo} Knowledge Base`);

    const contentModeIdx = await prompt.choose(
      'Content mode:',
      ['Repo-aware (issues, PRs, README, file tree)', 'Authored (markdown files)', 'Both'],
      0,
    );
    if (contentModeIdx === 1 || contentModeIdx === 2) {
      contentPath = await prompt.ask('Content directory', 'content');
    }

    const visualModes = ['emoji', 'sprites', 'heroes', 'none'];
    await prompt.choose('Visual mode:', visualModes, 0);

    const themes = ['dark', 'light', 'sepia'];
    await prompt.choose('Default theme:', themes, 0);

    // Step 3b: Optional runtime block
    const runtimeAgentIdx = await prompt.choose(
      'Agent runtime for derive/generate fuzzy steps:',
      ['copilot (default)', 'claude', 'custom (provide command + argsTemplate)', 'skip (use default)'],
      0,
    );
    const runtimeAgentName = ['copilot', 'claude', 'custom', null][runtimeAgentIdx];
    if (runtimeAgentName === 'custom') {
      const command = await prompt.ask('Custom agent command', 'my-agent');
      const argsTemplateRaw = await prompt.ask('Args template (space-separated, use {prompt})', '-p {prompt}');
      const argsTemplate = argsTemplateRaw.trim().split(/\s+/).filter(Boolean);
      const outputFormat = await prompt.ask('Output format (text|jsonl)', 'text');
      runtimeBlock = {
        agent: 'custom',
        command,
        argsTemplate,
        ...(outputFormat && outputFormat !== 'text' ? { outputFormat } : {}),
      };
    } else if (runtimeAgentName != null && runtimeAgentName !== 'copilot') {
      // Only write the block when it differs from the default to keep .kbx.json minimal
      runtimeBlock = { agent: runtimeAgentName };
    }
  }

  // Step 4: Write config files
  const envLines = [
    `VITE_KB_OWNER=${owner}`,
    `VITE_KB_REPO=${repo}`,
    `VITE_KB_BRANCH=${branch}`,
    `VITE_KB_TITLE=${title}`,
  ];
  if (contentPath) envLines.push(`VITE_KB_PATH=${contentPath}`);

  writeFileSync(resolve(cwd, '.env.kbx'), envLines.join('\n') + '\n', 'utf-8');
  console.log('✓ Created .env.kbx');

  // Write runtime block into .kbx.json (merge with existing record).
  // Validate first — never persist a block derive/generate would reject.
  if (runtimeBlock != null) {
    try {
      const validated = validateRuntimeBlock(runtimeBlock);
      const existingRecord = readSourceRecord(cwd) ?? {};
      writeSourceRecord(cwd, { ...existingRecord, runtime: validated });
      console.log(`✓ Added runtime block (agent: ${validated.agent}) to ${SOURCE_FILE}`);
    } catch (err) {
      if (!(err instanceof RuntimeConfigError)) throw err;
      console.warn(`⚠ Runtime block not written — ${err.message}`);
      console.warn(`  Add a valid runtime block to ${SOURCE_FILE} manually, or re-run init.`);
    }
  }

  // Update .gitignore
  const gitignorePath = resolve(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.env.kbx')) {
      writeFileSync(gitignorePath, content.trimEnd() + '\n.env.kbx\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, '.env.kbx\n', 'utf-8');
  }
  console.log('✓ Updated .gitignore');

  // Add npm scripts
  const pkgPath = resolve(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts['kb:dev'] = 'kbx dev';
    pkg.scripts['kb:build'] = 'kbx build';
    pkg.scripts['kb:generate'] = 'kbx generate';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log('✓ Added kb:dev, kb:build, kb:generate scripts');
  }

  // Install deps in the template (submodule or vendored copy)
  if (!selfHosted && hasSubmodule(cwd)) {
    console.log('\n📦 Installing kbx dependencies...');
    try {
      execSync('npm install --no-audit --no-fund', {
        cwd: resolve(cwd, '.kbx'),
        stdio: 'inherit',
      });
      console.log('✓ Dependencies installed');
    } catch {
      console.warn('⚠ npm install failed — run manually in .kbx/');
    }
  }

  if (mode === 'vendor' && !selfHosted && hasSubmodule(cwd)) {
    console.log('\nℹ Vendored template lives in .kbx/ (one-time copy, not a submodule).');
    console.log('  • Commit it to version your customizations, or');
    console.log('  • add ".kbx/" to .gitignore to treat it as a re-fetchable dependency.');
    console.log('  Run `kbx update` to fetch a newer template version (never clobbers).');
  }

  prompt?.close();

  console.log('\n───────────────────────────────────────────');
  console.log('✅ kbx is configured!');
  console.log('');
  console.log('  Get started:');
  console.log('    npx kbx dev               Start the dev server');
  console.log('    npx kbx generate          Build a catalogue + content');
  console.log('');
  console.log('  Lifecycle helpers:');
  console.log('    npx kbx scaffold <slug> --cluster <id>   Add a single page');
  console.log('    npx kbx audit                            Validate frontmatter integrity');
  console.log('    npx kbx affected <git-ref>               Diff → impacted nodes');
  console.log('    npx kbx links                            Graph health report');
  console.log('');
  console.log('  Skill docs:');
  console.log('    .github/skills/kbx/SKILL.md and references/');
  console.log('───────────────────────────────────────────\n');
}

