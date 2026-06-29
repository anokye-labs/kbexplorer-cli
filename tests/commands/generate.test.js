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
    assert.match(cap.out.join('\n'), /kbx generate/);
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

// ── Regression #39: generate Phase 2b passes VITE_KB_HOST_ROOT ───────────────
// The generate.js source is read here to verify the env var wiring at the
// source level, since an integration test would require a full template install.

describe('generate.js — fix #39: VITE_KB_HOST_ROOT in manifest regeneration', () => {
  it('generate.js Phase 2b passes VITE_KB_HOST_ROOT to the manifest script', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/commands/generate.js'),
      'utf-8',
    );
    // Both the env var and the host root must be present in the regenerate block
    assert.ok(src.includes('VITE_KB_HOST_ROOT: cwd'), 'VITE_KB_HOST_ROOT: cwd must be set in Phase 2b');
    assert.ok(src.includes('VITE_KB_LOCAL'), 'VITE_KB_LOCAL must be set in Phase 2b');
  });

  it('generate.js Phase 2b uses spawnSync (not execSync) so manifest failure is non-fatal', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/commands/generate.js'),
      'utf-8',
    );
    // The Phase 2b regenerate-manifest block must use spawnSync
    // Find the block by anchoring on the task name
    const blockStart = src.indexOf("name: 'regenerate-manifest'");
    assert.ok(blockStart >= 0, 'regenerate-manifest task must exist');
    const block = src.slice(blockStart, blockStart + 800);
    assert.ok(block.includes('spawnSync'), 'Phase 2b must use spawnSync');
    assert.ok(!block.includes('execSync('), 'Phase 2b must NOT use execSync (it throws on failure)');
  });
});

