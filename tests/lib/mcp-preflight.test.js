import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  detectConfiguredMcpServers,
  runMcpPreflight,
  formatMcpPreflightErrors,
} = await import('../../src/lib/mcp-preflight.js');

const {
  copilotAdapter,
  claudeAdapter,
  createCustomAdapter,
} = await import('../../src/lib/copilot-runtime.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mcp-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, data) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── detectConfiguredMcpServers — claude adapter ───────────────────────────────

describe('detectConfiguredMcpServers — claude adapter', () => {
  it('returns empty set when no config files exist', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const { servers, sources, undetectable } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(undetectable, false);
        assert.strictEqual(servers.size, 0);
        assert.deepStrictEqual(sources, []);
      });
    });
  });

  it('reads mcpServers keys from .mcp.json at repo root', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: {
            ado: { command: 'npx', args: ['-y', 'ado-mcp'] },
            sharepoint: { command: 'npx', args: ['-y', 'sharepoint-mcp'] },
          },
        });
        const { servers, sources } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('sharepoint'));
        assert.strictEqual(servers.size, 2);
        assert.ok(sources.some((s) => s.includes('.mcp.json')));
      });
    });
  });

  it('reads project mcpServers from ~/.claude.json matching cwd', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(home, '.claude.json'), {
          projects: {
            [cwd]: {
              mcpServers: { 'org-chart': { command: 'npx', args: ['-y', 'org-chart-mcp'] } },
            },
          },
        });
        const { servers, sources } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('org-chart'));
        assert.ok(sources.some((s) => s.includes('.claude.json')));
      });
    });
  });

  it('ignores ~/.claude.json project entries for other directories', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(home, '.claude.json'), {
          projects: {
            '/some/other/project': {
              mcpServers: { 'other-server': {} },
            },
          },
        });
        const { servers } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(servers.size, 0);
      });
    });
  });

  it('merges servers from both .mcp.json and ~/.claude.json', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { ado: { command: 'npx', args: [] } },
        });
        writeJson(join(home, '.claude.json'), {
          projects: {
            [cwd]: {
              mcpServers: { 'org-chart': { command: 'npx', args: [] } },
            },
          },
        });
        const { servers } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('org-chart'));
        assert.strictEqual(servers.size, 2);
      });
    });
  });

  it('ignores malformed .mcp.json gracefully', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeFileSync(join(cwd, '.mcp.json'), 'NOT JSON', 'utf-8');
        const { servers } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(servers.size, 0);
      });
    });
  });

  it('ignores .mcp.json when mcpServers is not an object', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), { mcpServers: ['ado'] });
        const { servers } = detectConfiguredMcpServers(
          claudeAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(servers.size, 0);
      });
    });
  });
});

// ── detectConfiguredMcpServers — copilot adapter ─────────────────────────────

describe('detectConfiguredMcpServers — copilot adapter', () => {
  it('returns empty set when no config files exist', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const { servers, undetectable } = detectConfiguredMcpServers(
          copilotAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(undetectable, false);
        assert.strictEqual(servers.size, 0);
      });
    });
  });

  it('reads servers keys from .github/copilot/mcp.json', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.github', 'copilot', 'mcp.json'), {
          servers: {
            ado: { command: 'npx', args: ['-y', 'ado-mcp'] },
            sharepoint: { command: 'npx', args: ['-y', 'sharepoint-mcp'] },
          },
        });
        const { servers, sources } = detectConfiguredMcpServers(
          copilotAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('sharepoint'));
        assert.strictEqual(servers.size, 2);
        assert.ok(sources.some((s) => s.includes('mcp.json')));
      });
    });
  });

  it('reads servers keys from ~/.copilot/mcp.json', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(home, '.copilot', 'mcp.json'), {
          servers: { 'org-chart': { command: 'npx', args: [] } },
        });
        const { servers, sources } = detectConfiguredMcpServers(
          copilotAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('org-chart'));
        assert.ok(sources.some((s) => s.includes('.copilot')));
      });
    });
  });

  it('merges servers from both repo-local and user-level config', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.github', 'copilot', 'mcp.json'), {
          servers: { ado: { command: 'npx', args: [] } },
        });
        writeJson(join(home, '.copilot', 'mcp.json'), {
          servers: { 'org-chart': { command: 'npx', args: [] } },
        });
        const { servers } = detectConfiguredMcpServers(
          copilotAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('org-chart'));
        assert.strictEqual(servers.size, 2);
      });
    });
  });

  it('ignores malformed repo-local mcp.json gracefully', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        mkdirSync(join(cwd, '.github', 'copilot'), { recursive: true });
        writeFileSync(join(cwd, '.github', 'copilot', 'mcp.json'), '{ bad json', 'utf-8');
        const { servers } = detectConfiguredMcpServers(
          copilotAdapter, cwd, { env: { HOME: home, USERPROFILE: home } },
        );
        assert.strictEqual(servers.size, 0);
      });
    });
  });
});

// ── detectConfiguredMcpServers — custom adapter ──────────────────────────────

