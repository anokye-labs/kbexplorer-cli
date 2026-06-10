import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const generateMod = await import('../../src/commands/generate.js');
const generate = generateMod.default;
const { defaultArchitectPrompt, buildArchitectRuntimeOptions } = generateMod;

function captureConsole() {
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  console.warn = (...a) => out.push(a.join(' '));
  return {
    out,
    restore() {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    },
  };
}

describe('generate command', () => {
  it('exports a default function and helpers', () => {
    assert.strictEqual(typeof generate, 'function');
    assert.strictEqual(typeof defaultArchitectPrompt, 'function');
    assert.strictEqual(typeof buildArchitectRuntimeOptions, 'function');
  });

  it('--dry-run prints the assembled copilot -p command without running', async () => {
    const cap = captureConsole();
    try {
      await generate(['--dry-run']);
    } finally {
      cap.restore();
    }
    const text = cap.out.join('\n');
    assert.match(text, /Dry run/);
    assert.match(text, /copilot -p/);
    assert.match(text, /--allow-all-tools/);
  });

  it('--dry-run honours a custom prompt and scoped tools', async () => {
    const cap = captureConsole();
    try {
      await generate(['--dry-run', '--prompt', 'CUSTOM PROMPT', '--allow-tool', 'shell(git)']);
    } finally {
      cap.restore();
    }
    const text = cap.out.join('\n');
    assert.match(text, /CUSTOM PROMPT/);
    assert.match(text, /--allow-tool=shell\(git\)/);
    // scoped tools opt out of implicit allow-all-tools
    assert.doesNotMatch(text, /--allow-all-tools/);
  });

  it('--help prints usage and does not run anything', async () => {
    const cap = captureConsole();
    try {
      await generate(['--help']);
    } finally {
      cap.restore();
    }
    assert.match(cap.out.join('\n'), /kbexplorer generate/);
  });
});

describe('buildArchitectRuntimeOptions', () => {
  it('defaults to allow-all-tools with the default prompt', () => {
    const o = buildArchitectRuntimeOptions({ allowTools: [], allowAllTools: null }, '/repo');
    assert.strictEqual(o.allowAllTools, true);
    assert.deepStrictEqual(o.allowTools, []);
    assert.strictEqual(o.prompt, defaultArchitectPrompt());
    assert.strictEqual(o.cwd, '/repo');
    assert.strictEqual(o.silent, true);
  });

  it('scoped allow-tool disables implicit allow-all-tools', () => {
    const o = buildArchitectRuntimeOptions({ allowTools: ['shell(git)'], allowAllTools: null }, '/repo');
    assert.strictEqual(o.allowAllTools, false);
    assert.deepStrictEqual(o.allowTools, ['shell(git)']);
  });

  it('passes through prompt, model and timeout overrides', () => {
    const o = buildArchitectRuntimeOptions(
      { prompt: 'P', model: 'm', timeout: 1234, allowTools: [], allowAllTools: null },
      '/r',
    );
    assert.strictEqual(o.prompt, 'P');
    assert.strictEqual(o.model, 'm');
    assert.strictEqual(o.timeoutMs, 1234);
  });
});
