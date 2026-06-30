import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { HostKind, githubForgeAdapter, resolveForgeRef, resolveRepositoryRef } = await import(
  '../../src/lib/forge-adapter.js'
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

  it('keeps the git remote but null host for bare/unknown remotes', () => {
    assert.deepEqual(resolveRepositoryRef('https://example.com/foo/bar.git'), {
      kind: 'git',
      remoteUrl: 'https://example.com/foo/bar.git',
      host: null,
    });
  });

  it('returns null when there is no remote url', () => {
    assert.equal(resolveRepositoryRef(''), null);
    assert.equal(resolveRepositoryRef(null), null);
  });
});
