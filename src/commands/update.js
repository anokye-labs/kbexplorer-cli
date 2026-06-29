/**
 * kbx update — Check for template updates, ask before upgrading.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hasSubmodule, isTemplateRepo, isSubmoduleInstall, getSubmoduleUrl } from '../lib/detect-repo.js';
import { getCurrentTag, getLatestTag, resolveHeadSha, checkoutRef, TEMPLATE_REPO } from '../lib/version.js';
import { parseUpdateArgs } from '../lib/args.js';
import { readSourceRecord, writeSourceRecord, classifyRef } from '../lib/source.js';

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

  const skillsDir = resolve(cwd, '.github', 'skills', 'kbx', 'references');
  mkdirSync(skillsDir, { recursive: true });
  const skillsSrc = resolve(ASSETS_DIR, 'skills', 'kbx');
  copyFileSync(resolve(skillsSrc, 'SKILL.md'), resolve(cwd, '.github', 'skills', 'kbx', 'SKILL.md'));
  const refsSrc = resolve(skillsSrc, 'references');
  for (const f of readdirSync(refsSrc)) {
    copyFileSync(resolve(refsSrc, f), resolve(skillsDir, f));
  }
  console.log('✓ Refreshed skills in .github/skills/kbx/');
}

function safeRemove(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* best effort */ }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export default async function update(args) {
  const opts = parseUpdateArgs(args);
  const cwd = process.cwd();

  // Refresh agents/skills (always — these come from the CLI package, not the template)
  refreshAssets(cwd);

  if (isTemplateRepo(cwd) || !hasSubmodule(cwd)) {
    console.log('\n✅ Agents/skills refreshed.');
    return;
  }

  // Resolve the install record (synthesize one for legacy pre-record installs).
  let record = readSourceRecord(cwd);
  if (!record) {
    record = {
      template: getSubmoduleUrl(cwd) || TEMPLATE_REPO,
      ref: null,
      refType: 'release',
      resolvedCommit: null,
      mode: isSubmoduleInstall(cwd) ? 'submodule' : 'vendor',
    };
  }

  if (record.mode === 'vendor') {
    await updateVendor(cwd, record, opts.force);
  } else {
    await updateSubmodule(cwd, record, opts.force);
  }

  console.log('\n✅ Update complete.');
}

/**
 * Update a submodule install: pin to the newest release, track a branch, or
 * report a pinned tag. Uses the recorded source URL, not the hardcoded default.
 */
async function updateSubmodule(cwd, record, force) {
  const url = record.template;
  const submodulePath = resolve(cwd, '.kbx');

  // Warn if .gitmodules disagrees with the CLI-owned source record.
  const gmUrl = getSubmoduleUrl(cwd);
  if (gmUrl && url && gmUrl !== url) {
    console.warn(`\n⚠ .kbx.json template (${url}) differs from .gitmodules (${gmUrl}).`);
    console.warn('  Using .kbx.json — reconcile these to avoid updating from the wrong remote.');
  }

  const refType = record.refType || classifyRef(record.ref);
  const currentTag = getCurrentTag(cwd);

  console.log('\n📦 Template submodule');
  console.log(`  Source:  ${url}`);
  console.log(`  Current: ${currentTag || 'unknown'}`);

  if (refType === 'tag') {
    console.log(`  ⓘ Pinned to ${record.ref}. Re-run \`kbx init --ref <tag>\` to move.`);
    return;
  }

  if (refType === 'branch') {
    if (!force) {
      const answer = await ask(`  Pull latest of branch "${record.ref}"? (y/N): `);
      if (!answer.toLowerCase().startsWith('y')) {
        console.log('  Skipped.');
        return;
      }
    }
    try {
      checkoutRef(record.ref, cwd);
      execSync('git add .kbx', { cwd, stdio: 'pipe' });
      execSync('npm install --no-audit --no-fund', { cwd: submodulePath, stdio: 'inherit' });
      writeSourceRecord(cwd, { ...record, template: url, resolvedCommit: resolveHeadSha(submodulePath) });
      console.log(`  ✓ Updated to latest ${record.ref}`);
    } catch (err) {
      console.error('  ✗ Update failed:', err.message);
    }
    return;
  }

  // release tracking (default)
  const latestTag = getLatestTag(url);
  console.log(`  Latest:  ${latestTag || 'unknown'}`);

  if (!latestTag) {
    console.log('  ⚠ Could not fetch latest tag from remote');
    return;
  }
  if (currentTag === latestTag) {
    console.log('  ✓ Already on latest release');
    return;
  }

  console.log(`\n  New version available: ${currentTag || '?'} → ${latestTag}`);
  try {
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
      return;
    }
  }

  try {
    checkoutRef(latestTag, cwd);
    execSync('git add .kbx', { cwd, stdio: 'pipe' });
    execSync('npm install --no-audit --no-fund', { cwd: submodulePath, stdio: 'inherit' });
    writeSourceRecord(cwd, {
      ...record,
      template: url,
      ref: latestTag,
      refType: 'release',
      resolvedCommit: resolveHeadSha(submodulePath),
    });
    console.log(`  ✓ Updated to ${latestTag}`);
  } catch (err) {
    console.error('  ✗ Update failed:', err.message);
  }
}

