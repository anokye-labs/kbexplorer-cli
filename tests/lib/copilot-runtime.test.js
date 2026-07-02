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
  runRuntimeTask,
  copilotAdapter,
  quoteCmdArg,
  resolveSpawnPlan,
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

// ── Issue #66: shell:false can't exec .cmd/.bat shims (EINVAL) or a bare
// .mjs/.js target (EFTYPE) on Windows. `resolveSpawnPlan` is the pure
// dispatch decision behind runRuntimeTask's spawn call — test the decision
// itself (platform/execPath are injectable) rather than requiring Windows. ──
describe('resolveSpawnPlan (dispatch decision, no real spawn)', () => {
  it('leaves a plain binary untouched on win32', () => {
    const plan = resolveSpawnPlan('copilot.exe', ['-p', 'hi'], { platform: 'win32' });
    assert.deepStrictEqual(plan, { command: 'copilot.exe', args: ['-p', 'hi'], shell: false });
  });

  it('leaves everything untouched on non-Windows platforms, including .cmd/.bat/.mjs', () => {
    for (const binary of ['agent.cmd', 'agent.bat', 'agent.mjs', 'agent.js', 'agent']) {
      const plan = resolveSpawnPlan(binary, ['x'], { platform: 'linux' });
      assert.deepStrictEqual(plan, { command: binary, args: ['x'], shell: false });
    }
  });

  it('routes .cmd through the shell on win32 with quoted args', () => {
    const plan = resolveSpawnPlan('C:\\tools\\agent.cmd', ['--flag', 'a value', 'plain'], { platform: 'win32' });
    assert.strictEqual(plan.shell, true);
    assert.strictEqual(plan.command, 'C:\\tools\\agent.cmd');
    assert.deepStrictEqual(plan.args, ['--flag', '"a value"', 'plain']);
  });

  it('routes .bat through the shell on win32 (case-insensitive extension)', () => {
    const plan = resolveSpawnPlan('AGENT.BAT', ['x'], { platform: 'win32' });
    assert.strictEqual(plan.shell, true);
    assert.strictEqual(plan.command, 'AGENT.BAT');
  });

  it('quotes a binary path containing spaces for the shell', () => {
    const plan = resolveSpawnPlan('C:\\Program Files\\tools\\agent.cmd', [], { platform: 'win32' });
    assert.strictEqual(plan.command, '"C:\\Program Files\\tools\\agent.cmd"');
  });

  it('wraps .mjs targets with the injected execPath on win32', () => {
    const plan = resolveSpawnPlan('C:\\tools\\agent.mjs', ['--flag'], {
      platform: 'win32',
      execPath: 'C:\\node.exe',
    });
    assert.deepStrictEqual(plan, {
      command: 'C:\\node.exe',
      args: ['C:\\tools\\agent.mjs', '--flag'],
      shell: false,
    });
  });

  it('wraps .js targets with the injected execPath on win32', () => {
    const plan = resolveSpawnPlan('C:\\tools\\agent.js', [], { platform: 'win32', execPath: 'C:\\node.exe' });
    assert.strictEqual(plan.command, 'C:\\node.exe');
    assert.deepStrictEqual(plan.args, ['C:\\tools\\agent.js']);
    assert.strictEqual(plan.shell, false);
  });

  it('defaults execPath to process.execPath when not injected', () => {
    const plan = resolveSpawnPlan('agent.mjs', [], { platform: 'win32' });
    assert.strictEqual(plan.command, process.execPath);
  });
});

