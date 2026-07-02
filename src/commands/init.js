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
import { runInitPreflight, formatPreflightDiagnostics, explainInstallFailure } from '../lib/preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');

/** Error thrown when interactive prompts are attempted without usable stdin. */
class NonInteractiveError extends Error {
  constructor() {
    super('NON_INTERACTIVE_STDIN');
    this.code = 'NON_INTERACTIVE_STDIN';
  }
}

function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Track EOF on stdin. A non-interactive shell (stdin closed / not a TTY, e.g.
  // `kbx init < /dev/null` or a CI step with no here-doc) reaches 'end'
  // immediately. Without this guard the readline question callback never fires
  // and the awaited prompt hangs, then Node exits 13 (unsettled top-level
  // await) leaving a half-configured repo. We surface a clean error instead.
  let closed = false;
  rl.on('close', () => { closed = true; });
  return {
    async ask(question, defaultValue) {
      if (closed) throw new NonInteractiveError();
      return new Promise((res, rej) => {
        const suffix = defaultValue != null ? ` [${defaultValue}]` : '';
        const onClose = () => rej(new NonInteractiveError());
        rl.once('close', onClose);
        rl.question(`${question}${suffix}: `, (answer) => {
          rl.removeListener('close', onClose);
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
 * Patch an existing `content/config.yaml` so its `visuals.mode` and
 * `theme.default` reflect the wizard's choice. No-op (returns false) when the
 * file is absent — a fresh repo gets its values from `.kbx.json` when generate
 * first writes config.yaml. Best-effort textual edit that preserves the rest of
 * the file; only the two scalar values under the existing blocks are replaced.
 *
 * @param {string} cwd
 * @param {{ visual: string, theme: string }} presentation
 * @returns {boolean} true when the file existed and was rewritten
 */
function applyPresentationToConfig(cwd, presentation) {
  const configPath = resolve(cwd, 'content', 'config.yaml');
  if (!existsSync(configPath)) return false;
  let text;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return false;
  }
  const setBlockScalar = (src, block, key, value) => {
    // Match `block:` header then the first `  key: <val>` line within it.
    const re = new RegExp(`(^${block}:[^\\S\\r\\n]*\\r?\\n(?:[^\\S\\r\\n].*\\r?\\n)*?[^\\S\\r\\n]+${key}:[^\\S\\r\\n]*)([^\\r\\n]*)`, 'm');
    if (re.test(src)) {
      return src.replace(re, `$1${value}`);
    }
    // Block exists but key missing — append the key under the block header.
    const headerRe = new RegExp(`(^${block}:[^\\S\\r\\n]*\\r?\\n)`, 'm');
    if (headerRe.test(src)) {
      return src.replace(headerRe, `$1  ${key}: ${value}\n`);
    }
    // Block missing entirely — append a fresh block at end of file.
    return src.replace(/\r?\n?$/, `\n\n${block}:\n  ${key}: ${value}\n`);
  };
  let next = setBlockScalar(text, 'visuals', 'mode', presentation.visual);
  next = setBlockScalar(next, 'theme', 'default', presentation.theme);
  if (next === text) return false;
  writeFileSync(configPath, next, 'utf-8');
  return true;
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
 * @returns {{ owner, repo, branch, title, contentPath: string|undefined, visual: string, theme: string, runtimeBlock: object|null }}
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

  return { owner, repo, branch, title, contentPath, visual, theme, runtimeBlock };
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
  const templateAlreadyPresent = hasSubmodule(cwd);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     kbx — Interactive Setup              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Step 0: First-run preflight (#152). Surface clear diagnostics + recovery for
  // the common first-run failures (old Node, no git remote, read-only cwd, no
  // npm) before doing any work. Hard blockers stop here; warnings are advisory.
  const { ok: preflightOk, diagnostics } = runInitPreflight({
    cwd,
    selfHosted,
    hasTemplate: templateAlreadyPresent,
    yes: opts.yes,
  });
  if (diagnostics.length) {
    for (const line of formatPreflightDiagnostics(diagnostics)) console.log(line);
    console.log('');
  }
  if (!preflightOk) {
    console.error('✗ Preflight found a blocking problem — resolve it and re-run `kbx init`.');
    prompt?.close();
    process.exit(1);
  }

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
      const { message, recovery } = explainInstallFailure(err, { templateUrl });
      console.error(`  ${message}`);
      for (const r of recovery) console.error(`  → ${r}`);
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
  let visual = 'emoji';
  let theme = 'dark';
  let runtimeBlock = null;

  if (opts.yes) {
    ({ owner, repo, branch, title, contentPath, visual, theme, runtimeBlock } = resolveHeadlessConfig(opts, cwd));
    console.log(
      `✓ Non-interactive config (owner=${owner}, repo=${repo}, branch=${branch}, mode=${mode})`,
    );
  } else {
   try {
    const detected = detectGitRemote(cwd);
    const detectedBranch = detectBranch(cwd);

    owner = await prompt.ask('Owner', detected?.owner ?? '');
    repo = await prompt.ask('Repo', detected?.repo ?? '');
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
    const visualIdx = await prompt.choose('Visual mode:', visualModes, 0);
    visual = visualModes[visualIdx];

    const themes = ['dark', 'light', 'sepia'];
    const themeIdx = await prompt.choose('Default theme:', themes, 0);
    theme = themes[themeIdx];

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
   } catch (err) {
      if (err instanceof NonInteractiveError) {
        console.error('✗ `kbx init` needs an interactive terminal for its setup prompts, but stdin is not a TTY.');
        console.error('  Re-run non-interactively with defaults: `kbx init --yes` (add --owner/--repo if not in a git repo).');
        console.error('  See `kbx init --help` for all non-interactive flags.');
        prompt?.close();
        process.exit(1);
      }
      throw err;
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

  // Persist the chosen visual mode + theme so the choice sticks across
  // generate/build (which read it back from .kbx.json). Always written, merged
  // into any existing record. Apply it to an existing content/config.yaml too,
  // so a repo that already has authored content reflects the choice immediately.
  const presentation = { visual, theme };
  const recordBeforePresentation = readSourceRecord(cwd) ?? {};
  writeSourceRecord(cwd, { ...recordBeforePresentation, presentation });
  console.log(`✓ Recorded presentation (visual: ${visual}, theme: ${theme}) in ${SOURCE_FILE}`);
  if (applyPresentationToConfig(cwd, presentation)) {
    console.log('✓ Applied visual/theme to content/config.yaml');
  }

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
    } catch (err) {
      // Don't fail init — the scaffold is still valid — but explain the likely
      // cause and the exact recovery command (#152).
      const { message, recovery } = explainInstallFailure(err);
      console.warn('⚠ npm install failed in .kbx/ — the explorer cannot run until deps are installed.');
      console.warn(`  ${message}`);
      for (const r of recovery) console.warn(`  → ${r}`);
      console.warn('  → Then run: `npm install` inside .kbx/');
    }
    // Verify the install actually produced node_modules; warn clearly if not,
    // so a silently skipped/partial install doesn't surface later as a cryptic
    // "kbx not found" at dev/build time.
    if (!existsSync(resolve(cwd, '.kbx', 'node_modules'))) {
      console.warn('⚠ .kbx/node_modules is missing — run `npm install` inside .kbx/ before `kbx dev`.');
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

