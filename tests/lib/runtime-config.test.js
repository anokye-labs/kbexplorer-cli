import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  validateRuntimeBlock,
  loadRuntimeConfig,
  resolveRuntime,
  adapterFromConfig,
  applyRuntimeConfigDefaults,
  RuntimeConfigError,
  RUNTIME_ENV,
  KNOWN_AGENTS,
} = await import('../../src/lib/runtime-config.js');

const {
  copilotAdapter,
  claudeAdapter,
} = await import('../../src/lib/copilot-runtime.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-rtcfg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeKbJson(dir, data) {
  writeFileSync(join(dir, '.kbexplorer.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// ── validateRuntimeBlock ─────────────────────────────────────────────────────

describe('validateRuntimeBlock — valid shapes', () => {
  it('accepts { agent: "copilot" }', () => {
    const out = validateRuntimeBlock({ agent: 'copilot' });
    assert.strictEqual(out.agent, 'copilot');
  });

  it('accepts { agent: "claude" }', () => {
    const out = validateRuntimeBlock({ agent: 'claude' });
    assert.strictEqual(out.agent, 'claude');
  });

  it('accepts a full custom config', () => {
    const out = validateRuntimeBlock({
      agent: 'custom',
      command: 'my-llm',
      argsTemplate: ['-p', '{prompt}', '--json'],
      outputFormat: 'jsonl',
      timeoutMs: 120000,
      binaryEnv: 'MY_LLM_BIN',
    });
    assert.strictEqual(out.agent, 'custom');
    assert.strictEqual(out.command, 'my-llm');
    assert.deepStrictEqual(out.argsTemplate, ['-p', '{prompt}', '--json']);
    assert.strictEqual(out.outputFormat, 'jsonl');
    assert.strictEqual(out.timeoutMs, 120000);
    assert.strictEqual(out.binaryEnv, 'MY_LLM_BIN');
  });

  it('accepts a minimal custom config with {prompt} inline', () => {
    const out = validateRuntimeBlock({
      agent: 'custom',
      command: 'agent',
      argsTemplate: ['{prompt}'],
    });
    assert.strictEqual(out.agent, 'custom');
    assert.deepStrictEqual(out.argsTemplate, ['{prompt}']);
  });

  it('normalises agent name to lowercase', () => {
    const out = validateRuntimeBlock({ agent: 'Copilot' });
    assert.strictEqual(out.agent, 'copilot');
  });

  it('accepts optional timeoutMs on copilot agent', () => {
    const out = validateRuntimeBlock({ agent: 'copilot', timeoutMs: 30000 });
    assert.strictEqual(out.timeoutMs, 30000);
  });

  it('rejects outputFormat on non-custom agents (named adapters parse their own output)', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', outputFormat: 'text' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('outputFormat'),
    );
  });
});

describe('validateRuntimeBlock — invalid shapes', () => {
  it('throws when runtime block is null', () => {
    assert.throws(() => validateRuntimeBlock(null), RuntimeConfigError);
  });

  it('throws when runtime block is an array', () => {
    assert.throws(() => validateRuntimeBlock([]), RuntimeConfigError);
  });

  it('throws when runtime block is a string', () => {
    assert.throws(() => validateRuntimeBlock('copilot'), RuntimeConfigError);
  });

  it('throws when agent is missing', () => {
    assert.throws(
      () => validateRuntimeBlock({}),
      (err) => err instanceof RuntimeConfigError && err.message.includes('runtime.agent is required'),
    );
  });

  it('throws when agent is an unknown name', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'openai' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('"openai"'),
    );
  });

  it('throws when custom agent is missing command', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', argsTemplate: ['{prompt}'] }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('runtime.command'),
    );
  });

  it('throws when custom agent is missing argsTemplate', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', command: 'my-agent' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('runtime.argsTemplate'),
    );
  });

  it('throws when argsTemplate is not an array', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', command: 'my-agent', argsTemplate: '-p {prompt}' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('array'),
    );
  });

  it('throws when argsTemplate is empty', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', command: 'my-agent', argsTemplate: [] }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('empty'),
    );
  });

  it('throws when argsTemplate has no {prompt} placeholder', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', command: 'my-agent', argsTemplate: ['--input', 'data'] }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('{prompt}'),
    );
  });

  it('throws when argsTemplate entry is not a string', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'custom', command: 'my-agent', argsTemplate: ['{prompt}', 42] }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('strings'),
    );
  });

  it('throws when outputFormat is invalid', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', outputFormat: 'xml' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('outputFormat'),
    );
  });

  it('throws when timeoutMs is negative', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', timeoutMs: -1000 }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('timeoutMs'),
    );
  });

  it('throws when timeoutMs is not a number', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', timeoutMs: 'forever' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('timeoutMs'),
    );
  });

  it('throws when command is supplied for non-custom agent', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', command: 'my-agent' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('command'),
    );
  });

  it('throws when argsTemplate is supplied for non-custom agent', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'claude', argsTemplate: ['{prompt}'] }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('argsTemplate'),
    );
  });

  it('throws when binaryEnv is supplied for non-custom agent', () => {
    assert.throws(
      () => validateRuntimeBlock({ agent: 'copilot', binaryEnv: 'MY_BIN' }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('binaryEnv'),
    );
  });
});

