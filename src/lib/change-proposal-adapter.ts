/**
 * ChangeProposalAdapter — host-neutral "propose a change" seam.
 *
 * kbx keeps **git** as its backing store, but the act of *proposing* a change to
 * a repository is host-specific: GitHub uses a pull request, Azure DevOps uses a
 * PR too, GitLab uses a merge request, and a bare git remote has no forge at all
 * — the host-neutral primitive there is a patch + a branch name.
 *
 * This module abstracts that handoff behind a `ChangeProposalAdapter`, mirroring
 * the {@link module:src/lib/forge-adapter} pattern introduced for repo/host refs.
 * It is a pure, additive seam:
 *
 *   - `githubChangeProposalAdapter` is the sole *forge* implementation and
 *     reproduces the exact `gh pr create` handoff, so GitHub behavior is
 *     byte-for-byte unchanged wherever a host wires it in.
 *   - `bareGitChangeProposalAdapter` provides a deterministic patch+branch path
 *     so a non-forge (bare git) host is provable without any network or `gh`.
 *
 * No call site is rewired by this module — like the forge-adapter seam, consumers
 * adopt it deliberately. Zero external dependencies.
 *
 * # Types (documented as JSDoc typedefs; no runtime schema)
 *
 *   ProposalKind          — 'pull-request' | 'merge-request' | 'patch-branch'
 *   ProposalRequest       — { title, body, branch, base, changes, cwd }
 *   ProposalResult        — { url, branch, kind, patch? }
 *   ChangeProposalAdapter — { kind, proposalKind, propose(req, deps) }
 */

import { execSync } from 'node:child_process';
import { HostKind } from './forge-adapter.ts';

/**
 * The host-neutral kind of change proposal an adapter produces.
 * @enum {string}
 */
export const ProposalKind = Object.freeze({
  PULL_REQUEST: 'pull-request',
  MERGE_REQUEST: 'merge-request',
  PATCH_BRANCH: 'patch-branch',
} as const);

type ProposalKindValue = (typeof ProposalKind)[keyof typeof ProposalKind];
type HostKindValue = (typeof HostKind)[keyof typeof HostKind];

interface ProposalChange {
  path: string;
  contents?: string;
}

interface ProposalRequest {
  title?: string;
  body?: string;
  branch?: string;
  base?: string;
  changes?: ProposalChange[];
  cwd?: string;
}

interface ProposalResult {
  url: string;
  branch: string;
  kind: ProposalKindValue;
  patch?: string;
}

interface ProposalDeps {
  exec?: (cmd: string, opts?: { cwd?: string; encoding?: BufferEncoding; timeout?: number }) => string | Buffer;
}

interface ChangeProposalAdapter {
  kind: HostKindValue;
  proposalKind: ProposalKindValue;
  propose: (req?: ProposalRequest, deps?: ProposalDeps) => Promise<ProposalResult>;
}

/**
 * @typedef {Object} ProposalChange
 * @property {string} path      - Repo-relative path being written.
 * @property {string} [contents]- Full new file contents (as used by apply_changes).
 */

/**
 * @typedef {Object} ProposalRequest
 * @property {string} title              - Human title for the proposal.
 * @property {string} [body]             - Optional description / body.
 * @property {string} [branch]           - Head branch carrying the change.
 * @property {string} [base]             - Base branch to target (host default when absent).
 * @property {ProposalChange[]} [changes]- The applied change set (path + contents).
 * @property {string} [cwd]              - Working directory the git repo lives in.
 */

/**
 * @typedef {Object} ProposalResult
 * @property {string} url            - URL of the created proposal ('' when the host has none).
 * @property {string} branch         - The head branch the change lives on.
 * @property {ProposalKind} kind     - Which host-neutral proposal kind was produced.
 * @property {string} [patch]        - Unified patch text (bare-git patch+branch path only).
 */

/**
 * @typedef {Object} ProposalDeps
 * @property {(cmd: string, opts?: object) => string} [exec] - Injected execSync (for testing).
 */

/**
 * @typedef {Object} ChangeProposalAdapter
 * @property {string} kind                  - The {@link HostKind} this adapter serves.
 * @property {ProposalKind} proposalKind    - The kind of proposal it produces.
 * @property {(req: ProposalRequest, deps?: ProposalDeps) => Promise<ProposalResult>} propose
 */