/**
 * Update a vendored (one-time copy) install. Never clobbers `.kbx/`:
 * fetches the new version into a sibling review dir; with --force, backs up the
 * current install before swapping the new one into place.
 */
async function updateVendor(cwd, record, force) {
  const url = record.template;
  const refType = record.refType || classifyRef(record.ref);

  console.log('\n📦 Vendored template');
  console.log(`  Source:  ${url}`);
  console.log(`  Current: ${record.ref || record.resolvedCommit?.slice(0, 7) || 'unknown'}`);

  if (refType === 'tag') {
    console.log(`  ⓘ Pinned to ${record.ref}. Re-run \`kbx init --vendor --ref <tag>\` to move.`);
    return;
  }

  let targetRef = record.ref;
  if (refType === 'release') {
    targetRef = getLatestTag(url);
    if (!targetRef) {
      console.log('  ⚠ Could not fetch latest tag from remote');
      return;
    }
    console.log(`  Latest:  ${targetRef}`);
  }

  const branchArg = targetRef ? `--branch ${targetRef} ` : '';
  const reviewDir = resolve(cwd, `.kbx-update-${timestamp()}`);
  try {
    execSync(`git clone --depth 1 ${branchArg}${url} "${reviewDir}"`, { cwd, stdio: 'inherit' });
  } catch (err) {
    safeRemove(reviewDir);
    console.error('  ✗ Failed to fetch update:', err.message);
    return;
  }
  const newSha = resolveHeadSha(reviewDir);
  safeRemove(resolve(reviewDir, '.git'));

  if (newSha && record.resolvedCommit && newSha === record.resolvedCommit) {
    console.log('  ✓ Already up to date.');
    safeRemove(reviewDir);
    return;
  }

  if (!force) {
    const from = (record.resolvedCommit || '').slice(0, 7) || '?';
    console.log(`\n  New template content available (${from} → ${newSha ? newSha.slice(0, 7) : '?'}).`);
    console.log(`  Fetched to: ${reviewDir}`);
    console.log(`  Review:  git diff --no-index .kbx "${reviewDir}"`);
    console.log('  Apply:   kbx update --force   (backs up .kbx, then swaps)');
    return;
  }

  // --force: back up the current install, then swap. Never delete before success.
  const backup = resolve(cwd, `.kbx.backup-${timestamp()}`);
  try {
    renameSync(resolve(cwd, '.kbx'), backup);
    renameSync(reviewDir, resolve(cwd, '.kbx'));
  } catch (err) {
    console.error('  ✗ Swap failed:', err.message);
    safeRemove(reviewDir);
    return;
  }
  try {
    execSync('npm install --no-audit --no-fund', { cwd: resolve(cwd, '.kbx'), stdio: 'inherit' });
  } catch {
    console.warn('  ⚠ npm install failed — run manually in .kbx/');
  }
  writeSourceRecord(cwd, {
    ...record,
    template: url,
    ref: targetRef ?? record.ref,
    refType,
    resolvedCommit: newSha,
  });
  console.log(`  ✓ Updated. Previous install backed up to ${backup}`);
}