// ── loadRuntimeConfig ────────────────────────────────────────────────────────

describe('loadRuntimeConfig', () => {
  it('returns null when .kbexplorer.json is absent', () => {
    withTempDir((dir) => {
      assert.strictEqual(loadRuntimeConfig(dir), null);
    });
  });

  it('returns null when .kbexplorer.json has no runtime block', () => {
    withTempDir((dir) => {
      writeKbJson(dir, { template: 'https://example.com/t.git', mode: 'vendor' });
      assert.strictEqual(loadRuntimeConfig(dir), null);
    });
  });

  it('loads and validates a valid runtime block', () => {
    withTempDir((dir) => {
      writeKbJson(dir, {
        template: 'https://example.com/t.git',
        runtime: { agent: 'claude' },
      });
      const cfg = loadRuntimeConfig(dir);
      assert.deepStrictEqual(cfg, { agent: 'claude' });
    });
  });

  it('throws RuntimeConfigError when runtime block is invalid', () => {
    withTempDir((dir) => {
      writeKbJson(dir, { runtime: { agent: 'openai' } });
      assert.throws(() => loadRuntimeConfig(dir), RuntimeConfigError);
    });
  });

  it('preserves all custom fields', () => {
    withTempDir((dir) => {
      writeKbJson(dir, {
        runtime: {
          agent: 'custom',
          command: 'my-tool',
          argsTemplate: ['-q', '{prompt}'],
          outputFormat: 'jsonl',
          timeoutMs: 60000,
          binaryEnv: 'MY_TOOL_BIN',
        },
      });
      const cfg = loadRuntimeConfig(dir);
      assert.strictEqual(cfg.agent, 'custom');
      assert.strictEqual(cfg.command, 'my-tool');
      assert.deepStrictEqual(cfg.argsTemplate, ['-q', '{prompt}']);
      assert.strictEqual(cfg.outputFormat, 'jsonl');
      assert.strictEqual(cfg.timeoutMs, 60000);
      assert.strictEqual(cfg.binaryEnv, 'MY_TOOL_BIN');
    });
  });
});

// ── adapterFromConfig ────────────────────────────────────────────────────────

describe('adapterFromConfig', () => {
  it('returns a copilot adapter for agent=copilot', () => {
    const adapter = adapterFromConfig({ agent: 'copilot' });
    assert.strictEqual(adapter.name, 'copilot');
    assert.ok(typeof adapter.buildArgs === 'function');
  });

  it('returns a claude adapter for agent=claude', () => {
    const adapter = adapterFromConfig({ agent: 'claude' });
    assert.strictEqual(adapter.name, 'claude');
  });

  it('returns a custom adapter with the configured binary and argsTemplate', () => {
    const config = {
      agent: 'custom',
      command: 'my-llm',
      argsTemplate: ['--ask', '{prompt}'],
      outputFormat: 'text',
    };
    const adapter = adapterFromConfig(config);
    assert.strictEqual(adapter.name, 'custom');
    assert.strictEqual(adapter.defaultBinary, 'my-llm');
    const args = adapter.buildArgs({ prompt: 'hello' });
    assert.deepStrictEqual(args, ['--ask', 'hello']);
  });

  it('custom adapter with binaryEnv', () => {
    const adapter = adapterFromConfig({
      agent: 'custom',
      command: 'my-llm',
      argsTemplate: ['{prompt}'],
      binaryEnv: 'MY_LLM_BIN',
    });
    assert.strictEqual(adapter.binaryEnv, 'MY_LLM_BIN');
  });
});

// ── resolveRuntime — precedence ───────────────────────────────────────────────

