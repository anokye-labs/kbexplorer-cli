/**
 * First-run robustness preflight for `kbx init` (#152).
 *
 * Onboarding is a story, not an afterthought: every way a first run can fail
 * should produce a clear diagnostic and a concrete recovery step instead of an
 * opaque stack trace or a half-finished scaffold. This module gathers those
 * checks in one place so `init` can surface them up-front, and so `doctor`
 * (anokye-labs/kbexplorer-cli#100) can reuse the same logic rather than
 * duplicating it.
 *
 * Every check is deterministic and dependency-injectable (node version,
 * spawnSync, env, fs probe) so the whole surface is hermetically testable —
 * no real network, no real npm, no real git required.
 *
 * Diagnostic shape:
 *   { id, level: 'error' | 'warn', message, recovery }
 *
 * `level: 'error'` means init cannot reasonably proceed (hard blocker).
 * `level: 'warn'` means init can continue but the user should know something.
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { detectGitRemote } from './detect-repo.js';

export const MIN_NODE_MAJOR = 22;

function diag(level, id, message, recovery) {
  return { level, id, message, recovery };
}

/**
 * Verify the running Node.js major version meets the minimum the template and
 * its Vite toolchain require. Below the floor is a hard blocker.
 *
 * @param {string} version   e.g. process.version ("v20.11.1")
 * @param {number} [minMajor]
 * @returns {object|null} a diagnostic, or null when satisfied
 */
export function checkNodeVersion(version = process.version, minMajor = MIN_NODE_MAJOR) {
  const major = parseInt(String(version).replace(/^v/, ''), 10);
  if (Number.isNaN(major)) return null;
  if (major < minMajor) {
    return diag(
      'error',
      'node-version',
      `Node ${version} is below the required Node >=${minMajor}.`,
      `Install Node ${minMajor} or newer (e.g. via nvm: \`nvm install ${minMajor}\`) and re-run \`kbx init\`. ` +
        'The explorer template and its Vite build require it.',
    );
  }
  return null;
}

/**
 * Verify the wizard can autodetect the GitHub owner/repo from a git `origin`
 * remote. The interactive wizard does no `git init`, so without a remote the
 * owner/repo prompts default to blank. A warning (not a blocker) — the user can
 * still type the values, and `--yes` enforces them separately.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {(cwd: string) => ({owner:string,repo:string}|null)} [opts.detect]
 * @returns {object|null}
 */
export function checkGitRemote(cwd, { detect = detectGitRemote } = {}) {
  const remote = detect(cwd);
  if (remote && remote.owner && remote.repo) return null;
  return diag(
    'warn',
    'git-remote',
    'No git `origin` remote detected — owner/repo cannot be autodetected.',
    'Run `git init` and `git remote add origin <url>` before init, or supply ' +
      '`--owner <name> --repo <name>` (you can also just type them at the prompts).',
  );
}

/**
 * Verify the current directory is writable. A non-writable cwd (read-only mount,
 * restricted permissions) means init cannot write `.env.kbx`/`.kbx.json` — a
 * hard blocker, caught early with a clear cause instead of mid-scaffold.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {typeof writeFileSync} [opts.write]
 * @param {typeof unlinkSync} [opts.remove]
 * @returns {object|null}
 */
export function checkWritePermission(cwd, { write = writeFileSync, remove = unlinkSync } = {}) {
  const probe = resolve(cwd, `.kbx-write-probe-${process.pid}-${Date.now()}`);
  try {
    write(probe, '', 'utf-8');
  } catch (err) {
    return diag(
      'error',
      'write-permission',
      `Cannot write to ${cwd} (${err.code || err.message}).`,
      'Choose a writable directory, fix the directory permissions, or run with an ' +
        'account that can write here. init needs to create .env.kbx and .kbx.json.',
    );
  }
  try {
    remove(probe);
  } catch { /* best effort cleanup */ }
  return null;
}

/**
 * Verify `npm` is available — it is needed to install the template's deps in
 * `.kbx/`. Only relevant when a template will actually be installed (i.e. not a
 * self-hosted run). A warning: init can still scaffold config, but the explorer
 * won't run until deps are installed.
 *
 * @param {object} [opts]
 * @param {typeof nodeSpawnSync} [opts.spawnSync]
 * @returns {object|null}
 */
