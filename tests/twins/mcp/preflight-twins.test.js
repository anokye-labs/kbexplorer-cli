/**
 * Hermetic preflight tests against the MCP twin config.
 *
 * Exercises `runMcpPreflight` / `detectConfiguredMcpServers` against realistic
 * adapter config that declares the `ado` and `sharepoint-docs` twins — proving
 * the preflight sees them as configured, and reports them missing when absent.
 * No network, no live ADO/SharePoint, no real agent.
 *
 * Per the holdout rule, all assertions live here; the twins only ship canned data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { detectConfiguredMcpServers, runMcpPreflight, formatMcpPreflightErrors } = await import(
  '../../../src/lib/mcp-preflight.js'
);
const { claudeAdapter, copilotAdapter, createCustomAdapter } = await import(
  '../../../src/lib/copilot-runtime.js'
);
const {
  writeClaudeRepoConfig,
  writeClaudeUserConfig,
  writeCopilotConfig,
  buildTwinServerMap,
  TWIN_SERVERS,
} = await import('../../../twins/mcp/lib/config-helpers.js');

const TWIN_NAMES = ['ado', 'sharepoint-docs'];

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mcp-twin-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The twin config map itself ────────────────────────────────────────────────

describe('twin server config map', () => {
  it('declares both twins as runnable node stdio servers', () => {
    const map = buildTwinServerMap();
    assert.deepStrictEqual(Object.keys(map).sort(), [...TWIN_NAMES].sort());
    for (const name of TWIN_NAMES) {
      assert.strictEqual(map[name].command, process.execPath);
      assert.ok(map[name].args[0].endsWith(`${name}-server.js`));
      assert.strictEqual(map[name].args[0], TWIN_SERVERS[name]);
    }
  });

  it('rejects an unknown twin name', () => {
    assert.throws(() => buildTwinServerMap(['nope']), /Unknown MCP twin/);
  });
});

// ── Claude: repo-local .mcp.json ───────────────────────────────────────────────

describe('preflight against twins — claude .mcp.json', () => {
  it('detects both twins as configured', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeRepoConfig(cwd, TWIN_NAMES);
        const { servers, sources, undetectable } = detectConfiguredMcpServers(claudeAdapter, cwd, {
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(undetectable, false);
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('sharepoint-docs'));
        assert.ok(sources.some((s) => s.endsWith('.mcp.json')));
      }),
    );
  });

  it('passes preflight when both twins are required and configured', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeRepoConfig(cwd, TWIN_NAMES);
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
        assert.deepStrictEqual(result.warnings, []);
      }),
    );
  });

  it('reports the missing twin when only one is configured', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeRepoConfig(cwd, ['ado']); // sharepoint-docs absent
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing, ['sharepoint-docs']);
      }),
    );
  });

  it('fails with both twins missing when no config is written, with actionable errors', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing.sort(), [...TWIN_NAMES].sort());

        const lines = formatMcpPreflightErrors(result.missing, 'claude', cwd, {
          HOME: home,
          USERPROFILE: home,
        });
        assert.ok(lines.some((l) => l.includes('ado')));
        assert.ok(lines.some((l) => l.includes('sharepoint-docs')));
        assert.ok(lines.some((l) => l.includes('.mcp.json')));
      }),
    );
  });

  it('treats sharepoint-docs as an optional twin — warns but passes when absent', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeRepoConfig(cwd, ['ado']);
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado'], optional: ['sharepoint-docs'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
        assert.strictEqual(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('sharepoint-docs'));
      }),
    );
  });
});

// ── Claude: user-level ~/.claude.json ──────────────────────────────────────────

describe('preflight against twins — claude ~/.claude.json (project scope)', () => {
  it('detects twins declared under the matching project path', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeUserConfig(home, cwd, TWIN_NAMES);
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
      }),
    );
  });

  it('does not see twins scoped to a different project path', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeClaudeUserConfig(home, join(cwd, 'elsewhere'), TWIN_NAMES);
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing.sort(), [...TWIN_NAMES].sort());
      }),
    );
  });
});

// ── Copilot: ~/.copilot/mcp-config.json ────────────────────────────────────────

describe('preflight against twins — copilot mcp-config.json', () => {
  it('detects both twins as configured', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeCopilotConfig(home, TWIN_NAMES);
        const { servers, sources } = detectConfiguredMcpServers(copilotAdapter, cwd, {
          env: { HOME: home, USERPROFILE: home },
        });
        assert.ok(servers.has('ado'));
        assert.ok(servers.has('sharepoint-docs'));
        assert.ok(sources.some((s) => s.endsWith('mcp-config.json')));
      }),
    );
  });

  it('passes preflight when both twins are required and configured', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        writeCopilotConfig(home, TWIN_NAMES);
        const result = runMcpPreflight({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
      }),
    );
  });

  it('reports both twins missing when copilot config is absent', () => {
    withTempDir((cwd) =>
      withTempDir((home) => {
        const result = runMcpPreflight({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: TWIN_NAMES } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing.sort(), [...TWIN_NAMES].sort());
      }),
    );
  });
});

// ── Custom adapter: twins are unverifiable, never a hard failure ────────────────

describe('preflight against twins — custom adapter', () => {
  it('reports both twins as unverifiable (ok=true) even when declared required', () => {
    withTempDir((cwd) => {
      const custom = createCustomAdapter({
        name: 'custom',
        defaultBinary: 'my-agent',
        argsTemplate: ['{prompt}'],
      });
      const result = runMcpPreflight({
        adapter: custom,
        config: { agent: 'custom', mcp: { required: TWIN_NAMES } },
        cwd,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missing, []);
      assert.deepStrictEqual(result.unverifiable.sort(), [...TWIN_NAMES].sort());
      assert.strictEqual(result.warnings.length, 2);
    });
  });
});