describe('resolveRuntime — precedence chain', () => {
  it('returns copilot adapter by default (no flag, no config, no env)', () => {
    const adapter = resolveRuntime({ env: {} });
    assert.strictEqual(adapter, copilotAdapter);
  });

  it('respects explicit --runtime flag (highest priority)', () => {
    const adapter = resolveRuntime({
      flag: 'claude',
      config: null,
      env: { [RUNTIME_ENV]: 'copilot' },
    });
    assert.strictEqual(adapter, claudeAdapter);
  });

  it('--runtime flag overrides config file', () => {
    const config = { agent: 'claude' };
    const adapter = resolveRuntime({ flag: 'copilot', config, env: {} });
    assert.strictEqual(adapter, copilotAdapter);
  });

  it('.kbexplorer.json config beats env var', () => {
    const config = { agent: 'claude' };
    const adapter = resolveRuntime({ flag: null, config, env: { [RUNTIME_ENV]: 'copilot' } });
    assert.strictEqual(adapter.name, 'claude');
  });

  it('KBEXPLORER_RUNTIME env var beats default', () => {
    const adapter = resolveRuntime({ flag: null, config: null, env: { [RUNTIME_ENV]: 'claude' } });
    assert.strictEqual(adapter, claudeAdapter);
  });

  it('falls back to default (copilot) when env var is unset', () => {
    const adapter = resolveRuntime({ flag: null, config: null, env: {} });
    assert.strictEqual(adapter, copilotAdapter);
  });

  it('resolves copilot flag to copilot adapter', () => {
    const adapter = resolveRuntime({ flag: 'copilot', env: {} });
    assert.strictEqual(adapter, copilotAdapter);
  });

  it('throws RuntimeConfigError for unknown flag value', () => {
    assert.throws(
      () => resolveRuntime({ flag: 'openai', env: {} }),
      RuntimeConfigError,
    );
  });

  it('throws RuntimeConfigError for unknown env var value', () => {
    assert.throws(
      () => resolveRuntime({ flag: null, config: null, env: { [RUNTIME_ENV]: 'gemini' } }),
      RuntimeConfigError,
    );
  });

  it('throws RuntimeConfigError when "custom" is specified via flag without config', () => {
    assert.throws(
      () => resolveRuntime({ flag: 'custom', config: null, env: {} }),
      (err) => err instanceof RuntimeConfigError && err.message.includes('runtime block'),
    );
  });

  it('--runtime custom resolves the configured custom adapter when a custom config exists', () => {
    const config = { agent: 'custom', command: 'my-agent', argsTemplate: ['-p', '{prompt}'] };
    const adapter = resolveRuntime({ flag: 'custom', config, env: {} });
    assert.strictEqual(adapter.name, 'custom');
    assert.strictEqual(adapter.defaultBinary, 'my-agent');
  });

  it('--runtime custom still errors when the config block is for a named agent', () => {
    const config = { agent: 'claude' };
    assert.throws(
      () => resolveRuntime({ flag: 'custom', config, env: {} }),
      RuntimeConfigError,
    );
  });

  it('resolves custom adapter from config', () => {
    const config = {
      agent: 'custom',
      command: 'my-agent',
      argsTemplate: ['-p', '{prompt}'],
    };
    const adapter = resolveRuntime({ flag: null, config, env: {} });
    assert.strictEqual(adapter.name, 'custom');
    assert.strictEqual(adapter.defaultBinary, 'my-agent');
  });

  it('empty string flag is treated as absent (falls through to config)', () => {
    const config = { agent: 'claude' };
    const adapter = resolveRuntime({ flag: '', config, env: {} });
    assert.strictEqual(adapter.name, 'claude');
  });

  it('empty string env var is treated as absent (falls through to default)', () => {
    const adapter = resolveRuntime({ flag: null, config: null, env: { [RUNTIME_ENV]: '' } });
    assert.strictEqual(adapter, copilotAdapter);
  });
});

// ── KNOWN_AGENTS export ───────────────────────────────────────────────────────

describe('KNOWN_AGENTS', () => {
  it('is frozen and contains the three adapters', () => {
    assert.deepStrictEqual([...KNOWN_AGENTS].sort(), ['claude', 'copilot', 'custom']);
    assert.ok(Object.isFrozen(KNOWN_AGENTS));
  });
});

// ── applyRuntimeConfigDefaults ────────────────────────────────────────────────

describe('applyRuntimeConfigDefaults', () => {
  it('threads config timeoutMs when the CLI did not set one', () => {
    const out = applyRuntimeConfigDefaults({ timeoutMs: undefined, silent: true }, { agent: 'copilot', timeoutMs: 120000 });
    assert.strictEqual(out.timeoutMs, 120000);
    assert.strictEqual(out.silent, true);
  });

  it('CLI timeout wins over config timeoutMs', () => {
    const out = applyRuntimeConfigDefaults({ timeoutMs: 5000 }, { agent: 'copilot', timeoutMs: 120000 });
    assert.strictEqual(out.timeoutMs, 5000);
  });

  it('is a no-op without a config or without config timeoutMs', () => {
    const opts = { silent: true };
    assert.strictEqual(applyRuntimeConfigDefaults(opts, null), opts);
    assert.strictEqual(applyRuntimeConfigDefaults(opts, { agent: 'claude' }), opts);
  });
});
