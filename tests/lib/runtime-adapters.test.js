import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const {
  createCopilotAdapter,
  createClaudeAdapter,
  createCustomAdapter,
  runRuntimeTask,
  RuntimeAdapterError,
  RuntimeErrorCode,
} = await import('../../src/lib/copilot-runtime.js');

function fakeSpawn({ stdout = '', stderr = '', code = 0, signal = null, error = null } = {}) {
  const fn = () => {
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
  return fn;
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
  it('maps allow tools and enforces stream-json args', () => {
    const adapter = createClaudeAdapter();
    const args = adapter.buildArgs({ prompt: 'audit', allowTools: ['shell(git status)', 'write'] });
    assert.deepStrictEqual(args, ['-p', 'audit', '--output-format', 'stream-json', '--allowedTools', 'Bash(git status),Write']);
  });

  it('parses stream-json assistant output', () => {
    const adapter = createClaudeAdapter();
    const parsed = adapter.parseOutput('{"type":"assistant","content":"Hello Claude"}\n', '', {});
    assert.strictEqual(parsed.response, 'Hello Claude');
    assert.strictEqual(parsed.events.length, 1);
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
});
