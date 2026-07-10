import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('buildRepoManifest remote wiring', () => {
  it('passes the full preset and token env to GitHubApiSource', async () => {
    // This Node runtime does not expose node:test's mock.module API, so the test
    // uses the thin manifest-build dependency seam exported for this purpose.
    const mod = await import(new URL('../../src/lib/manifest-build.ts?test=' + Date.now(), import.meta.url).href);
    const { buildRepoManifest, manifestBuildDeps } = mod;
    const captured = [];
    const originalDeps = {
      buildManifest: manifestBuildDeps.buildManifest,
      FileSystemSource: manifestBuildDeps.FileSystemSource,
      GitHubApiSource: manifestBuildDeps.GitHubApiSource,
    };

    manifestBuildDeps.GitHubApiSource = class GitHubApiSource {
      constructor(...args) {
        captured.push(args);
      }
    };
    manifestBuildDeps.buildManifest = async (source, options) => ({ source, options, authoredContent: {} });

    try {
      process.env.GITHUB_TOKEN = 'token-123';
      const manifest = await buildRepoManifest('/tmp', { repo: 'octo/demo' });

      assert.equal(captured.length, 1);
      assert.deepStrictEqual(captured[0][0], { owner: 'octo', repo: 'demo', path: 'content', branch: 'main' });
      assert.equal(captured[0][1], 'full');
      assert.deepStrictEqual(captured[0][2], { GITHUB_TOKEN: 'token-123' });
      assert.equal(manifest.options.generatedAt, undefined);
    } finally {
      delete process.env.GITHUB_TOKEN;
      manifestBuildDeps.buildManifest = originalDeps.buildManifest;
      manifestBuildDeps.FileSystemSource = originalDeps.FileSystemSource;
      manifestBuildDeps.GitHubApiSource = originalDeps.GitHubApiSource;
    }
  });

  it('wires hybrid augmentFrom with the requested branch', async () => {
    const mod = await import(new URL('../../src/lib/manifest-build.ts?test=' + Date.now(), import.meta.url).href);
    const { buildRepoManifest, manifestBuildDeps } = mod;
    const githubCalls = [];
    const originalDeps = {
      buildManifest: manifestBuildDeps.buildManifest,
      FileSystemSource: manifestBuildDeps.FileSystemSource,
      GitHubApiSource: manifestBuildDeps.GitHubApiSource,
    };

    let augmentSource;
    manifestBuildDeps.FileSystemSource = class FileSystemSource {
      constructor(...args) {
        this.args = args;
      }
    };
    manifestBuildDeps.GitHubApiSource = class GitHubApiSource {
      constructor(...args) {
        augmentSource = this;
        githubCalls.push(args);
      }
    };
    manifestBuildDeps.buildManifest = async (source, options) => ({ source, options, authoredContent: {} });

    try {
      process.env.GH_TOKEN = 'token-456';
      const manifest = await buildRepoManifest('/tmp', { augment: 'octo/demo', branch: 'release' });

      assert.equal(githubCalls.length, 1);
      assert.deepStrictEqual(githubCalls[0][0], { owner: 'octo', repo: 'demo', path: 'content', branch: 'release' });
      assert.equal(githubCalls[0][1], 'full');
      assert.deepStrictEqual(githubCalls[0][2], { GITHUB_TOKEN: 'token-456' });
      assert.equal(manifest.options.augmentFrom, augmentSource);
    } finally {
      delete process.env.GH_TOKEN;
      manifestBuildDeps.buildManifest = originalDeps.buildManifest;
      manifestBuildDeps.FileSystemSource = originalDeps.FileSystemSource;
      manifestBuildDeps.GitHubApiSource = originalDeps.GitHubApiSource;
    }
  });
});
