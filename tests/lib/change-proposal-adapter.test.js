import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  ProposalKind,
  githubChangeProposalAdapter,
  bareGitChangeProposalAdapter,
  resolveChangeProposalAdapter,
} = await import('../../src/lib/change-proposal-adapter.ts');

const { HostKind } = await import('../../src/lib/forge-adapter.ts');

describe('ProposalKind', () => {
  it('declares the three host-neutral proposal kinds', () => {
    assert.deepEqual(
      { ...ProposalKind },
      { PULL_REQUEST: 'pull-request', MERGE_REQUEST: 'merge-request', PATCH_BRANCH: 'patch-branch' },
    );
  });
});

describe('githubChangeProposalAdapter.propose', () => {
  it('builds a gh pr create with title/body/head/base and returns the printed URL', async () => {
    const calls = [];
    const exec = (cmd, opts) => {
      calls.push({ cmd, opts });
      return 'https://github.com/o/r/pull/7\n';
    };
    const result = await githubChangeProposalAdapter.propose(
      { title: 'My change', body: 'Details', branch: 'feat/x', base: 'main', cwd: '/repo' },
      { exec },
    );
    assert.equal(calls.length, 1);
    const { cmd, opts } = calls[0];
    assert.match(cmd, /^gh pr create /);
    assert.match(cmd, /--title 'My change'/);
    assert.match(cmd, /--body 'Details'/);
    assert.match(cmd, /--head 'feat\/x'/);
    assert.match(cmd, /--base 'main'/);
    assert.equal(opts.cwd, '/repo');
    assert.deepEqual(result, { url: 'https://github.com/o/r/pull/7', branch: 'feat/x', kind: 'pull-request' });
  });

  it('omits --head/--base when not provided and takes the last non-empty output line as the URL', async () => {
    const exec = () => 'Warning: something\nhttps://github.com/o/r/pull/9\n';
    const result = await githubChangeProposalAdapter.propose(
      { title: 'T', body: '' },
      { exec: (cmd) => { assert.doesNotMatch(cmd, /--head|--base/); return exec(); } },
    );
    assert.equal(result.url, 'https://github.com/o/r/pull/9');
    assert.equal(result.branch, '');
    assert.equal(result.kind, 'pull-request');
  });

  it('single-quote-escapes embedded quotes in title/body', async () => {
    let seen = '';
    await githubChangeProposalAdapter.propose(
      { title: "it's here", body: '' },
      { exec: (cmd) => { seen = cmd; return 'https://x\n'; } },
    );
    assert.match(seen, /--title 'it'\\''s here'/);
  });
});

describe('bareGitChangeProposalAdapter.propose', () => {
  it('produces a deterministic patch+branch with an empty url', async () => {
    const req = {
      title: 'T',
      branch: 'kbx/change',
      changes: [
        { path: 'a.txt', contents: 'hello\nworld\n' },
        { path: 'dir/b.txt', contents: 'x' },
      ],
    };
    const r1 = await bareGitChangeProposalAdapter.propose(req);
    const r2 = await bareGitChangeProposalAdapter.propose(req);
    assert.equal(r1.url, '');
    assert.equal(r1.branch, 'kbx/change');
    assert.equal(r1.kind, 'patch-branch');
    assert.equal(r1.patch, r2.patch, 'patch is deterministic');
    assert.match(r1.patch, /diff --git a\/a\.txt b\/a\.txt/);
    assert.match(r1.patch, /@@ -0,0 \+1,2 @@/);
    assert.match(r1.patch, /\+hello\n\+world/);
    assert.match(r1.patch, /diff --git a\/dir\/b\.txt b\/dir\/b\.txt/);
    assert.match(r1.patch, /@@ -0,0 \+1,1 @@\n\+x/);
  });

  it('handles an empty change set', async () => {
    const r = await bareGitChangeProposalAdapter.propose({ branch: 'b', changes: [] });
    assert.deepEqual(r, { url: '', branch: 'b', kind: 'patch-branch', patch: '' });
  });
});

describe('resolveChangeProposalAdapter', () => {
  it('returns the github adapter for the github host kind', () => {
    assert.equal(resolveChangeProposalAdapter(HostKind.GITHUB), githubChangeProposalAdapter);
  });

  it('falls back to bare-git for bare-git, unknown, or null host kinds', () => {
    assert.equal(resolveChangeProposalAdapter(HostKind.BARE_GIT), bareGitChangeProposalAdapter);
    assert.equal(resolveChangeProposalAdapter('ado'), bareGitChangeProposalAdapter);
    assert.equal(resolveChangeProposalAdapter(null), bareGitChangeProposalAdapter);
    assert.equal(resolveChangeProposalAdapter(undefined), bareGitChangeProposalAdapter);
  });
});
