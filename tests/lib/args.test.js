import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseInitArgs, parseUpdateArgs, parseGenerateArgs, parseDeriveArgs } = await import('../../src/lib/args.js');

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
      runtime: null,
      skipPreflight: false,
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

  it('parses --runtime flag', () => {
    assert.strictEqual(parseGenerateArgs(['--runtime', 'claude']).runtime, 'claude');
    assert.strictEqual(parseGenerateArgs(['--runtime', 'copilot']).runtime, 'copilot');
  });
});

describe('parseDeriveArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseDeriveArgs([]), {
      sources: [],
      out: null,
      context: null,
      check: false,
      refresh: false,
      model: null,
      allowTools: [],
      allowAllTools: null,
      timeout: null,
      dryRun: false,
      runtime: null,
      skipPreflight: false,
      help: false,
      unknown: [],
    });
  });

  it('collects positional sources', () => {
    const out = parseDeriveArgs(['a.docx', 'b.md', '--check']);
    assert.deepStrictEqual(out.sources, ['a.docx', 'b.md']);
    assert.strictEqual(out.check, true);
  });

  it('parses --out / -o', () => {
    assert.strictEqual(parseDeriveArgs(['--out', 'dist/derived']).out, 'dist/derived');
    assert.strictEqual(parseDeriveArgs(['-o', 'other']).out, 'other');
  });

  it('parses --runtime flag', () => {
    assert.strictEqual(parseDeriveArgs(['--runtime', 'claude']).runtime, 'claude');
    assert.strictEqual(parseDeriveArgs(['--runtime', 'copilot']).runtime, 'copilot');
    assert.strictEqual(parseDeriveArgs(['--runtime', 'custom']).runtime, 'custom');
  });

  it('collects unknown flags (not positionals)', () => {
    const out = parseDeriveArgs(['--bogus', 'a.docx']);
    assert.deepStrictEqual(out.unknown, ['--bogus']);
    assert.deepStrictEqual(out.sources, ['a.docx']);
  });

  it('parses --skip-preflight flag', () => {
    assert.strictEqual(parseDeriveArgs(['--skip-preflight']).skipPreflight, true);
    assert.strictEqual(parseDeriveArgs([]).skipPreflight, false);
  });
});

describe('--skip-preflight in parseGenerateArgs', () => {
  it('parses --skip-preflight flag', () => {
    assert.strictEqual(parseGenerateArgs(['--skip-preflight']).skipPreflight, true);
    assert.strictEqual(parseGenerateArgs([]).skipPreflight, false);
  });
});
