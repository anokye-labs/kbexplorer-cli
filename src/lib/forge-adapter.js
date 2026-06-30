/**
 * ForgeAdapter — host-neutral repository/host reference seam.
 *
 * kbx keeps **git** as its backing store but historically hard-wired the parsing
 * of a git remote into a GitHub-shaped `{ owner, repo }`. This module introduces a
 * thin abstraction so the *host* (GitHub vs. Azure DevOps vs. GitLab vs. a bare
 * git remote) becomes swappable later, while keeping git generic.
 *
 * This is a pure seam: GitHub remains the only implementation and its behavior is
 * unchanged. The GitHub adapter reproduces the exact remote-URL regexes that the
 * previous inline logic in `detect-repo.js` used, so every existing call site
 * resolves identically.
 *
 * # Types (documented as JSDoc typedefs; no runtime schema)
 *
 *   HostKind       — 'github' | 'ado' | 'gitlab' | 'bare-git'
 *   ForgeRef       — { kind: HostKind, owner: string, repo: string }
 *   RepositoryRef  — { kind: 'git', remoteUrl: string, host: ForgeRef|null }
 *
 * A `RepositoryRef` always carries the raw `remoteUrl` (git is the store); `host`
 * is the resolved host-specific identity, or `null` when no registered adapter
 * recognizes the remote (a bare git remote).
 *
 * Zero external dependencies.
 */

/**
 * Supported host kinds. Only `github` has an implementation today; the rest are
 * declared so consumers can branch on a stable, host-neutral enum.
 *
 * @enum {string}
 */
export const HostKind = Object.freeze({
  GITHUB: 'github',
  ADO: 'ado',
  GITLAB: 'gitlab',
  BARE_GIT: 'bare-git',
});

/**
 * @typedef {Object} ForgeRef
 * @property {string} kind  - One of {@link HostKind}.
 * @property {string} owner - Owner / org / namespace segment.
 * @property {string} repo  - Repository name (without a trailing `.git`).
 */

/**
 * @typedef {Object} RepositoryRef
 * @property {'git'} kind          - The backing store is always git.
 * @property {string} remoteUrl    - The raw remote URL.
 * @property {ForgeRef|null} host  - Resolved host identity, or null for bare git.
 */

/**
 * @typedef {Object} ForgeAdapter
 * @property {string} kind                                  - The {@link HostKind} this adapter serves.
 * @property {(remoteUrl: string) => ForgeRef|null} parse   - Parse a remote URL into a host ref, or null.
 */

/**
 * GitHub adapter. Reproduces the exact matching the CLI used before the seam was
 * extracted:
 *   - SSH form  `git@<host>:<owner>/<repo>` (host-agnostic, as before)
 *   - HTTPS form containing `github.com/<owner>/<repo>`
 *
 * @type {ForgeAdapter}
 */
export const githubForgeAdapter = {
  kind: HostKind.GITHUB,
  parse(remoteUrl) {
    if (!remoteUrl) return null;

    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { kind: HostKind.GITHUB, owner: sshMatch[1], repo: sshMatch[2] };

    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { kind: HostKind.GITHUB, owner: httpsMatch[1], repo: httpsMatch[2] };

    return null;
  },
};

/**
 * Registered adapters, in resolution order. The first adapter whose `parse`
 * returns a non-null ref wins. GitHub is the only registered implementation.
 *
 * @type {ForgeAdapter[]}
 */
const ADAPTERS = [githubForgeAdapter];

/**
 * Resolve a remote URL into a host-specific {@link ForgeRef} via the registered
 * adapters, or `null` when no adapter recognizes it (a bare git remote).
 *
 * @param {string|null|undefined} remoteUrl
 * @returns {ForgeRef|null}
 */
export function resolveForgeRef(remoteUrl) {
  if (!remoteUrl) return null;
  for (const adapter of ADAPTERS) {
    const ref = adapter.parse(remoteUrl);
    if (ref) return ref;
  }
  return null;
}

/**
 * Resolve a remote URL into a host-neutral {@link RepositoryRef}. The git remote
 * is always preserved; `host` carries the resolved identity (or null for bare git).
 *
 * @param {string|null|undefined} remoteUrl
 * @returns {RepositoryRef|null} null only when `remoteUrl` is empty/absent.
 */
export function resolveRepositoryRef(remoteUrl) {
  if (!remoteUrl) return null;
  return { kind: 'git', remoteUrl, host: resolveForgeRef(remoteUrl) };
}
