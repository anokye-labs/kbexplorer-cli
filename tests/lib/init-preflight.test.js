import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  checkNodeVersion,
  checkGitRemote,
  checkWritePermission,
  checkNpmAvailable,
  runInitPreflight,
  formatPreflightDiagnostics,
  explainInstallFailure,
  MIN_NODE_MAJOR,
} = await import('../../src/lib/init-preflight.js');

describe('checkNodeVersion (#152)', () => {
  it('flags a Node major below the floor as a hard error', () => {
    const d = checkNodeVersion('v20.11.1', 22);
    assert.ok(d);
    assert.equal(d.level, 'error');
    assert.equal(d.id, 'node-version');
    assert.match(d.message, /below the required Node >=22/);
    assert.match(d.recovery, /nvm install 22|Node 22 or newer/);
  });

  it('passes (null) for a supported version', () => {
    assert.equal(checkNodeVersion('v22.3.0', 22), null);
    assert.equal(checkNodeVersion('v24.0.0', 22), null);
  });

  it('defaults the floor to MIN_NODE_MAJOR', () => {
    assert.equal(MIN_NODE_MAJOR, 22);
    assert.equal(checkNodeVersion(`v${MIN_NODE_MAJOR}.0.0`), null);
  });

  it('is lenient on an unparseable version', () => {
    assert.equal(checkNodeVersion('weird'), null);
  });
});

describe('checkGitRemote (#152)', () => {
  it('warns when no origin remote is detected', () => {
    const d = checkGitRemote('/x', { detect: () => null });
    assert.ok(d);
    assert.equal(d.level, 'warn');
    assert.equal(d.id, 'git-remote');
    assert.match(d.recovery, /git remote add origin|--owner/);
  });

  it('passes when owner/repo are detectable', () => {
    assert.equal(checkGitRemote('/x', { detect: () => ({ owner: 'a', repo: 'b' }) }), null);
  });
});

describe('checkWritePermission (#152)', () => {
  it('passes for a writable dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-pf-'));
    try {
      assert.equal(checkWritePermission(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a hard error when writing throws', () => {
    const d = checkWritePermission('/x', {
      write: () => { const e = new Error('read-only'); e.code = 'EROFS'; throw e; },
    });
    assert.ok(d);
    assert.equal(d.level, 'error');
    assert.equal(d.id, 'write-permission');
    assert.match(d.message, /EROFS/);
  });
});

describe('checkNpmAvailable (#152)', () => {
  it('passes when npm --version exits 0', () => {
    assert.equal(checkNpmAvailable({ spawnSync: () => ({ status: 0 }) }), null);
  });

  it('warns when npm is not found', () => {
    const d = checkNpmAvailable({ spawnSync: () => ({ error: new Error('ENOENT') }) });
    assert.ok(d);
    assert.equal(d.level, 'warn');
    assert.equal(d.id, 'npm-available');
  });
});

describe('runInitPreflight (#152)', () => {
  const goodProbes = {
    detect: () => ({ owner: 'a', repo: 'b' }),
    write: () => {},
    remove: () => {},
    spawnSync: () => ({ status: 0 }),
  };

  it('is ok with a healthy environment', () => {
    const { ok, diagnostics } = runInitPreflight({
      cwd: '/x', nodeVersion: 'v22.0.0', probes: goodProbes,
    });
    assert.equal(ok, true);
    assert.equal(diagnostics.length, 0);
  });

  it('blocks (ok=false) on an old Node, even with warnings present', () => {
    const { ok, diagnostics } = runInitPreflight({
      cwd: '/x', nodeVersion: 'v18.0.0',
      probes: { ...goodProbes, detect: () => null },
    });
    assert.equal(ok, false);
    assert.ok(diagnostics.some((d) => d.id === 'node-version' && d.level === 'error'));
  });

  it('skips the git-remote check in --yes mode (resolveHeadlessConfig owns that error)', () => {
    const { diagnostics } = runInitPreflight({
      cwd: '/x', yes: true, nodeVersion: 'v22.0.0',
      probes: { ...goodProbes, detect: () => null },
    });
    assert.equal(diagnostics.some((d) => d.id === 'git-remote'), false);
  });

  it('checks npm only when a template will be installed', () => {
    const failingNpm = { ...goodProbes, spawnSync: () => ({ error: new Error('x') }) };
    const selfHosted = runInitPreflight({
      cwd: '/x', selfHosted: true, nodeVersion: 'v22.0.0', probes: failingNpm,
    });
    assert.equal(selfHosted.diagnostics.some((d) => d.id === 'npm-available'), false);

    const fresh = runInitPreflight({
      cwd: '/x', selfHosted: false, hasTemplate: false, nodeVersion: 'v22.0.0', probes: failingNpm,
    });
    assert.equal(fresh.diagnostics.some((d) => d.id === 'npm-available'), true);

    const alreadyInstalled = runInitPreflight({
      cwd: '/x', selfHosted: false, hasTemplate: true, nodeVersion: 'v22.0.0', probes: failingNpm,
    });
    assert.equal(alreadyInstalled.diagnostics.some((d) => d.id === 'npm-available'), false);
  });
});

describe('formatPreflightDiagnostics (#152)', () => {
  it('renders ✗ for errors and ⚠ for warnings with indented recovery', () => {
    const lines = formatPreflightDiagnostics([
      { level: 'error', id: 'a', message: 'boom', recovery: 'fix it' },
      { level: 'warn', id: 'b', message: 'heads up', recovery: 'maybe fix' },
    ]);
    assert.deepEqual(lines, ['✗ boom', '  → fix it', '⚠ heads up', '  → maybe fix']);
  });
});

describe('explainInstallFailure (#152)', () => {
  it('identifies a network failure', () => {
    const { message, recovery } = explainInstallFailure(new Error('fatal: unable to access: Could not resolve host: github.com'));
    assert.match(message, /Network unreachable/);
    assert.ok(recovery.some((r) => /internet connection|proxy/.test(r)));
  });

  it('identifies an enterprise/SSO policy denial', () => {
    const { message, recovery } = explainInstallFailure(new Error('remote: 403 Forbidden — SAML SSO enforcement'));
    assert.match(message, /enterprise\/SSO policy/);
    assert.ok(recovery.some((r) => /SSO|gh auth login|mirror/.test(r)));
  });

  it('always offers the offline --vendor escape hatch and echoes the template url', () => {
    const { recovery } = explainInstallFailure(new Error('boom'), { templateUrl: 'https://x/y.git' });
    assert.ok(recovery.some((r) => /--vendor/.test(r)));
    assert.ok(recovery.some((r) => r.includes('https://x/y.git')));
  });
});
