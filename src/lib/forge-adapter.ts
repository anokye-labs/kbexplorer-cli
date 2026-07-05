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
 * is the resolved host-specific identity. A registered adapter wins first
 * (GitHub); otherwise a generic `scheme://host/owner/repo` fallback carries the
 * owner/repo tagged as bare-git, and `host` is `null` only when even that does
 * not apply.
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
 * This stays strictly forge-specific: only a registered adapter (GitHub today)
 * can produce a ref. The host-neutral owner/repo fallback lives in
 * {@link resolveRepositoryRef}, so this function's behavior is byte-for-byte
 * unchanged from the seam introduced in #141.
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
 * Host-neutral `scheme://host/owner/repo` fallback. Used only when no registered
 * forge adapter recognizes the remote, so a self-hosted / GHES / generic git
 * host still yields an `{ owner, repo }` identity (tagged {@link HostKind.BARE_GIT})
 * instead of assuming GitHub. Matches any URL scheme; the SCP-style SSH form
 * (`git@host:owner/repo`) is already covered host-agnostically by the GitHub
 * adapter, so it is intentionally not re-matched here.
 *
 * @param {string} remoteUrl
 * @returns {ForgeRef|null}
 */
function parseGenericHost(remoteUrl) {
  const m = remoteUrl.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/]+)\/([^/.]+)/i);
  if (m) return { kind: HostKind.BARE_GIT, owner: m[1], repo: m[2] };
  return null;
}

/**
 * Resolve a remote URL into a host-neutral {@link RepositoryRef}. The git remote
 * is always preserved; `host` carries the resolved identity. A registered forge
 * adapter wins first (GitHub stays byte-for-byte); otherwise a generic
 * `scheme://host/owner/repo` fallback carries the owner/repo tagged as bare-git,
 * so non-GitHub hosts are no longer assumed away. `host` is null only when even
 * the generic form does not apply (e.g. a bare `git://` path with no owner/repo).
 *
 * @param {string|null|undefined} remoteUrl
 * @returns {RepositoryRef|null} null only when `remoteUrl` is empty/absent.
 */
export function resolveRepositoryRef(remoteUrl) {
  if (!remoteUrl) return null;
  const host = resolveForgeRef(remoteUrl) ?? parseGenericHost(remoteUrl);
  return { kind: 'git', remoteUrl, host };
}