/**
 * Shell-quote a single argument for the `gh` command line. Reproduces the
 * conservative single-quote wrapping used elsewhere so behavior is stable across
 * POSIX shells and does not depend on argv-array plumbing.
 *
 * @param {string} value
 * @returns {string}
 */
function shquote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * GitHub adapter. Encapsulates the change-proposal handoff as a `gh pr create`
 * invocation — the exact reference shape a host wires into its PR-creation seam.
 * GitHub behavior is unchanged: the head/base/title/body map one-to-one onto the
 * corresponding `gh pr create` flags, and the printed URL is returned verbatim.
 *
 * @type {ChangeProposalAdapter}
 */
export const githubChangeProposalAdapter = {
  kind: HostKind.GITHUB,
  proposalKind: ProposalKind.PULL_REQUEST,
  async propose(req: ProposalRequest = {}, deps: ProposalDeps = {}): Promise<ProposalResult> {
    const exec = deps.exec ?? execSync;
    const args = ['pr', 'create', '--title', shquote(req.title ?? ''), '--body', shquote(req.body ?? '')];
    if (req.branch) args.push('--head', shquote(req.branch));
    if (req.base) args.push('--base', shquote(req.base));

    const out = exec(`gh ${args.join(' ')}`, {
      cwd: req.cwd,
      encoding: 'utf-8',
      timeout: 30000,
    });
    const url = String(out ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    return { url, branch: req.branch ?? '', kind: ProposalKind.PULL_REQUEST };
  },
};

/**
 * Assemble a deterministic unified-diff-style patch from a change set. Each
 * change is emitted as a full-file replacement block. The output is stable for a
 * given input (paths in their given order, LF newlines) so the bare-git path is
 * byte-reproducible and testable without git or a network.
 *
 * @param {ProposalChange[]} changes
 * @returns {string}
 */
function assemblePatch(changes: ProposalChange[] | undefined): string {
  const blocks: string[] = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const path = change?.path ?? '';
    const contents = typeof change?.contents === 'string' ? change.contents : '';
    const lines = contents === '' ? [] : contents.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const body = lines.map((l: string) => `+${l}`).join('\n');
    blocks.push(
      `diff --git a/${path} b/${path}\n` +
        `--- /dev/null\n` +
        `+++ b/${path}\n` +
        `@@ -0,0 +1,${lines.length} @@` +
        (body ? `\n${body}` : '')
    );
  }
  return blocks.join('\n');
}

/**
 * Bare-git adapter. No forge exists, so the host-neutral proposal is a patch plus
 * a branch name — deterministically derived from the change set. This makes the
 * "propose a change" operation provable for non-GitHub hosts with no `gh` and no
 * network. Returns an empty `url` (a bare remote has no proposal URL).
 *
 * @type {ChangeProposalAdapter}
 */
export const bareGitChangeProposalAdapter = {
  kind: HostKind.BARE_GIT,
  proposalKind: ProposalKind.PATCH_BRANCH,
  async propose(req: ProposalRequest = {}, _deps: ProposalDeps = {}): Promise<ProposalResult> {
    return {
      url: '',
      branch: req.branch ?? '',
      kind: ProposalKind.PATCH_BRANCH,
      patch: assemblePatch(req.changes),
    };
  },
};

/**
 * Registered change-proposal adapters, keyed by {@link HostKind}. GitHub is the
 * only forge implementation; bare-git is the fallback for hosts with no forge.
 *
 * @type {Record<string, ChangeProposalAdapter>}
 */
const ADAPTERS = Object.freeze({
  [HostKind.GITHUB]: githubChangeProposalAdapter,
  [HostKind.BARE_GIT]: bareGitChangeProposalAdapter,
}) as Readonly<Record<string, ChangeProposalAdapter>>;

/**
 * Resolve a {@link ChangeProposalAdapter} for a host kind. Unknown or absent
 * hosts (no registered forge adapter) fall back to the bare-git patch+branch
 * path, which is the host-neutral default.
 *
 * @param {string|null|undefined} hostKind - One of {@link HostKind}, or null.
 * @returns {ChangeProposalAdapter}
 */
export function resolveChangeProposalAdapter(hostKind: string | null | undefined): ChangeProposalAdapter {
  if (hostKind && hostKind in ADAPTERS) {
    return ADAPTERS[hostKind];
  }
  return bareGitChangeProposalAdapter;
}
