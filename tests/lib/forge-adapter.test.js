import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { HostKind, githubForgeAdapter, resolveForgeRef, resolveRepositoryRef } = await import(
  '../../src/lib/forge-adapter.ts'
);

describe('HostKind', () => {
  it('declares the four host kinds', () => {
    assert.deepEqual(
      { ...HostKind },
      { GITHUB: 'github', ADO: 'ado', GITLAB: 'gitlab', BARE_GIT: 'bare-git' },
    );
  });
});

describe('githubForgeAdapter.parse', () => {
  it('parses an https github remote', () => {
    assert.deepEqual(githubForgeAdapter.parse('https://github.com/my-org/my-repo.git'), {
      kind: 'github',
      owner: 'my-org',
      repo: 'my-repo',
    });
  });

  it('parses an ssh github remote', () => {
    assert.deepEqual(githubForgeAdapter.parse('git@github.com:my-org/my-repo.git'), {
      kind: 'github',
      owner: 'my-org',
      repo: 'my-repo',
    });
  });

  it('returns null for an empty url', () => {
    assert.equal(githubForgeAdapter.parse(''), null);
    assert.equal(githubForgeAdapter.parse(null), null);
  });
});

describe('resolveForgeRef (mirrors prior detectGitRemote parsing)', () => {
  it('resolves https github remotes', () => {
    assert.deepEqual(resolveForgeRef('https://github.com/anokye-labs/kbexplorer-cli.git'), {
      kind: 'github',
      owner: 'anokye-labs',
      repo: 'kbexplorer-cli',
    });
  });

  it('resolves ssh remotes host-agnostically (as before)', () => {
    assert.deepEqual(resolveForgeRef('git@github.com:owner/repo.git'), {
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for unrecognized / bare remotes', () => {
    assert.equal(resolveForgeRef('https://example.com/foo/bar.git'), null);
    assert.equal(resolveForgeRef(''), null);
    assert.equal(resolveForgeRef(undefined), null);
  });
});

describe('resolveRepositoryRef', () => {
  it('wraps a github remote with git store + host ref', () => {
    assert.deepEqual(resolveRepositoryRef('https://github.com/org/repo.git'), {
      kind: 'git',
      remoteUrl: 'https://github.com/org/repo.git',
      host: { kind: 'github', owner: 'org', repo: 'repo' },
    });
  });

  it('resolves owner/repo for a self-hosted / GHES HTTPS remote via the generic fallback (#143)', () => {
    assert.deepEqual(resolveRepositoryRef('https://github.example.com/corp/enterprise-repo'), {
      kind: 'git',
      remoteUrl: 'https://github.example.com/corp/enterprise-repo',
      host: { kind: 'bare-git', owner: 'corp', repo: 'enterprise-repo' },
    });
  });

  it('resolves owner/repo for a generic scheme://host/o/r remote, tagged bare-git (#143)', () => {
    assert.deepEqual(resolveRepositoryRef('https://example.com/foo/bar.git'), {
      kind: 'git',
      remoteUrl: 'https://example.com/foo/bar.git',
      host: { kind: 'bare-git', owner: 'foo', repo: 'bar' },
    });
  });

  it('resolves an ssh:// scheme remote via the generic fallback (#143)', () => {
    assert.deepEqual(resolveRepositoryRef('ssh://git@gitlab.corp/team/svc.git'), {
      kind: 'git',
      remoteUrl: 'ssh://git@gitlab.corp/team/svc.git',
      host: { kind: 'bare-git', owner: 'team', repo: 'svc' },
    });
  });

  it('keeps a null host when no owner/repo can be derived', () => {
    assert.deepEqual(resolveRepositoryRef('git://example.com/loose'), {
      kind: 'git',
      remoteUrl: 'git://example.com/loose',
      host: null,
    });
  });

  it('returns null when there is no remote url', () => {
    assert.equal(resolveRepositoryRef(''), null);
    assert.equal(resolveRepositoryRef(null), null);
  });
});
