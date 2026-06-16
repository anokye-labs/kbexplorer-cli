import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const {
  DEFAULT_COPILOT_BINARY,
  COPILOT_BIN_ENV,
  CLAUDE_BIN_ENV,
  RuntimeErrorCode,
  CopilotRuntimeError,
  resolveBinary,
  buildCopilotArgs,
  isCopilotAvailable,
  parseJsonl,
  extractResponseText,
  runCopilot,
} = await import('../../src/lib/copilot-runtime.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, '..', 'fixtures', 'mock-copilot.mjs');

// ── A fake child_process.spawn for fully hermetic unit tests. ──
function fakeSpawn({ stdout = '', stderr = '', code = 0, signal = null, error = null } = {}) {
  const calls = [];
  const fn = (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    let stdinEnded = false;
    child.stdin = { end: () => { stdinEnded = true; }, get ended() { return stdinEnded; } };
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

describe('resolveBinary', () => {
  it('defaults to the copilot binary name', () => {
    assert.strictEqual(resolveBinary({ env: {} }), DEFAULT_COPILOT_BINARY);
  });
  it('prefers an explicit binary', () => {
    assert.strictEqual(resolveBinary({ binary: '/opt/copilot', env: {} }), '/opt/copilot');
  });
  it('honours the env override', () => {
    assert.strictEqual(resolveBinary({ env: { [COPILOT_BIN_ENV]: '/x/cop' }, envVar: COPILOT_BIN_ENV }), '/x/cop');
  });
  it('honours only the requested env var', () => {
    assert.strictEqual(
      resolveBinary({
        env: { [COPILOT_BIN_ENV]: '/x/cop', [CLAUDE_BIN_ENV]: '/x/claude' },
        envVar: CLAUDE_BIN_ENV,
        defaultBinary: 'claude',
      }),
      '/x/claude',
    );
  });
});

describe('buildCopilotArgs', () => {
  it('assembles a minimal prompt invocation', () => {
    assert.deepStrictEqual(buildCopilotArgs({ prompt: 'hi', noColor: false }), ['-p', 'hi']);
  });

  it('scopes tools and assembles flags in a deterministic order', () => {
    const args = buildCopilotArgs({
      prompt: 'do it',
      allowTools: ['shell(git)', 'write'],
      denyTools: ['shell(git push)'],
      model: 'gpt-5.2',
      outputFormat: 'json',
      silent: true,
      addDirs: ['/tmp/a'],
      logLevel: 'info',
      extraArgs: ['--cloud'],
    });
    assert.deepStrictEqual(args, [
      '-p', 'do it',
      '--allow-tool=shell(git)',
      '--allow-tool=write',
      '--deny-tool=shell(git push)',
      '--model', 'gpt-5.2',
      '--output-format', 'json',
      '-s',
      '--no-color',
      '--add-dir', '/tmp/a',
      '--log-level', 'info',
      '--cloud',
    ]);
  });

  it('supports --allow-all-tools and --allow-all', () => {
    const a = buildCopilotArgs({ prompt: 'x', allowAllTools: true, noColor: false });
    assert.ok(a.includes('--allow-all-tools'));
    const b = buildCopilotArgs({ prompt: 'x', allowAll: true, noColor: false });
    assert.ok(b.includes('--allow-all'));
  });

  it('throws CopilotRuntimeError (INVALID_INPUT) without a prompt', () => {
    assert.throws(
      () => buildCopilotArgs({}),
      (e) => e instanceof CopilotRuntimeError && e.code === RuntimeErrorCode.INVALID_INPUT,
    );
  });
});

describe('parseJsonl / extractResponseText', () => {
  it('parses JSONL and skips non-JSON lines', () => {
    const events = parseJsonl('banner line\n{"a":1}\n\n{"b":2}\nnot json');
    assert.deepStrictEqual(events, [{ a: 1 }, { b: 2 }]);
  });

  it('extracts and concatenates assistant text', () => {
    const events = [
      { type: 'status', message: 'go' },
      { type: 'assistant', text: 'Hello ' },
      { type: 'assistant_message', content: 'world' },
    ];
    assert.strictEqual(extractResponseText(events, 'RAW'), 'Hello world');
  });

  it('falls back to raw stdout when no structured text is present', () => {
    assert.strictEqual(extractResponseText([], '  plain text  '), 'plain text');
    assert.strictEqual(extractResponseText([{ type: 'stats' }], 'fallback'), 'fallback');
  });
});

describe('isCopilotAvailable', () => {
  it('is true when the probe runs without a spawn error', () => {
    const spawnSync = () => ({ status: 0, error: null });
    assert.strictEqual(isCopilotAvailable({ spawnSync }), true);
  });
  it('is true even when --version exits non-zero (binary exists)', () => {
    const spawnSync = () => ({ status: 1, error: null });
    assert.strictEqual(isCopilotAvailable({ spawnSync }), true);
  });
  it('is false on ENOENT', () => {
    const spawnSync = () => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
    assert.strictEqual(isCopilotAvailable({ spawnSync }), false);
  });
  it('is false when the probe throws', () => {
    const spawnSync = () => { throw new Error('boom'); };
    assert.strictEqual(isCopilotAvailable({ spawnSync }), false);
  });
});

describe('runCopilot (injected spawn)', () => {
  it('captures stdout and resolves on success', async () => {
    const spawn = fakeSpawn({ stdout: 'all good\n', code: 0 });
    const res = await runCopilot({ prompt: 'hi', spawn, silent: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response, 'all good');
    assert.match(res.command, /-p hi/);
    // assembled argv reached spawn
    assert.deepStrictEqual(spawn.calls[0].args, ['-p', 'hi', '-s', '--no-color']);
  });

  it('keeps backward-compatible copilot argv assembly', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runCopilot({
      prompt: 'do it',
      allowTools: ['shell(git)', 'write'],
      denyTools: ['shell(git push)'],
      outputFormat: 'json',
      model: 'gpt-5.2',
      silent: true,
      addDirs: ['/tmp/a'],
      logLevel: 'info',
      extraArgs: ['--cloud'],
      spawn,
    });
    assert.deepStrictEqual(spawn.calls[0].args, [
      '-p',
      'do it',
      '--allow-tool=shell(git)',
      '--allow-tool=write',
      '--deny-tool=shell(git push)',
      '--model',
      'gpt-5.2',
      '--output-format',
      'json',
      '-s',
      '--no-color',
      '--add-dir',
      '/tmp/a',
      '--log-level',
      'info',
      '--cloud',
    ]);
  });

  it('parses JSONL events and invokes onEvent in json mode', async () => {
    const stdout = '{"type":"assistant","text":"Hi "}\n{"type":"assistant_message","content":"there"}\n';
    const spawn = fakeSpawn({ stdout, code: 0 });
    const seen = [];
    const res = await runCopilot({
      prompt: 'x',
      outputFormat: 'json',
      spawn,
      onEvent: (e) => seen.push(e),
    });
    assert.strictEqual(res.events.length, 2);
    assert.strictEqual(res.response, 'Hi there');
    assert.strictEqual(seen.length, 2);
  });

  it('rejects with BINARY_MISSING on ENOENT', async () => {
    const spawn = fakeSpawn({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    await assert.rejects(
      runCopilot({ prompt: 'hi', spawn }),
      (e) => e instanceof CopilotRuntimeError && e.code === RuntimeErrorCode.BINARY_MISSING,
    );
  });

  it('rejects with NONZERO_EXIT by default on non-zero exit', async () => {
    const spawn = fakeSpawn({ stdout: 'partial', stderr: 'bad', code: 7 });
    await assert.rejects(
      runCopilot({ prompt: 'hi', spawn }),
      (e) =>
        e instanceof CopilotRuntimeError &&
        e.code === RuntimeErrorCode.NONZERO_EXIT &&
        e.exitCode === 7 &&
        e.result.stderr === 'bad',
    );
  });

  it('returns the result (no throw) on non-zero exit when throwOnError is false', async () => {
    const spawn = fakeSpawn({ stderr: 'bad', code: 3 });
    const res = await runCopilot({ prompt: 'hi', spawn, throwOnError: false });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.exitCode, 3);
  });
});

describe('runCopilot (real process via mock binary)', () => {
  const base = { binary: process.execPath, binaryArgs: [MOCK] };

  it('runs end-to-end and captures the response (text mode)', async () => {
    const res = await runCopilot({
      ...base,
      prompt: 'analyze',
      silent: true,
      env: { ...process.env, MOCK_COPILOT_MODE: 'text', MOCK_COPILOT_STDOUT: 'real-ish output' },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response, 'real-ish output');
  });

  it('parses JSONL from a real child process (json mode)', async () => {
    const res = await runCopilot({
      ...base,
      prompt: 'analyze',
      outputFormat: 'json',
      env: { ...process.env, MOCK_COPILOT_MODE: 'json' },
    });
    assert.ok(res.events.length >= 2);
    assert.strictEqual(res.response, 'Hello from the mock.');
  });

  it('surfaces a non-zero exit from a real child process', async () => {
    await assert.rejects(
      runCopilot({
        ...base,
        prompt: 'analyze',
        env: { ...process.env, MOCK_COPILOT_MODE: 'fail', MOCK_COPILOT_EXIT: '9' },
      }),
      (e) => e instanceof CopilotRuntimeError && e.code === RuntimeErrorCode.NONZERO_EXIT && e.exitCode === 9,
    );
  });

  it('enforces the timeout against a hanging real child process', async () => {
    await assert.rejects(
      runCopilot({
        ...base,
        prompt: 'analyze',
        timeoutMs: 300,
        env: { ...process.env, MOCK_COPILOT_MODE: 'hang' },
      }),
      (e) => e instanceof CopilotRuntimeError && e.code === RuntimeErrorCode.TIMEOUT,
    );
  });
});