describe('quoteCmdArg', () => {
  it('leaves simple tokens unquoted', () => {
    assert.strictEqual(quoteCmdArg('--flag'), '--flag');
    assert.strictEqual(quoteCmdArg('value'), 'value');
  });

  it('quotes tokens containing whitespace', () => {
    assert.strictEqual(quoteCmdArg('a value'), '"a value"');
  });

  it('quotes and escapes embedded double quotes', () => {
    assert.strictEqual(quoteCmdArg('say "hi"'), '"say ""hi"""');
  });

  it('neutralizes command/redirection/grouping metacharacters by wrapping (cmd treats them literally inside "…")', () => {
    // Exact transforms — not just "is quote-wrapped". Inside double quotes cmd
    // does NOT interpret & | < > ( ) ^, so wrapping is a genuine neutralization.
    assert.strictEqual(quoteCmdArg('a&b'), '"a&b"');
    assert.strictEqual(quoteCmdArg('a|b'), '"a|b"');
    assert.strictEqual(quoteCmdArg('a^b'), '"a^b"');
    assert.strictEqual(quoteCmdArg('a<b'), '"a<b"');
    assert.strictEqual(quoteCmdArg('a>b'), '"a>b"');
    assert.strictEqual(quoteCmdArg('a(b)'), '"a(b)"');
  });

  it('caret-escapes %VAR% out of the quotes (CVE-2024-27980: cmd expands %..% inside quotes)', () => {
    // `%COMSPEC%` must be broken up so cmd cannot substitute the environment
    // variable; each `%` is pulled out of the quoted segments and caret-escaped.
    assert.strictEqual(quoteCmdArg('a%COMSPEC%b'), '"a"^%"COMSPEC"^%"b"');
    assert.strictEqual(quoteCmdArg('a%b%'), '"a"^%"b"^%');
  });

  it('caret-escapes ! out of the quotes (delayed expansion escapes double quotes)', () => {
    assert.strictEqual(quoteCmdArg('a!b!'), '"a"^!"b"^!');
  });

  it('embeds a literal double quote via the "" convention', () => {
    assert.strictEqual(quoteCmdArg('a"b'), '"a""b"');
  });

  it('doubles a trailing backslash before the closing quote so it cannot escape it', () => {
    // A bare trailing backslash needs no wrapping (harmless unquoted)…
    assert.strictEqual(quoteCmdArg('a\\'), 'a\\');
    // …but once the token is quoted (whitespace present), the run before the
    // closing quote is doubled: `"a b\\"` → CommandLineToArgvW → one `\`, arg closes.
    assert.strictEqual(quoteCmdArg('a b\\'), '"a b\\\\"');
    assert.strictEqual(quoteCmdArg('a b\\\\'), '"a b\\\\\\\\"');
  });

  it('represents an empty token as an explicit empty quoted string', () => {
    assert.strictEqual(quoteCmdArg(''), '""');
  });
});

describe('runRuntimeTask spawn dispatch (win32 simulation via injected platform)', () => {
  it('spawns a plain binary unchanged on win32', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({ adapter: copilotAdapter, prompt: 'hi', binary: 'copilot.exe', platform: 'win32', spawn });
    const call = spawn.calls[0];
    assert.strictEqual(call.binary, 'copilot.exe');
    assert.strictEqual(call.options.shell, false);
  });

  it('re-invokes a .cmd binary through the shell with quoted args on win32', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({
      adapter: copilotAdapter,
      prompt: 'a prompt with spaces',
      binary: 'C:\\tools\\agent.cmd',
      platform: 'win32',
      spawn,
    });
    const call = spawn.calls[0];
    assert.strictEqual(call.binary, 'C:\\tools\\agent.cmd');
    assert.strictEqual(call.options.shell, true);
    assert.ok(call.args.includes('"-p a prompt with spaces"') || call.args.some((a) => a.includes('a prompt with spaces')));
  });

  it('wraps a .mjs binary with process.execPath on win32', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({
      adapter: copilotAdapter,
      prompt: 'hi',
      binary: 'C:\\tools\\agent.mjs',
      platform: 'win32',
      spawn,
    });
    const call = spawn.calls[0];
    assert.strictEqual(call.binary, process.execPath);
    assert.strictEqual(call.args[0], 'C:\\tools\\agent.mjs');
    assert.strictEqual(call.options.shell, false);
  });

  it('leaves .cmd/.mjs binaries unchanged on non-Windows platforms', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    await runRuntimeTask({
      adapter: copilotAdapter,
      prompt: 'hi',
      binary: '/usr/local/bin/agent.cmd',
      platform: 'linux',
      spawn,
    });
    const call = spawn.calls[0];
    assert.strictEqual(call.binary, '/usr/local/bin/agent.cmd');
    assert.strictEqual(call.options.shell, false);
  });

  it('preserves the display command/result binary as the logical (unwrapped) binary', async () => {
    const spawn = fakeSpawn({ stdout: 'ok', code: 0 });
    const res = await runRuntimeTask({
      adapter: copilotAdapter,
      prompt: 'hi',
      binary: 'C:\\tools\\agent.mjs',
      platform: 'win32',
      spawn,
    });
    // result.binary/command should still describe the logical target, not the
    // node-wrapped spawn invocation — this is what callers log/display.
    assert.strictEqual(res.binary, 'C:\\tools\\agent.mjs');
    assert.match(res.command, /agent\.mjs/);
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