export function checkNpmAvailable({ spawnSync = nodeSpawnSync } = {}) {
  let available = false;
  try {
    const res = spawnSync('npm', ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
    available = !res.error && res.status === 0;
  } catch {
    available = false;
  }
  if (available) return null;
  return diag(
    'warn',
    'npm-available',
    'npm was not found on PATH — template dependencies cannot be installed automatically.',
    'Install Node.js with npm (https://nodejs.org), then run `npm install` in `.kbx/` after init.',
  );
}

/**
 * Run the full first-run preflight for `init`, returning an ordered list of
 * diagnostics and an `ok` flag (false when any hard blocker is present).
 *
 * Pure aside from the injected probes; callers decide how to render and whether
 * to exit. `git-remote` is skipped in `--yes` mode because `resolveHeadlessConfig`
 * already produces a precise owner/repo error there (avoids double-reporting).
 *
 * @param {object} opts
 * @param {string}  opts.cwd
 * @param {boolean} [opts.selfHosted]   Template repo itself — no install/npm needed.
 * @param {boolean} [opts.hasTemplate]  `.kbx` already present — install skipped.
 * @param {boolean} [opts.yes]          Non-interactive run.
 * @param {string}  [opts.nodeVersion]
 * @param {object}  [opts.probes]       { detect, write, remove, spawnSync } overrides for tests.
 * @returns {{ ok: boolean, diagnostics: object[] }}
 */
export function runInitPreflight({
  cwd = process.cwd(),
  selfHosted = false,
  hasTemplate = false,
  yes = false,
  nodeVersion = process.version,
  probes = {},
} = {}) {
  const diagnostics = [];
  const push = (d) => { if (d) diagnostics.push(d); };

  push(checkNodeVersion(nodeVersion));
  push(checkWritePermission(cwd, probes));
  if (!yes) {
    push(checkGitRemote(cwd, probes));
  }
  // npm only matters when init will actually install template deps.
  if (!selfHosted && !hasTemplate) {
    push(checkNpmAvailable(probes));
  }

  const ok = !diagnostics.some((d) => d.level === 'error');
  return { ok, diagnostics };
}

/**
 * Format preflight diagnostics into printable lines (icon + message + indented
 * recovery). Errors use ✗, warnings use ⚠.
 *
 * @param {object[]} diagnostics
 * @returns {string[]}
 */
export function formatPreflightDiagnostics(diagnostics) {
  const lines = [];
  for (const d of diagnostics) {
    const icon = d.level === 'error' ? '✗' : '⚠';
    lines.push(`${icon} ${d.message}`);
    if (d.recovery) lines.push(`  → ${d.recovery}`);
  }
  return lines;
}

/**
 * Wrap an install/clone failure in a diagnostic that names the most likely
 * cause (network, enterprise policy, auth) and a recovery path. Used to turn the
 * raw clone/submodule error into something actionable (#152).
 *
 * @param {Error} err
 * @param {object} [opts]
 * @param {string} [opts.templateUrl]
 * @returns {{ message: string, recovery: string[] }}
 */
export function explainInstallFailure(err, { templateUrl } = {}) {
  const raw = String(err?.message ?? err ?? '').toLowerCase();
  const recovery = [];
  let cause = 'The template could not be installed.';
  if (/could not resolve host|network|getaddrinfo|enotfound|timed out|timeout/.test(raw)) {
    cause = 'Network unreachable while cloning the template.';
    recovery.push('Check your internet connection or proxy settings and retry.');
  } else if (/403|forbidden|denied|blocked|policy|sso|saml/.test(raw)) {
    cause = 'Access to the template repo was denied — this often means an enterprise/SSO policy.';
    recovery.push('Authenticate (e.g. `gh auth login`), authorize SSO for the org, or use an internal --template mirror.');
  } else if (/authentication|auth|permission|credentials|401/.test(raw)) {
    cause = 'Authentication failed while fetching the template.';
    recovery.push('Run `gh auth login` (or configure git credentials) and retry.');
  }
  if (templateUrl) {
    recovery.push(`Verify the template URL is reachable: ${templateUrl}`);
  }
  recovery.push('Or vendor a local copy offline with `kbx init --vendor --template <path-or-url>`.');
  return { message: cause, recovery };
}
