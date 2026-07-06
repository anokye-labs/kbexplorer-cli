import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseInitArgs,
  parseUpdateArgs,
  parseGenerateArgs,
  parseDeriveArgs,
  parseDoctorArgs,
  parseAffectedArgs,
  parseAuditArgs,
  parseBuildArgs,
  parseConnectArgs,
  parseDevArgs,
  parseLinksArgs,
  parseManifestArgs,
  parseMcpArgs,
  parsePluginArgs,
  parseScaffoldArgs,
  parseSearchIndexArgs,
  parseSearchArgs,
  parseSyncArgs,
  parseValidateArgs,
} = await import('../../src/lib/args.ts');

describe('parseInitArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseInitArgs([]), {
      template: null,
      ref: null,
      vendor: false,
      help: false,
      yes: false,
      owner: null,
      repo: null,
      kbBranch: null,
      title: null,
      mode: null,
      contentMode: null,
      content: null,
      visual: null,
      theme: null,
      runtime: null,
      runtimeCommand: null,
      runtimeArgs: null,
      runtimeOutput: null,
      config: null,
      unknown: [],
    });
  });

  it('parses non-interactive flags', () => {
    const out = parseInitArgs([
      '--yes', '--owner', 'acme', '--repo', 'widgets', '--kb-branch', 'main',
      '--title', 'Acme KB', '--mode', 'vendor', '--content-mode', 'authored',
      '--content', 'docs', '--visual', 'sprites', '--theme', 'light',
      '--runtime', 'claude', '--config', 'kb.json',
    ]);
    assert.strictEqual(out.yes, true);
    assert.strictEqual(out.owner, 'acme');
    assert.strictEqual(out.repo, 'widgets');
    assert.strictEqual(out.kbBranch, 'main');
    assert.strictEqual(out.title, 'Acme KB');
    assert.strictEqual(out.mode, 'vendor');
    assert.strictEqual(out.vendor, true); // --mode vendor implies vendor
    assert.strictEqual(out.contentMode, 'authored');
    assert.strictEqual(out.content, 'docs');
    assert.strictEqual(out.visual, 'sprites');
    assert.strictEqual(out.theme, 'light');
    assert.strictEqual(out.runtime, 'claude');
    assert.strictEqual(out.config, 'kb.json');
  });

  it('keeps --kb-branch separate from the --branch/--ref alias', () => {
    const out = parseInitArgs(['--branch', 'v2', '--kb-branch', 'release']);
    assert.strictEqual(out.ref, 'v2');
    assert.strictEqual(out.kbBranch, 'release');
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

describe('parseDoctorArgs', () => {
  it('returns defaults for no args', () => {
    assert.deepStrictEqual(parseDoctorArgs([]), {
      runtime: null, json: false, offline: false, help: false, unknown: [],
    });
  });

  it('parses --runtime', () => {
    assert.strictEqual(parseDoctorArgs(['--runtime', 'claude']).runtime, 'claude');
    assert.strictEqual(parseDoctorArgs(['--runtime', 'copilot']).runtime, 'copilot');
  });

  it('parses --json', () => {
    assert.strictEqual(parseDoctorArgs(['--json']).json, true);
    assert.strictEqual(parseDoctorArgs([]).json, false);
  });

  it('parses --offline', () => {
    assert.strictEqual(parseDoctorArgs(['--offline']).offline, true);
    assert.strictEqual(parseDoctorArgs([]).offline, false);
  });

  it('parses --help / -h', () => {
    assert.strictEqual(parseDoctorArgs(['--help']).help, true);
    assert.strictEqual(parseDoctorArgs(['-h']).help, true);
  });

  it('collects unknown flags', () => {
    assert.deepStrictEqual(parseDoctorArgs(['--bogus']).unknown, ['--bogus']);
  });

  it('combines multiple flags', () => {
    const opts = parseDoctorArgs(['--runtime', 'claude', '--json', '--offline']);
    assert.strictEqual(opts.runtime, 'claude');
    assert.strictEqual(opts.json, true);
    assert.strictEqual(opts.offline, true);
  });
});

describe('parseAffectedArgs', () => {
  it('uses positional ref and defaults', () => {
    const out = parseAffectedArgs(['feature', '--content', 'README.md']);
    assert.strictEqual(out.ref, 'feature');
    assert.strictEqual(out.content, 'README.md');
    assert.strictEqual(out.json, false);
  });
});

describe('parseAuditArgs', () => {
  it('parses json and content flags', () => {
    const out = parseAuditArgs(['--json', '--content', 'docs']);
    assert.strictEqual(out.json, true);
    assert.strictEqual(out.content, 'docs');
  });
});

describe('parseBuildArgs', () => {
  it('parses base', () => {
    assert.strictEqual(parseBuildArgs(['--base', 'main']).base, 'main');
  });
});

describe('parseConnectArgs', () => {
  it('ignores bare positionals and only tracks dashed unknowns', () => {
    const out = parseConnectArgs(['--check', 'ignored', '--bogus']);
    assert.strictEqual(out.check, true);
    assert.deepStrictEqual(out.unknown, ['--bogus']);
  });
});

describe('parseDevArgs', () => {
  it('forwards passthrough vite args while stripping --no-watch', () => {
    const out = parseDevArgs(['--host', '0.0.0.0', '--port', '5173', '--no-watch']);
    assert.strictEqual(out.noWatch, true);
    assert.deepStrictEqual(out.viteArgs, ['--host', '0.0.0.0', '--port', '5173']);
  });
});

describe('parseLinksArgs', () => {
  it('parses json', () => {
    assert.strictEqual(parseLinksArgs(['--json']).json, true);
  });
});

describe('parseManifestArgs', () => {
  it('returns empty defaults', () => {
    assert.deepStrictEqual(parseManifestArgs([]), { check: false, help: false, unknown: [] });
  });

  it('parses --check and --help', () => {
    assert.strictEqual(parseManifestArgs(['--check']).check, true);
    assert.strictEqual(parseManifestArgs(['--help']).help, true);
    assert.strictEqual(parseManifestArgs(['-h']).help, true);
  });

  it('parses --repo and --repo=slug', () => {
    assert.strictEqual(parseManifestArgs(['--repo', 'anokye-labs/kbexplorer-template']).repo, 'anokye-labs/kbexplorer-template');
    assert.strictEqual(parseManifestArgs(['--repo=anokye-labs/kbexplorer-template']).repo, 'anokye-labs/kbexplorer-template');
  });

  it('parses --branch and --branch=dev', () => {
    assert.strictEqual(parseManifestArgs(['--branch', 'dev']).branch, 'dev');
    assert.strictEqual(parseManifestArgs(['--branch=dev']).branch, 'dev');
  });

  it('leaves repo undefined when --repo is missing a value', () => {
    const out = parseManifestArgs(['--repo']);
    assert.strictEqual(out.repo, undefined);
    assert.deepStrictEqual(out.unknown, []);
  });

  it('collects unknown flags', () => {
    assert.deepStrictEqual(parseManifestArgs(['--bogus']).unknown, ['--bogus']);
  });
});

describe('parseMcpArgs', () => {
  it('parses flags and normalizes name', () => {
    const out = parseMcpArgs(['--name', 'demo', '--skip-preflight']);
    assert.strictEqual(out.name, 'demo');
    assert.strictEqual(out.skipPreflight, true);
  });
});

describe('parsePluginArgs', () => {
  it('parses positional subcommand and value options', () => {
    const out = parsePluginArgs(['install', '--scope', 'user', '--session-dir', 'tmp']);
    assert.strictEqual(out.sub, 'install');
    assert.deepStrictEqual(out._, []);
    assert.strictEqual(out.scope, 'user');
    assert.strictEqual(out.sessionDir, 'tmp');
  });

  it('supports =-form values', () => {
    assert.strictEqual(parsePluginArgs(['install', '--scope=user']).scope, 'user');
  });
});

describe('parseScaffoldArgs', () => {
  it('uses first positional as slug and parses options', () => {
    const out = parseScaffoldArgs(['page', '--title', 'My page']);
    assert.strictEqual(out.slug, 'page');
    assert.strictEqual(out.title, 'My page');
  });
});

describe('parseSearchIndexArgs', () => {
  it('parses numeric batch size', () => {
    assert.strictEqual(parseSearchIndexArgs(['--batch-size', '4']).batchSize, 4);
    assert.strictEqual(parseSearchIndexArgs(['--batch-size', 'abc']).batchSize, null);
  });
});

describe('parseSearchArgs', () => {
  it('parses numeric limit and positional query', () => {
    const out = parseSearchArgs(['--limit', '10', 'hello world']);
    assert.strictEqual(out.limit, 10);
    assert.strictEqual(out.query, 'hello world');
  });
});

describe('parseSyncArgs', () => {
  it('parses graph and against values', () => {
    const out = parseSyncArgs(['--graph', 'graph.json', '--against', 'main']);
    assert.strictEqual(out.graph, 'graph.json');
    assert.strictEqual(out.against, 'main');
  });
});

describe('parseValidateArgs', () => {
  it('parses dir alias forms', () => {
    assert.strictEqual(parseValidateArgs(['--content-model', 'docs']).dir, 'docs');
    assert.strictEqual(parseValidateArgs(['--dir', 'src']).dir, 'src');
  });
});
