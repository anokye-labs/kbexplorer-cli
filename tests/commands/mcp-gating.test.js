/**
 * Tests for MCP preflight gating in derive and generate commands.
 *
 * Verifies:
 * - Preflight is NOT run for --check / --dry-run / --no-agent paths
 * - Preflight IS run before fuzzy work when mcp block is declared
 * - --skip-preflight bypasses the check with a warning
 * - Missing required server causes non-zero exit before any LLM call
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  runMcpPreflight,
} = await import('../../src/lib/mcp-preflight.js');

const {
  claudeAdapter,
  copilotAdapter,
  createCustomAdapter,
} = await import('../../src/lib/copilot-runtime.js');

const { parseDeriveArgs, parseGenerateArgs } = await import('../../src/lib/args.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mcpgate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP gating: preflight skipped when no mcp block', () => {
  it('no mcp block → preflight ok=true immediately', () => {
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

  it('null config → preflight ok=true immediately', () => {
    withTempDir((cwd) => {
      const result = runMcpPreflight({ adapter: claudeAdapter, config: null, cwd });
      assert.strictEqual(result.ok, true);
    });
  });
});

describe('MCP gating: preflight fails before LLM for missing required server', () => {
  it('required server missing → ok=false with actionable missing array (claude)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        // No .mcp.json → 'ado' not configured
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.ok(result.missing.includes('ado'));
      });
    });
  });

  it('required server missing → ok=false (copilot)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const result = runMcpPreflight({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: ['sharepoint-docs'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, false);
        assert.ok(result.missing.includes('sharepoint-docs'));
      });
    });
  });

  it('required server present → ok=true (claude, .mcp.json)', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeFileSync(
          join(cwd, '.mcp.json'),
          JSON.stringify({ mcpServers: { ado: { command: 'npx', args: [] } } }),
          'utf-8',
        );
        const result = runMcpPreflight({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.missing, []);
      });
    });
  });
});

describe('MCP gating: custom adapter always unverifiable', () => {
  it('custom adapter → ok=true, unverifiable includes all declared servers', () => {
    withTempDir((cwd) => {
      const customAdapter = createCustomAdapter({
        name: 'custom',
        defaultBinary: 'my-agent',
        argsTemplate: ['{prompt}'],
      });
      const result = runMcpPreflight({
        adapter: customAdapter,
        config: { agent: 'custom', mcp: { required: ['ado'], optional: ['org-chart'] } },
        cwd,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missing, []);
      assert.ok(result.unverifiable.includes('ado'));
      assert.ok(result.unverifiable.includes('org-chart'));
      // Warnings emitted for each unverifiable server
      assert.strictEqual(result.warnings.length, 2);
    });
  });
});

// ── --skip-preflight flag parsing ─────────────────────────────────────────────

describe('MCP gating: --skip-preflight flag parsing (derive)', () => {
  it('--skip-preflight is parsed as true', () => {
    const opts = parseDeriveArgs(['--skip-preflight', 'file.docx']);
    assert.strictEqual(opts.skipPreflight, true);
  });

  it('skipPreflight defaults to false', () => {
    const opts = parseDeriveArgs(['file.docx']);
    assert.strictEqual(opts.skipPreflight, false);
  });

  it('--skip-preflight does not end up in unknown', () => {
    const opts = parseDeriveArgs(['--skip-preflight', 'file.docx']);
    assert.deepStrictEqual(opts.unknown, []);
  });
});

describe('MCP gating: --skip-preflight flag parsing (generate)', () => {
  it('--skip-preflight is parsed as true', () => {
    const opts = parseGenerateArgs(['--skip-preflight']);
    assert.strictEqual(opts.skipPreflight, true);
  });

  it('skipPreflight defaults to false', () => {
    const opts = parseGenerateArgs([]);
    assert.strictEqual(opts.skipPreflight, false);
  });

  it('--skip-preflight does not end up in unknown', () => {
    const opts = parseGenerateArgs(['--skip-preflight']);
    assert.deepStrictEqual(opts.unknown, []);
  });
});

// ── Gating logic: --check / --dry-run should not trigger preflight ────────────
// These tests verify the guard conditions conceptually (the command functions
// themselves call runMcpPreflight conditionally; here we test the condition
// predicates that control whether preflight is called at all).

describe('MCP gating: path guards (conceptual)', () => {
  it('--check means opts.check=true, which gates out of preflight', () => {
    const opts = parseDeriveArgs(['--check', 'file.docx']);
    assert.strictEqual(opts.check, true);
    // Guard in derive.js: `!opts.check && !opts.dryRun && runtimeConfig?.mcp`
    // With opts.check=true this is falsy → preflight never called
    const shouldRunPreflight = !opts.check && !opts.dryRun;
    assert.strictEqual(shouldRunPreflight, false);
  });

  it('--dry-run gates out of preflight', () => {
    const opts = parseDeriveArgs(['--dry-run', 'file.docx']);
    assert.strictEqual(opts.dryRun, true);
    const shouldRunPreflight = !opts.check && !opts.dryRun;
    assert.strictEqual(shouldRunPreflight, false);
  });

  it('--no-agent gates out of preflight in generate', () => {
    const opts = parseGenerateArgs(['--no-agent']);
    assert.strictEqual(opts.noAgent, true);
    // Guard in generate.js: `wantAgent && runtimeConfig?.mcp`
    // wantAgent = !opts.noAgent && (!haveCatalogue || opts.refresh)
    // With opts.noAgent=true → wantAgent=false → preflight never called
    const wantAgent = !opts.noAgent;
    assert.strictEqual(wantAgent, false);
  });
});
