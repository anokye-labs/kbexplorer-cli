import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const {
  createCopilotAdapter,
  createClaudeAdapter,
  createCustomAdapter,
  runRuntimeTask,
  RuntimeAdapterError,
  RuntimeErrorCode,
  COPILOT_BIN_ENV,
  CLAUDE_BIN_ENV,
} = await import('../../src/lib/copilot-runtime.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_JSON_FIXTURE = readFileSync(resolve(__dirname, '..', 'fixtures', 'claude-json-result.json'), 'utf8');

function fakeSpawn({ stdout = '', stderr = '', code = 0, signal = null, error = null } = {}) {
  const calls = [];
  const fn = (binary, args) => {
    calls.push({ binary, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdin = { end: () => {} };
    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, signal);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

function hangingSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  // A real spawned child keeps the event loop alive via its stdio handles while
  // it runs. The fake child must emulate that; otherwise the unref'd timeout
  // watchdog can never fire (the loop drains first) and the run never settles,
  // which makes node:test cancel the timeout subtests in isolation.
  const keepAlive = setInterval(() => {}, 1 << 30);
  child.kill = () => {
    clearInterval(keepAlive);
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

describe('copilot adapter contract', () => {
  it('builds args and parses JSONL output', () => {
    const adapter = createCopilotAdapter();
    const args = adapter.buildArgs({ prompt: 'hi', outputFormat: 'json', allowTools: ['shell(git)'] });
    assert.deepStrictEqual(args, ['-p', 'hi', '--allow-tool=shell(git)', '--output-format', 'json', '--no-color']);

    const parsed = adapter.parseOutput('{"type":"assistant","text":"Hello"}\n', '', { outputFormat: 'json' });
    assert.strictEqual(parsed.response, 'Hello');
    assert.strictEqual(parsed.events.length, 1);
  });
});

describe('claude adapter contract', () => {
  it('maps allow tools and uses json output args', () => {
    const adapter = createClaudeAdapter();
    const args = adapter.buildArgs({ prompt: 'audit', allowTools: ['shell(git status)', 'write'] });
    assert.deepStrictEqual(args, ['-p', 'audit', '--output-format', 'json', '--allowedTools', 'Bash(git status:*),Write']);
  });

  it('preserves explicit claude bash scope patterns', () => {
    const adapter = createClaudeAdapter();
    const args = adapter.buildArgs({ prompt: 'audit', allowTools: ['shell(git:log)'] });
    assert.deepStrictEqual(args, ['-p', 'audit', '--output-format', 'json', '--allowedTools', 'Bash(git:log)']);
  });

  it('parses json output fixture with terminal result event', () => {
    const adapter = createClaudeAdapter();
    const parsed = adapter.parseOutput(CLAUDE_JSON_FIXTURE, '', {});
    assert.strictEqual(parsed.response, '{"entities":[{"id":"platform-team"}],"relationships":[]}');
    assert.strictEqual(parsed.events.length, 1);
  });

  it('maps denyTools to --disallowedTools', () => {
    const adapter = createClaudeAdapter();
    const args = adapter.buildArgs({ prompt: 'audit', denyTools: ['shell(rm)'] });
    assert.deepStrictEqual(args, ['-p', 'audit', '--output-format', 'json', '--disallowedTools', 'Bash(rm:*)']);
  });

  it('maps allowAllTools and allowAll to --dangerously-skip-permissions', () => {
    const adapter = createClaudeAdapter();
    for (const task of [{ prompt: 'x', allowAllTools: true }, { prompt: 'x', allowAll: true }]) {
      assert.deepStrictEqual(adapter.buildArgs(task), ['-p', 'x', '--output-format', 'json', '--dangerously-skip-permissions']);
    }
  });
});

describe('custom adapter contract', () => {
  it('substitutes args template with prompt', () => {
    const adapter = createCustomAdapter({ defaultBinary: 'runner', argsTemplate: ['--prompt', '{prompt}', '--mode', 'jsonl'], outputFormat: 'jsonl' });
    const args = adapter.buildArgs({ prompt: 'extract now' });
    assert.deepStrictEqual(args, ['--prompt', 'extract now', '--mode', 'jsonl']);
  });

  it('parses declared text output mode', () => {
    const adapter = createCustomAdapter({ argsTemplate: ['{prompt}'], outputFormat: 'text' });
    const parsed = adapter.parseOutput(' plain answer \n', '', {});
    assert.strictEqual(parsed.response, 'plain answer');
    assert.deepStrictEqual(parsed.events, []);
  });

  it('rejects unsupported tool controls', () => {
    const adapter = createCustomAdapter({ argsTemplate: ['{prompt}'], outputFormat: 'text' });
    assert.throws(() => adapter.buildArgs({ prompt: 'x', allowTools: ['shell(git)'] }), /allowTools/);
    assert.throws(() => adapter.buildArgs({ prompt: 'x', denyTools: ['shell(rm -rf /)'] }), /denyTools/);
    assert.throws(() => adapter.buildArgs({ prompt: 'x', allowAllTools: true }), /allowAllTools/);
    assert.throws(() => adapter.buildArgs({ prompt: 'x', allowAll: true }), /allowAll/);
  });
});

describe('runRuntimeTask', () => {
  it('executes non-copilot adapter with shared spawn/parse machinery', async () => {
    const adapter = createCustomAdapter({ defaultBinary: 'custom', argsTemplate: ['{prompt}'], outputFormat: 'jsonl' });
    const spawn = fakeSpawn({ stdout: '{"type":"assistant","text":"ok"}\n', code: 0 });
    const res = await runRuntimeTask({ adapter, prompt: 'go', spawn, binary: 'custom-bin' });
    assert.strictEqual(res.adapter, 'custom');
    assert.strictEqual(res.response, 'ok');
    assert.strictEqual(res.ok, true);
  });

  it('surfaces ENOENT with stable error code', async () => {
    const adapter = createClaudeAdapter();
    const spawn = fakeSpawn({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
    await assert.rejects(
      runRuntimeTask({ adapter, prompt: 'x', spawn }),
      (e) => e instanceof RuntimeAdapterError && e.code === RuntimeErrorCode.BINARY_MISSING,
    );
  });

  it('uses adapter-specific binary env precedence', async () => {
    const env = {
      [COPILOT_BIN_ENV]: '/bin/copilot-only',
      [CLAUDE_BIN_ENV]: '/bin/claude-specific',
      KB_CUSTOM_BIN: '/bin/custom-specific',
    };

    const copilotSpawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({ adapter: createCopilotAdapter(), prompt: 'x', env, spawn: copilotSpawn });
    assert.strictEqual(copilotSpawn.calls[0].binary, '/bin/copilot-only');

    const claudeSpawn = fakeSpawn({ stdout: '{"type":"result","result":"ok"}', code: 0 });
    await runRuntimeTask({ adapter: createClaudeAdapter(), prompt: 'x', env, spawn: claudeSpawn });
    assert.strictEqual(claudeSpawn.calls[0].binary, '/bin/claude-specific');

    const customAdapter = createCustomAdapter({ defaultBinary: 'custom', binaryEnv: 'KB_CUSTOM_BIN' });
    const customSpawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({ adapter: customAdapter, prompt: 'x', env, spawn: customSpawn });
    assert.strictEqual(customSpawn.calls[0].binary, '/bin/custom-specific');
  });

  it('times out through shared runtime path', async () => {
    const adapter = createCustomAdapter({ defaultBinary: 'custom', argsTemplate: ['{prompt}'] });
    await assert.rejects(
      runRuntimeTask({ adapter, prompt: 'wait', spawn: hangingSpawn, timeoutMs: 25 }),
      (e) => e instanceof RuntimeAdapterError && e.code === RuntimeErrorCode.TIMEOUT,
    );
  });

  it('rejects unsupported options via adapter capabilities', async () => {
    const adapter = createCustomAdapter({ defaultBinary: 'custom', argsTemplate: ['{prompt}'] });
    assert.throws(
      () => runRuntimeTask({ adapter, prompt: 'x', allowTools: ['shell(git)'] }),
      (e) => e instanceof RuntimeAdapterError && e.code === RuntimeErrorCode.INVALID_INPUT,
    );
  });
});