describe('detectConfiguredMcpServers — custom adapter', () => {
  it('returns undetectable=true for custom adapter', () => {
    withTempDir((cwd) => {
      const customAdapter = createCustomAdapter({
        name: 'custom',
        defaultBinary: 'my-agent',
        argsTemplate: ['{prompt}'],
      });
      const { servers, undetectable } = detectConfiguredMcpServers(customAdapter, cwd);
      assert.strictEqual(undetectable, true);
      assert.strictEqual(servers.size, 0);
    });
  });

  it('returns undetectable=true even when config files exist', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), { mcpServers: { ado: {} } });
        const customAdapter = createCustomAdapter({
          name: 'custom',
          defaultBinary: 'my-agent',
          argsTemplate: ['{prompt}'],
        });
        const { undetectable } = detectConfiguredMcpServers(
          customAdapter, cwd, { env: { HOME: home } },
        );
        assert.strictEqual(undetectable, true);
      });
    });
  });
});

// ── runMcpPreflight ───────────────────────────────────────────────────────────

describe('runMcpPreflight', () => {
  it('returns ok=true immediately when config has no mcp block', () => {
    withTempDir((cwd) => {
      const result = runMcpPreflight({
        adapter: claudeAdapter,
        config: { agent: 'claude' },
        cwd,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missing, []);
      assert.deepStrictEqual(result.warnings, []);
    });
  });

  it('returns ok=true immediately when config is null', () => {
    withTempDir((cwd) => {
      const result = runMcpPreflight({
        adapter: claudeAdapter,
        config: null,
        cwd,
      });
      assert.strictEqual(result.ok, true);
    });
  });

  it('ok=true when all required servers are configured (claude)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: {
            ado: { command: 'npx', args: ['-y', 'ado-mcp'] },
            'sharepoint-docs': { command: 'npx', args: ['-y', 'sharepoint-mcp'] },
          },
        });
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado', 'sharepoint-docs'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
      });
    });
  });

  it('ok=false when a required server is missing (claude)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        // Only 'ado' is configured, not 'sharepoint-docs'
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { ado: { command: 'npx', args: [] } },
        });
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado', 'sharepoint-docs'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing, ['sharepoint-docs']);
      });
    });
  });

  it('ok=false when all required servers are missing (copilot)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        // No config files at all
        const result = runMcpPreflight({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing, ['ado']);
      });
    });
  });

  it('ok=true with warning when optional server is missing (claude)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { ado: { command: 'npx', args: [] } },
        });
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: {
            agent: 'claude',
            mcp: { required: ['ado'], optional: ['org-chart'] },
          },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
        assert.strictEqual(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('org-chart'));
      });
    });
  });

  it('optional-only mcp block never fails', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { optional: ['org-chart'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.warnings.length, 1);
      });
    });
  });

  it('no warning when optional server IS configured', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { 'org-chart': {} },
        });
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { optional: ['org-chart'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.warnings.length, 0);
      });
    });
  });

  it('custom adapter: all servers reported as unverifiable, ok=true', () => {
    withTempDir((cwd) => {
      const customAdapter = createCustomAdapter({
        name: 'custom',
        defaultBinary: 'my-agent',
        argsTemplate: ['{prompt}'],
      });
      const result = runMcpPreflight({
        adapter: customAdapter,
        config: {
          agent: 'custom',
          mcp: { required: ['ado'], optional: ['org-chart'] },
        },
        cwd,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missing, []);
      assert.ok(result.unverifiable.includes('ado'));
      assert.ok(result.unverifiable.includes('org-chart'));
      assert.strictEqual(result.warnings.length, 2);
    });
  });

  it('empty mcp block: ok=true, no warnings', () => {
    withTempDir((cwd) => {
      const result = runMcpPreflight({
        adapter: claudeAdapter,
        config: { agent: 'claude', mcp: {} },
        cwd,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missing, []);
      assert.deepStrictEqual(result.warnings, []);
    });
  });
});

// ── formatMcpPreflightErrors ──────────────────────────────────────────────────

describe('formatMcpPreflightErrors', () => {
  it('returns empty array for no missing servers', () => {
    withTempDir((cwd) => {
      const lines = formatMcpPreflightErrors([], 'claude', cwd);
      assert.deepStrictEqual(lines, []);
    });
  });

  it('names the missing server and expected config file (claude)', () => {
    withTempDir((cwd) => {
      const lines = formatMcpPreflightErrors(['ado'], 'claude', cwd);
      assert.ok(lines.some((l) => l.includes('ado')));
      assert.ok(lines.some((l) => l.includes('.mcp.json')));
      assert.ok(lines.some((l) => l.includes('mcpServers')));
      assert.ok(lines.some((l) => l.includes('--skip-preflight')));
    });
  });

  it('names the missing server and expected config file (copilot)', () => {
    withTempDir((cwd) => {
      const lines = formatMcpPreflightErrors(['sharepoint-docs'], 'copilot', cwd);
      assert.ok(lines.some((l) => l.includes('sharepoint-docs')));
      assert.ok(lines.some((l) => l.includes('.github/copilot/mcp.json') || l.includes('mcp.json')));
      assert.ok(lines.some((l) => l.includes('"servers"')));
    });
  });

  it('names all missing servers when multiple are absent', () => {
    withTempDir((cwd) => {
      const lines = formatMcpPreflightErrors(['ado', 'sharepoint'], 'claude', cwd);
      assert.ok(lines.some((l) => l.includes('ado')));
      assert.ok(lines.some((l) => l.includes('sharepoint')));
    });
  });

  it('includes --skip-preflight escape hatch mention', () => {
    withTempDir((cwd) => {
      const lines = formatMcpPreflightErrors(['ado'], 'claude', cwd);
      assert.ok(lines.some((l) => l.includes('--skip-preflight')));
    });
  });
});
