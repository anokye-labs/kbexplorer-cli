/**
 * Tests for src/lib/gh-fetch.js
 *
 * Coverage:
 *   - resolveGhApiBase: precedence chain (.kbx.json > env > null)
 *   - resolveGhToken: precedence chain (KBX_GH_TOKEN > GH_TOKEN > '')
 *   - buildApiUrl: URL construction
 *   - ghFetch: default (gh CLI) path + override (direct HTTP) path
 *   - createFetcher: convenience wrapper
 *
 * All network calls are mocked — no actual HTTP traffic.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  resolveGhApiBase,
  resolveGhToken,
  buildApiUrl,
  ghFetch,
  createFetcher,
  GH_API_BASE_ENV,
  GH_TOKEN_ENV,
  GH_TOKEN_FALLBACK_ENV,
} = await import('../../src/lib/gh-fetch.ts');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), `kbe-test-ghfetch-${Date.now()}`);

before(() => {
  mkdirSync(TMP, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfig(dir, data) {
  writeFileSync(resolve(dir, '.kbx.json'), JSON.stringify(data), 'utf-8');
}

// ── resolveGhApiBase ───────────────────────────────────────────────────────────

describe('resolveGhApiBase', () => {
  it('returns null when no config file and no env var', () => {
    const dir = join(TMP, 'empty');
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(resolveGhApiBase(dir, {}), null);
  });

  it('returns null when config file has no ghApiBase field', () => {
    const dir = join(TMP, 'no-base-field');
    mkdirSync(dir, { recursive: true });
    writeConfig(dir, { template: 'https://github.com/foo/bar.git', mode: 'vendor' });
    assert.strictEqual(resolveGhApiBase(dir, {}), null);
  });

  it('reads ghApiBase from .kbx.json (highest precedence)', () => {
    const dir = join(TMP, 'config-base');
    mkdirSync(dir, { recursive: true });
    writeConfig(dir, { ghApiBase: 'http://localhost:3456' });
    // Even with an env var present, config wins
    const result = resolveGhApiBase(dir, { [GH_API_BASE_ENV]: 'http://env-host:9999' });
    assert.strictEqual(result, 'http://localhost:3456');
  });

  it('reads base from KBX_GH_API_BASE env var when config has no field', () => {
    const dir = join(TMP, 'env-base');
    mkdirSync(dir, { recursive: true });
    writeConfig(dir, { mode: 'vendor' });
    const result = resolveGhApiBase(dir, { [GH_API_BASE_ENV]: 'https://ghe.example.com/api/v3' });
    assert.strictEqual(result, 'https://ghe.example.com/api/v3');
  });

  it('trims whitespace from ghApiBase config value', () => {
    const dir = join(TMP, 'config-base-trim');
    mkdirSync(dir, { recursive: true });
    writeConfig(dir, { ghApiBase: '  http://localhost:3456  ' });
    assert.strictEqual(resolveGhApiBase(dir, {}), 'http://localhost:3456');
  });

  it('trims whitespace from KBX_GH_API_BASE env var value', () => {
    const dir = join(TMP, 'env-base-trim');
    mkdirSync(dir, { recursive: true });
    const result = resolveGhApiBase(dir, { [GH_API_BASE_ENV]: '  http://localhost:3456  ' });
    assert.strictEqual(result, 'http://localhost:3456');
  });

  it('returns null for empty string env var', () => {
    const dir = join(TMP, 'env-base-empty');
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(resolveGhApiBase(dir, { [GH_API_BASE_ENV]: '' }), null);
  });

  it('returns null for whitespace-only env var', () => {
    const dir = join(TMP, 'env-base-ws');
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(resolveGhApiBase(dir, { [GH_API_BASE_ENV]: '   ' }), null);
  });

  it('ignores malformed .kbx.json and falls through to env', () => {
    const dir = join(TMP, 'malformed-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.kbx.json'), '{ not valid json', 'utf-8');
    const result = resolveGhApiBase(dir, { [GH_API_BASE_ENV]: 'http://localhost:9000' });
    assert.strictEqual(result, 'http://localhost:9000');
  });
});

// ── resolveGhToken ─────────────────────────────────────────────────────────────

describe('resolveGhToken', () => {
  it('returns KBX_GH_TOKEN when set (highest precedence)', () => {
    assert.strictEqual(
      resolveGhToken({ [GH_TOKEN_ENV]: 'primary-tok', [GH_TOKEN_FALLBACK_ENV]: 'fallback-tok' }),
      'primary-tok',
    );
  });

  it('falls back to GH_TOKEN when KBX_GH_TOKEN is absent', () => {
    assert.strictEqual(
      resolveGhToken({ [GH_TOKEN_FALLBACK_ENV]: 'fallback-tok' }),
      'fallback-tok',
    );
  });

  it('returns empty string when neither token env var is set', () => {
    assert.strictEqual(resolveGhToken({}), '');
  });
});

// ── buildApiUrl ────────────────────────────────────────────────────────────────

describe('buildApiUrl', () => {
  it('joins base and path with a leading slash', () => {
    assert.strictEqual(
      buildApiUrl('http://localhost:3456', '/repos/org/repo/issues'),
      'http://localhost:3456/repos/org/repo/issues',
    );
  });

  it('strips trailing slash from base', () => {
    assert.strictEqual(
      buildApiUrl('http://localhost:3456/', 'repos/org/repo/issues'),
      'http://localhost:3456/repos/org/repo/issues',
    );
  });

  it('adds leading slash to path when absent', () => {
    assert.strictEqual(
      buildApiUrl('https://ghe.example.com/api/v3', 'repos/org/repo/pulls'),
      'https://ghe.example.com/api/v3/repos/org/repo/pulls',
    );
  });
});

// ── ghFetch — default path (gh CLI) ───────────────────────────────────────────

describe('ghFetch — default path (base=null)', () => {
  it('calls execSync with quoted gh api command', async () => {
    const calls = [];
    const exec = (cmd, _opts) => {
      calls.push(cmd);
      return JSON.stringify([{ id: 1 }]);
    };
    const result = await ghFetch({ base: null, path: 'repos/o/r/issues?state=all', _exec: exec });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.ok(calls.length === 1);
    // Endpoint must be quoted so ? and & survive the shell
    assert.match(calls[0], /^gh api "/);
    assert.ok(calls[0].endsWith('"'));
  });

  it('does not call fetch when base is null', async () => {
    let fetchCalled = false;
    const fakeFetch = () => { fetchCalled = true; return Promise.resolve({}); };
    const exec = (_cmd, _opts) => JSON.stringify([]);
    await ghFetch({ base: null, path: 'repos/o/r/issues', _exec: exec, _fetch: fakeFetch });
    assert.strictEqual(fetchCalled, false);
  });

  it('returns parsed JSON from gh output', async () => {
    const data = [{ number: 1, title: 'Bug' }, { number: 2, title: 'Feature' }];
    const exec = (_cmd, _opts) => JSON.stringify(data);
    const result = await ghFetch({ base: null, path: 'repos/o/r/issues', _exec: exec });
    assert.deepStrictEqual(result, data);
  });

  it('throws on invalid JSON from gh output', async () => {
    const exec = (_cmd, _opts) => 'not-json';
    await assert.rejects(
      () => ghFetch({ base: null, path: 'repos/o/r/issues', _exec: exec }),
      SyntaxError,
    );
  });

  it('propagates execSync errors', async () => {
    const exec = (_cmd, _opts) => { throw new Error('gh: command failed'); };
    await assert.rejects(
      () => ghFetch({ base: null, path: 'repos/o/r/issues', _exec: exec }),
      /gh: command failed/,
    );
  });
});

// ── ghFetch — override path (direct HTTP) ─────────────────────────────────────

describe('ghFetch — override path (base set)', () => {
  function makeFetch(status, body) {
    return (_url, _opts) => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
    });
  }

  it('calls fetch (not execSync) when base is set', async () => {
    let execCalled = false;
    const fakeExec = () => { execCalled = true; return '[]'; };
    const data = [{ number: 1 }];
    const fetch = makeFetch(200, data);
    await ghFetch({ base: 'http://localhost:3456', path: '/repos/o/r/issues', _exec: fakeExec, _fetch: fetch });
    assert.strictEqual(execCalled, false);
  });

  it('constructs the correct URL', async () => {
    const urls = [];
    const fetch = (url, _opts) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await ghFetch({ base: 'http://localhost:3456', path: '/repos/org/repo/issues', _fetch: fetch });
    assert.strictEqual(urls[0], 'http://localhost:3456/repos/org/repo/issues');
  });

  it('sends Authorization header when token is provided', async () => {
    const sentHeaders = [];
    const fetch = (_url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await ghFetch({
      base: 'http://localhost:3456',
      path: '/repos/o/r/issues',
      token: 'my-secret-token',
      _fetch: fetch,
    });
    assert.strictEqual(sentHeaders[0].Authorization, 'token my-secret-token');
  });

  it('sends Accept: application/vnd.github+json header', async () => {
    const sentHeaders = [];
    const fetch = (_url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await ghFetch({
      base: 'http://localhost:3456',
      path: '/repos/o/r/issues',
      _fetch: fetch,
    });
    assert.strictEqual(sentHeaders[0].Accept, 'application/vnd.github+json');
  });

  it('omits Authorization header when no token is provided', async () => {
    const sentHeaders = [];
    const fetch = (_url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await ghFetch({ base: 'http://localhost:3456', path: '/repos/o/r/issues', _fetch: fetch });
    assert.ok(!('Authorization' in sentHeaders[0]));
  });

  it('returns parsed JSON on 200', async () => {
    const data = [{ id: 42, title: 'Test issue' }];
    const result = await ghFetch({
      base: 'http://localhost:3456',
      path: '/repos/o/r/issues',
      _fetch: makeFetch(200, data),
    });
    assert.deepStrictEqual(result, data);
  });

  it('throws on non-200 HTTP status', async () => {
    await assert.rejects(
      () => ghFetch({
        base: 'http://localhost:3456',
        path: '/repos/o/r/issues',
        _fetch: makeFetch(404, { message: 'Not Found' }),
      }),
      /404/,
    );
  });

  it('throws on 500 HTTP status', async () => {
    await assert.rejects(
      () => ghFetch({
        base: 'http://localhost:3456',
        path: '/repos/o/r/issues',
        _fetch: makeFetch(500, {}),
      }),
      /500/,
    );
  });
});

// ── createFetcher ──────────────────────────────────────────────────────────────

describe('createFetcher', () => {
  it('returns a function', () => {
    const f = createFetcher({ base: null });
    assert.strictEqual(typeof f, 'function');
  });

  it('pre-binds base + token and forwards path', async () => {
    const urls = [];
    const authHeaders = [];
    const fetch = (url, opts) => {
      urls.push(url);
      authHeaders.push(opts?.headers?.Authorization ?? null);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    const fetcher = createFetcher({ base: 'http://localhost:3456', token: 'tok123', _fetch: fetch });
    await fetcher('/repos/org/repo/releases');
    assert.strictEqual(urls[0], 'http://localhost:3456/repos/org/repo/releases');
    assert.strictEqual(authHeaders[0], 'token tok123');
  });

  it('uses gh CLI path when base is null', async () => {
    const cmds = [];
    const exec = (cmd) => { cmds.push(cmd); return JSON.stringify([]); };
    const fetcher = createFetcher({ base: null, _exec: exec });
    await fetcher('repos/o/r/issues');
    assert.ok(cmds.length === 1);
    assert.match(cmds[0], /^gh api /);
  });
});

// ── Smoke test (skipped unless KBX_GH_API_BASE is set) ─────────────────

describe('smoke: live base URL', { skip: !process.env[GH_API_BASE_ENV] }, () => {
  it('fetches releases from the configured base URL', async () => {
    const base = process.env[GH_API_BASE_ENV];
    const token = process.env[GH_TOKEN_ENV] || process.env[GH_TOKEN_FALLBACK_ENV] || '';
    const owner = process.env.KB_OWNER || 'anokye-labs';
    const repo = process.env.KB_REPO || 'kbexplorer-template';

    // Use real globalThis.fetch — this is the live smoke
    const result = await ghFetch({
      base,
      path: `/repos/${owner}/${repo}/releases`,
      token,
    });
    assert.ok(Array.isArray(result), 'Expected an array of releases');
    console.log(`[smoke] Live base ${base} returned ${result.length} release(s)`);
  });
});

