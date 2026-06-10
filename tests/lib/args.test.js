import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseInitArgs, parseUpdateArgs, parseGenerateArgs } = await import('../../src/lib/args.js');

describe('parseInitArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseInitArgs([]), {
      template: null, ref: null, vendor: false, help: false, unknown: [],
    });
  });

  it('parses --template and -t', () => {
    assert.strictEqual(parseInitArgs(['--template', 'https://x/y.git']).template, 'https://x/y.git');
    assert.strictEqual(parseInitArgs(['-t', 'https://x/y.git']).template, 'https://x/y.git');
  });

  it('parses --ref and --branch into ref', () => {
    assert.strictEqual(parseInitArgs(['--ref', 'v1.2.3']).ref, 'v1.2.3');
    assert.strictEqual(parseInitArgs(['--branch', 'main']).ref, 'main');
  });

  it('parses --vendor and --no-submodule as vendor', () => {
    assert.strictEqual(parseInitArgs(['--vendor']).vendor, true);
    assert.strictEqual(parseInitArgs(['--no-submodule']).vendor, true);
  });

  it('parses --help', () => {
    assert.strictEqual(parseInitArgs(['--help']).help, true);
    assert.strictEqual(parseInitArgs(['-h']).help, true);
  });

  it('handles combined flags', () => {
    const out = parseInitArgs(['--template', 'u', '--vendor', '--ref', 'main']);
    assert.strictEqual(out.template, 'u');
    assert.strictEqual(out.vendor, true);
    assert.strictEqual(out.ref, 'main');
  });

  it('collects unknown args', () => {
    assert.deepStrictEqual(parseInitArgs(['--bogus']).unknown, ['--bogus']);
  });

  it('does not consume a following flag as a value', () => {
    const out = parseInitArgs(['--template']);
    assert.strictEqual(out.template, null);
  });
});

describe('parseUpdateArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseUpdateArgs([]), { force: false, help: false, unknown: [] });
  });

  it('parses --force and -f', () => {
    assert.strictEqual(parseUpdateArgs(['--force']).force, true);
    assert.strictEqual(parseUpdateArgs(['-f']).force, true);
  });

  it('parses --help', () => {
    assert.strictEqual(parseUpdateArgs(['--help']).help, true);
  });

  it('collects unknown args', () => {
    assert.deepStrictEqual(parseUpdateArgs(['--nope']).unknown, ['--nope']);
  });
});

describe('parseGenerateArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseGenerateArgs([]), {
      prompt: null,
      model: null,
      allowTools: [],
      allowAllTools: null,
      timeout: null,
      noAgent: false,
      refresh: false,
      dryRun: false,
      help: false,
      unknown: [],
    });
  });

  it('parses --prompt/-p and --model', () => {
    assert.strictEqual(parseGenerateArgs(['--prompt', 'do x']).prompt, 'do x');
    assert.strictEqual(parseGenerateArgs(['-p', 'do y']).prompt, 'do y');
    assert.strictEqual(parseGenerateArgs(['--model', 'gpt-5.2']).model, 'gpt-5.2');
  });

  it('collects repeatable --allow-tool specs', () => {
    const out = parseGenerateArgs(['--allow-tool', 'shell(git)', '--allow-tool', 'write']);
    assert.deepStrictEqual(out.allowTools, ['shell(git)', 'write']);
  });

  it('parses --allow-all-tools, --no-agent, --refresh/--force, --dry-run', () => {
    assert.strictEqual(parseGenerateArgs(['--allow-all-tools']).allowAllTools, true);
    assert.strictEqual(parseGenerateArgs(['--no-agent']).noAgent, true);
    assert.strictEqual(parseGenerateArgs(['--refresh']).refresh, true);
    assert.strictEqual(parseGenerateArgs(['--force']).refresh, true);
    assert.strictEqual(parseGenerateArgs(['--dry-run']).dryRun, true);
  });

  it('parses a numeric --timeout', () => {
    assert.strictEqual(parseGenerateArgs(['--timeout', '5000']).timeout, 5000);
    assert.strictEqual(parseGenerateArgs(['--timeout', 'nope']).timeout, null);
  });

  it('collects unknown args', () => {
    assert.deepStrictEqual(parseGenerateArgs(['--bogus']).unknown, ['--bogus']);
  });
});
