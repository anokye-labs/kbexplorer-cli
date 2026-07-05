/**
 * Tests for kbexplorer doctor command.
 *
 * All tests are hermetic: temp dirs for filesystem, injected spawnSync for
 * binary probing, injected getLatestTag for network, injected env for HOME.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const doctorMod = await import('../../src/commands/doctor.ts');
const doctor = doctorMod.default;
const { checkRuntime, checkMcp, checkTemplate, checkAdoption, checkSources, checkEnvironment } = doctorMod;

const { copilotAdapter, claudeAdapter, createCustomAdapter } = await import('../../src/lib/copilot-runtime.ts');
const { parseDoctorArgs } = await import('../../src/lib/args.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-doctor-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, data) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** spawnSync that simulates a binary being available, returning a version line. */
function fakeSpawnAvailable(binary, version = '1.0.0') {
  return (_cmd, _args, _opts) => ({
    status: 0,
    stdout: `${binary} version ${version}`,
    stderr: '',
    error: null,
  });
}

/** spawnSync that simulates binary NOT being found. */
function fakeSpawnMissing() {
  return (_cmd, _args, _opts) => ({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('ENOENT'),
  });
}

/** spawnSync that routes by binary name. */
function fakeSpawnRouter(routes) {
  return (cmd, args, opts) => {
    const handler = routes[cmd];
    if (handler) return handler(cmd, args, opts);
    return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
  };
}

function captureConsole() {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  return {
    lines,
    restore() {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    },
  };
}

// ── parseDoctorArgs ───────────────────────────────────────────────────────────

describe('parseDoctorArgs — defaults', () => {
  it('runtime defaults to null', () => {
    assert.strictEqual(parseDoctorArgs([]).runtime, null);
  });

  it('json defaults to false', () => {
    assert.strictEqual(parseDoctorArgs([]).json, false);
  });

  it('offline defaults to false', () => {
    assert.strictEqual(parseDoctorArgs([]).offline, false);
  });

  it('help defaults to false', () => {
    assert.strictEqual(parseDoctorArgs([]).help, false);
  });

  it('unknown defaults to []', () => {
    assert.deepStrictEqual(parseDoctorArgs([]).unknown, []);
  });
});

describe('parseDoctorArgs — flags', () => {
  it('parses --runtime name', () => {
    const opts = parseDoctorArgs(['--runtime', 'claude']);
    assert.strictEqual(opts.runtime, 'claude');
  });

  it('parses --json', () => {
    assert.strictEqual(parseDoctorArgs(['--json']).json, true);
  });

  it('parses --offline', () => {
    assert.strictEqual(parseDoctorArgs(['--offline']).offline, true);
  });

  it('parses --help / -h', () => {
    assert.strictEqual(parseDoctorArgs(['--help']).help, true);
    assert.strictEqual(parseDoctorArgs(['-h']).help, true);
  });

  it('collects unknown flags', () => {
    const opts = parseDoctorArgs(['--bogus', '--runtime', 'copilot']);
    assert.ok(opts.unknown.includes('--bogus'));
  });

  it('multiple flags', () => {
    const opts = parseDoctorArgs(['--runtime', 'claude', '--json', '--offline']);
    assert.strictEqual(opts.runtime, 'claude');
    assert.strictEqual(opts.json, true);
    assert.strictEqual(opts.offline, true);
  });
});

// ── checkRuntime ──────────────────────────────────────────────────────────────

describe('checkRuntime — default (no config, no env, no flag)', () => {
  it('selects copilot by default', () => {
    const spawnSync = fakeSpawnAvailable('copilot');
    const { checks } = checkRuntime({ flag: null, config: null, env: {}, spawnSync });
    const selected = checks.find((c) => c.id === 'runtime.selected');
    assert.ok(selected, 'runtime.selected check missing');
    assert.strictEqual(selected.status, 'pass');
    assert.match(selected.message, /copilot/);
    assert.match(selected.message, /default/);
  });

  it('emits pass when copilot binary is available', () => {
    const spawnSync = fakeSpawnAvailable('copilot', '2.5.0');
    const { checks } = checkRuntime({ flag: null, config: null, env: {}, spawnSync });
    const avail = checks.find((c) => c.id === 'runtime.available');
    assert.ok(avail, 'runtime.available check missing');
    assert.strictEqual(avail.status, 'pass');
    assert.match(avail.message, /available/i);
  });

  it('emits fail when copilot binary is not available', () => {
    const spawnSync = fakeSpawnMissing();
    const { checks } = checkRuntime({ flag: null, config: null, env: {}, spawnSync });
    const avail = checks.find((c) => c.id === 'runtime.available');
    assert.ok(avail);
    assert.strictEqual(avail.status, 'fail');
    assert.match(avail.message, /not found/i);
  });
});

describe('checkRuntime — env var selection', () => {
  it('selects claude when KBX_RUNTIME=claude', () => {
    const spawnSync = fakeSpawnAvailable('claude');
    const { checks } = checkRuntime({
      flag: null,
      config: null,
      env: { KBX_RUNTIME: 'claude' },
      spawnSync,
    });
    const selected = checks.find((c) => c.id === 'runtime.selected');
    assert.ok(selected);
    assert.match(selected.message, /claude/);
    assert.match(selected.message, /KBX_RUNTIME/);
  });
});

describe('checkRuntime — config block selection', () => {
  it('selects claude when config.agent=claude', () => {
    const spawnSync = fakeSpawnAvailable('claude');
    const { checks } = checkRuntime({
      flag: null,
      config: { agent: 'claude' },
      env: {},
      spawnSync,
    });
    const selected = checks.find((c) => c.id === 'runtime.selected');
    assert.ok(selected);
    assert.match(selected.message, /claude/);
    assert.match(selected.message, /\.kbx\.json/);
  });
});

describe('checkRuntime — flag selection', () => {
  it('--runtime flag wins over config and env', () => {
    const spawnSync = fakeSpawnAvailable('claude');
    const { checks } = checkRuntime({
      flag: 'claude',
      config: { agent: 'copilot' },
      env: { KBX_RUNTIME: 'copilot' },
      spawnSync,
    });
    const selected = checks.find((c) => c.id === 'runtime.selected');
    assert.ok(selected);
    assert.match(selected.message, /--runtime flag/);
    assert.match(selected.message, /claude/);
  });
});

describe('checkRuntime — custom adapter', () => {
  it('warns that custom adapter is not verifiable for MCP', () => {
    const config = {
      agent: 'custom',
      command: 'my-agent',
      argsTemplate: ['{prompt}'],
    };
    const spawnSync = fakeSpawnMissing();
    const { checks } = checkRuntime({ flag: null, config, env: {}, spawnSync });
    const customWarn = checks.find((c) => c.id === 'runtime.custom');
    assert.ok(customWarn, 'runtime.custom check missing');
    assert.strictEqual(customWarn.status, 'warn');
  });

  it('emits warn (not fail) when custom binary missing', () => {
    const config = {
      agent: 'custom',
      command: 'my-agent',
      argsTemplate: ['{prompt}'],
    };
    const spawnSync = fakeSpawnMissing();
    const { checks } = checkRuntime({ flag: null, config, env: {}, spawnSync });
    const avail = checks.find((c) => c.id === 'runtime.available');
    assert.ok(avail);
    assert.strictEqual(avail.status, 'warn');
  });
});

describe('checkRuntime — invalid flag value', () => {
  it('emits fail check when --runtime is an unknown adapter name', () => {
    const spawnSync = fakeSpawnMissing();
    const { checks } = checkRuntime({ flag: 'bogus', config: null, env: {}, spawnSync });
    const failCheck = checks.find((c) => c.status === 'fail');
    assert.ok(failCheck, 'expected a fail check');
    assert.match(failCheck.message, /bogus|unknown|Failed/i);
  });
});

// ── checkMcp ──────────────────────────────────────────────────────────────────

describe('checkMcp — no mcp declared', () => {
  it('returns a pass when no mcp block in config', () => {
    const checks = checkMcp({ adapter: copilotAdapter, config: null, cwd: tmpdir(), env: {} });
    const declared = checks.find((c) => c.id === 'mcp.declared');
    assert.ok(declared);
    assert.strictEqual(declared.status, 'pass');
    assert.match(declared.message, /No MCP/i);
  });

  it('returns a pass when mcp block has no servers', () => {
    const checks = checkMcp({
      adapter: copilotAdapter,
      config: { agent: 'copilot', mcp: {} },
      cwd: tmpdir(),
      env: {},
    });
    const declared = checks.find((c) => c.id === 'mcp.declared');
    assert.ok(declared);
    assert.strictEqual(declared.status, 'pass');
  });
});

describe('checkMcp — copilot adapter with configured server', () => {
  it('emits pass when required server is in ~/.copilot/mcp-config.json', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(home, '.copilot', 'mcp-config.json'), {
          mcpServers: { ado: { command: 'npx', args: [] } },
        });
        const checks = checkMcp({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        const aCheck = checks.find((c) => c.id === 'mcp.required.ado');
        assert.ok(aCheck);
        assert.strictEqual(aCheck.status, 'pass');
      });
    });
  });

  it('emits fail when required server is missing', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const checks = checkMcp({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        const aCheck = checks.find((c) => c.id === 'mcp.required.ado');
        assert.ok(aCheck);
        assert.strictEqual(aCheck.status, 'fail');
      });
    });
  });

  it('emits warn when optional server is missing', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        const checks = checkMcp({
          adapter: copilotAdapter,
          config: { agent: 'copilot', mcp: { optional: ['org-chart'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        const aCheck = checks.find((c) => c.id === 'mcp.optional.org-chart');
        assert.ok(aCheck);
        assert.strictEqual(aCheck.status, 'warn');
      });
    });
  });
});

describe('checkMcp — claude adapter', () => {
  it('emits pass when required server is in .mcp.json', () => {
    withTempDir((cwd) => {
      withTempDir((home) => {
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { ado: { command: 'npx', args: [] } },
        });
        const checks = checkMcp({
          adapter: claudeAdapter,
          config: { agent: 'claude', mcp: { required: ['ado'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        const aCheck = checks.find((c) => c.id === 'mcp.required.ado');
        assert.ok(aCheck);
        assert.strictEqual(aCheck.status, 'pass');
      });
    });
  });
});

describe('checkMcp — custom adapter', () => {
  it('emits warn (not fail) for all declared servers', () => {
    const customAdapter = createCustomAdapter({
      name: 'custom',
      defaultBinary: 'my-agent',
      argsTemplate: ['{prompt}'],
    });
    withTempDir((cwd) => {
      withTempDir((home) => {
        const checks = checkMcp({
          adapter: customAdapter,
          config: { agent: 'custom', mcp: { required: ['ado'], optional: ['org-chart'] } },
          cwd,
          env: { HOME: home, USERPROFILE: home },
        });
        const serverChecks = checks.filter((c) => c.id !== 'mcp.server');
        for (const c of serverChecks) {
          assert.strictEqual(c.status, 'warn', `Expected warn for ${c.id}, got ${c.status}`);
        }
        assert.strictEqual(serverChecks.length, 2);
        // The provider-readiness advisory is present and passes independently.
        assert.strictEqual(checks.find((c) => c.id === 'mcp.server').status, 'pass');
      });
    });
  });
});

describe('checkMcp — adapter is null (runtime failed)', () => {
  it('emits a warn (skipped) check', () => {
    const checks = checkMcp({
      adapter: null,
      config: { agent: 'copilot', mcp: { required: ['ado'] } },
      cwd: tmpdir(),
      env: {},
    });
    assert.ok(checks.some((c) => c.status === 'warn'));
  });
});

// ── checkTemplate ─────────────────────────────────────────────────────────────

describe('checkTemplate — no .kbx.json', () => {
  it('emits warn when source record is absent', () => {
    withTempDir((cwd) => {
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      assert.ok(checks.some((c) => c.status === 'warn' && c.id === 'template.source-record'));
    });
  });
});

describe('checkTemplate — invalid .kbx.json', () => {
  it('emits fail when file is not parseable JSON', () => {
    withTempDir((cwd) => {
      writeFileSync(join(cwd, '.kbx.json'), 'NOT JSON!!!', 'utf-8');
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      assert.ok(checks.some((c) => c.status === 'fail' && c.id === 'template.source-record'));
    });
  });
});

describe('checkTemplate — valid source record, submodule mode', () => {
  it('passes source-record check', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'v1.0.0',
        refType: 'tag',
        resolvedCommit: null,
        mode: 'submodule',
      });
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const srCheck = checks.find((c) => c.id === 'template.source-record');
      assert.ok(srCheck);
      assert.strictEqual(srCheck.status, 'pass');
    });
  });

  it('warns when .gitmodules is absent for submodule mode', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: null,
        refType: 'release',
        mode: 'submodule',
      });
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const gmCheck = checks.find((c) => c.id === 'template.gitmodules');
      assert.ok(gmCheck, 'template.gitmodules check missing');
      assert.strictEqual(gmCheck.status, 'warn');
    });
  });

  it('warns when .gitmodules url differs from source record', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: null,
        refType: 'release',
        mode: 'submodule',
      });
      // Write a .gitmodules with a different URL
      const gitmodules = `[submodule ".kbx"]\n\tpath = .kbx\n\turl = https://github.com/other-org/other-template.git\n`;
      writeFileSync(join(cwd, '.gitmodules'), gitmodules, 'utf-8');
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const gmCheck = checks.find((c) => c.id === 'template.gitmodules');
      assert.ok(gmCheck);
      assert.strictEqual(gmCheck.status, 'warn');
      assert.match(gmCheck.message, /differs/);
    });
  });

  it('passes when .gitmodules url agrees with source record', () => {
    withTempDir((cwd) => {
      const url = 'https://github.com/anokye-labs/kbexplorer-template.git';
      writeJson(join(cwd, '.kbx.json'), {
        template: url,
        ref: null,
        refType: 'release',
        mode: 'submodule',
      });
      const gitmodules = `[submodule ".kbx"]\n\tpath = .kbx\n\turl = ${url}\n`;
      writeFileSync(join(cwd, '.gitmodules'), gitmodules, 'utf-8');
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const gmCheck = checks.find((c) => c.id === 'template.gitmodules');
      assert.ok(gmCheck);
      assert.strictEqual(gmCheck.status, 'pass');
    });
  });
});

describe('checkTemplate — pinned tag ref', () => {
  it('pass on pinned tag', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'v1.2.3',
        refType: 'tag',
        mode: 'vendor',
      });
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const refCheck = checks.find((c) => c.id === 'template.ref');
      assert.ok(refCheck);
      assert.strictEqual(refCheck.status, 'pass');
      assert.match(refCheck.message, /v1\.2\.3/);
    });
  });

  it('warns when a newer tag is available (injected getLatestTag)', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'v1.0.0',
        refType: 'tag',
        mode: 'vendor',
      });
      const fakeGetLatestTag = () => 'v2.0.0';
      const checks = checkTemplate({ cwd, offline: false, getLatestTag: fakeGetLatestTag });
      const latestCheck = checks.find((c) => c.id === 'template.latest');
      assert.ok(latestCheck, 'template.latest check missing');
      assert.strictEqual(latestCheck.status, 'warn');
      assert.match(latestCheck.message, /v2\.0\.0/);
    });
  });

  it('passes latest check when already on the latest tag', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'v2.0.0',
        refType: 'tag',
        mode: 'vendor',
      });
      const fakeGetLatestTag = () => 'v2.0.0';
      const checks = checkTemplate({ cwd, offline: false, getLatestTag: fakeGetLatestTag });
      const latestCheck = checks.find((c) => c.id === 'template.latest');
      assert.ok(latestCheck);
      assert.strictEqual(latestCheck.status, 'pass');
    });
  });

  it('skips latest tag check when --offline', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'v1.0.0',
        refType: 'tag',
        mode: 'vendor',
      });
      // Even if getLatestTag is provided, offline=true should skip it
      const fakeGetLatestTag = () => { throw new Error('should not be called'); };
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: fakeGetLatestTag });
      const latestCheck = checks.find((c) => c.id === 'template.latest');
      assert.ok(latestCheck);
      assert.strictEqual(latestCheck.status, 'warn');
      assert.match(latestCheck.message, /skipped/i);
    });
  });
});

describe('checkTemplate — branch ref', () => {
  it('warns when tracking a branch (not pinned)', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        ref: 'main',
        refType: 'branch',
        mode: 'submodule',
      });
      const checks = checkTemplate({ cwd, offline: true, getLatestTag: null });
      const refCheck = checks.find((c) => c.id === 'template.ref');
      assert.ok(refCheck);
      assert.strictEqual(refCheck.status, 'warn');
      assert.match(refCheck.message, /main/);
    });
  });
});

// ── checkAdoption ─────────────────────────────────────────────────────────────

describe('checkAdoption — structured-content path', () => {
  it('warns with actionable guidance when the default content-model directory is absent', () => {
    withTempDir((cwd) => {
      const checks = checkAdoption({ cwd, env: {} });
      const pathCheck = checks.find((c) => c.id === 'adoption.structured-path');
      assert.ok(pathCheck);
      assert.strictEqual(pathCheck.status, 'warn');
      assert.match(pathCheck.message, /content-model\//);
      assert.match(pathCheck.message, /deploy-to-a-work-repo/);
    });
  });

  it('fails missing structured content only when repo config marks it required', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        mode: 'vendor',
        structuredContent: { path: 'work-graph', required: true },
      });
      const checks = checkAdoption({ cwd, env: {} });
      const pathCheck = checks.find((c) => c.id === 'adoption.structured-path');
      assert.ok(pathCheck);
      assert.strictEqual(pathCheck.status, 'fail');
      assert.match(pathCheck.message, /work-graph\//);
    });
  });

  it('reports a forward-compatible configured path from .kbx.json', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        template: 'https://github.com/anokye-labs/kbexplorer-template.git',
        mode: 'vendor',
        structuredContent: { path: 'work-graph' },
      });
      mkdirSync(join(cwd, 'work-graph', 'teams'), { recursive: true });
      writeFileSync(join(cwd, 'work-graph', 'teams', 'platform.yaml'), '"@type": team\nid: platform\nname: Platform\n', 'utf-8');

      const checks = checkAdoption({ cwd, env: {} });
      const pathCheck = checks.find((c) => c.id === 'adoption.structured-path');
      assert.ok(pathCheck);
      assert.strictEqual(pathCheck.status, 'pass');
      assert.match(pathCheck.message, /work-graph\//);
      assert.match(pathCheck.message, /\.kbx\.json structuredContent\.path/);
    });
  });

  it('warns when structured content appears under a likely misnamed path', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'structured-content', 'teams'), { recursive: true });
      writeFileSync(
        join(cwd, 'structured-content', 'teams', 'platform.yaml'),
        '"@type": team\nid: platform\nname: Platform\n',
        'utf-8',
      );

      const checks = checkAdoption({ cwd, env: {} });
      const candidate = checks.find((c) => c.id.startsWith('adoption.structured-candidate.'));
      assert.ok(candidate);
      assert.strictEqual(candidate.status, 'warn');
      assert.match(candidate.message, /structured-content\//);
      assert.match(candidate.message, /content-model\//);
    });
  });

  it('warns about local/remote parity when path comes from .env.kbx', () => {
    withTempDir((cwd) => {
      writeFileSync(join(cwd, '.env.kbx'), 'VITE_KB_CONTENT_MODEL=work-graph\n', 'utf-8');
      mkdirSync(join(cwd, 'work-graph', 'teams'), { recursive: true });
      writeFileSync(join(cwd, 'work-graph', 'teams', 'platform.yaml'), '"@type": team\nid: platform\nname: Platform\n', 'utf-8');

      const checks = checkAdoption({ cwd, env: {} });
      const parity = checks.find((c) => c.id === 'adoption.path-parity');
      assert.ok(parity);
      assert.strictEqual(parity.status, 'warn');
      assert.match(parity.message, /\.env\.kbx/);
      assert.match(parity.message, /CI|hosting/);
    });
  });
});

describe('checkAdoption — template capabilities', () => {
  it('warns when structured content is present but capabilities are not advertised yet', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'content-model', 'teams'), { recursive: true });
      writeFileSync(join(cwd, 'content-model', 'teams', 'platform.yaml'), '"@type": team\nid: platform\nname: Platform\n', 'utf-8');
      writeJson(join(cwd, '.kbx', 'package.json'), { name: 'kbexplorer-template', version: '0.0.1' });

      const checks = checkAdoption({ cwd, env: {} });
      const capabilities = checks.find((c) => c.id === 'adoption.template-capabilities');
      const visibility = checks.find((c) => c.id === 'adoption.visibility');
      assert.ok(capabilities);
      assert.ok(visibility);
      assert.strictEqual(capabilities.status, 'warn');
      assert.strictEqual(visibility.status, 'warn');
      assert.match(capabilities.message, /not advertised yet/);
    });
  });

  it('passes visibility when template metadata advertises structured-content ingestion', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'content-model', 'teams'), { recursive: true });
      mkdirSync(join(cwd, '.kbx', 'scripts'), { recursive: true });
      writeFileSync(join(cwd, 'content-model', 'teams', 'platform.yaml'), '"@type": team\nid: platform\nname: Platform\n', 'utf-8');
      writeFileSync(join(cwd, '.kbx', 'scripts', 'generate-manifest.js'), 'console.log("ok");\n', 'utf-8');
      writeJson(join(cwd, '.kbx', 'package.json'), {
        name: 'kbexplorer-template',
        version: '2.0.0',
        kbx: {
          protocolVersion: '1.0.0',
          minCliVersion: '0.1.0',
          capabilities: ['content-model-ingestion', 'configurable-content-model-path'],
        },
      });

      const checks = checkAdoption({ cwd, env: {} });
      const capabilities = checks.find((c) => c.id === 'adoption.template-capabilities');
      const visibility = checks.find((c) => c.id === 'adoption.visibility');
      const cliVersion = checks.find((c) => c.id === 'adoption.cli-version');
      assert.ok(capabilities);
      assert.ok(visibility);
      assert.ok(cliVersion);
      assert.strictEqual(capabilities.status, 'pass');
      assert.strictEqual(visibility.status, 'pass');
      assert.strictEqual(cliVersion.status, 'pass');
    });
  });

  it('warns when template metadata requires a newer CLI version', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx', 'package.json'), {
        name: 'kbexplorer-template',
        version: '2.0.0',
        kbx: {
          minCliVersion: '99.0.0',
          capabilities: ['content-model-ingestion'],
        },
      });

      const checks = checkAdoption({ cwd, env: {} });
      const cliVersion = checks.find((c) => c.id === 'adoption.cli-version');
      assert.ok(cliVersion);
      assert.strictEqual(cliVersion.status, 'warn');
      assert.match(cliVersion.message, /older than template minimum/);
    });
  });
});

// ── checkSources ──────────────────────────────────────────────────────────────

describe('checkSources — module specifier trust boundary (#203)', () => {
  it('passes with a clear message when no kbx.sources[] is configured', () => {
    withTempDir((cwd) => {
      const checks = checkSources({ cwd });
      const check = checks.find((c) => c.id === 'sources.none');
      assert.ok(check);
      assert.strictEqual(check.status, 'pass');
    });
  });

  it('passes when every declared module looks like an installed package', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        sources: [
          { sourceId: 'gh', module: '@anokye-labs/kbexplorer-provider-rich-markdown' },
          { sourceId: 'npm-pkg', module: 'some-package' },
        ],
      });
      const checks = checkSources({ cwd });
      const check = checks.find((c) => c.id === 'sources.module-specifiers');
      assert.ok(check);
      assert.strictEqual(check.status, 'pass');
      assert.ok(!checks.some((c) => c.status === 'fail'));
    });
  });

  it('warns (not fails) when a module specifier is a relative path', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        sources: [{ sourceId: 'local', module: './my-provider.js' }],
      });
      const checks = checkSources({ cwd });
      const check = checks.find((c) => c.id === 'sources.module-specifier.local');
      assert.ok(check);
      assert.strictEqual(check.status, 'warn');
      assert.match(check.message, /raw path\/URL/);
      assert.ok(!checks.some((c) => c.status === 'fail'), 'never fails, only warns');
    });
  });

  it('warns on an absolute path and on a URL specifier', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        sources: [
          { sourceId: 'abs', module: '/etc/passwd-provider.js' },
          { sourceId: 'remote', module: 'https://evil.example/provider.js' },
        ],
      });
      const checks = checkSources({ cwd });
      assert.strictEqual(checks.find((c) => c.id === 'sources.module-specifier.abs')?.status, 'warn');
      assert.strictEqual(checks.find((c) => c.id === 'sources.module-specifier.remote')?.status, 'warn');
    });
  });

  it('finds sources nested under a top-level kbx key too', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, '.kbx.json'), {
        kbx: { sources: [{ sourceId: 'nested', module: '../nested-provider.js' }] },
      });
      const checks = checkSources({ cwd });
      const check = checks.find((c) => c.id === 'sources.module-specifier.nested');
      assert.ok(check);
      assert.strictEqual(check.status, 'warn');
    });
  });
});

// ── checkEnvironment ──────────────────────────────────────────────────────────

describe('checkEnvironment — node version', () => {
  it('emits a node check', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git', '2.40.0'),
        gh: fakeSpawnAvailable('gh', '2.40.0'),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const nodeCheck = checks.find((c) => c.id === 'env.node');
      assert.ok(nodeCheck);
      assert.ok(nodeCheck.status === 'pass' || nodeCheck.status === 'fail');
    });
  });

  it('uses the CLI package.json engines requirement even when cwd differs', () => {
    withTempDir((cwd) => {
      writeJson(join(cwd, 'package.json'), { name: 'fixture-project', engines: { node: '>=999' } });
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git', '2.40.0'),
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const nodeCheck = checks.find((c) => c.id === 'env.node');
      assert.ok(nodeCheck);
      assert.strictEqual(nodeCheck.status, 'pass');
      assert.match(nodeCheck.message, /requires >=22/);
    });
  });
});

describe('checkEnvironment — git and gh', () => {
  it('emits pass when git is available', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git', '2.40.0'),
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const gitCheck = checks.find((c) => c.id === 'env.git');
      assert.ok(gitCheck);
      assert.strictEqual(gitCheck.status, 'pass');
    });
  });

  it('emits fail when git is not available', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnMissing();
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const gitCheck = checks.find((c) => c.id === 'env.git');
      assert.ok(gitCheck);
      assert.strictEqual(gitCheck.status, 'fail');
    });
  });

  it('emits warn (not fail) when gh is not available', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git', '2.40.0'),
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const ghCheck = checks.find((c) => c.id === 'env.gh');
      assert.ok(ghCheck);
      assert.strictEqual(ghCheck.status, 'warn');
    });
  });

  it('emits pass when gh is available', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git', '2.40.0'),
        gh: fakeSpawnAvailable('gh', '2.40.0'),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const ghCheck = checks.find((c) => c.id === 'env.gh');
      assert.ok(ghCheck);
      assert.strictEqual(ghCheck.status, 'pass');
    });
  });
});

describe('checkEnvironment — content dir', () => {
  it('emits pass when content/ exists', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'content'));
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git'),
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const c = checks.find((c) => c.id === 'env.content-dir');
      assert.ok(c);
      assert.strictEqual(c.status, 'pass');
    });
  });

  it('emits warn when content/ is absent', () => {
    withTempDir((cwd) => {
      const spawnSync = fakeSpawnRouter({
        git: fakeSpawnAvailable('git'),
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const c = checks.find((c) => c.id === 'env.content-dir');
      assert.ok(c);
      assert.strictEqual(c.status, 'warn');
    });
  });
});

describe('checkEnvironment — manifest freshness', () => {
  // The manifest lives in the template app at <appRoot>/src/generated/repo-manifest.json;
  // getAppRoot(cwd) finds the app via .kbx/package.json.
  function fixtureManifest(cwd, manifest) {
    writeJson(join(cwd, '.kbx', 'package.json'), { name: 'kbx' });
    writeJson(join(cwd, '.kbx', 'src', 'generated', 'repo-manifest.json'), manifest);
  }

  it('emits pass when manifest has recent generatedAt', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'content'));
      const now = new Date().toISOString();
      fixtureManifest(cwd, { generatedAt: now });
      // spawnSync for git log returns a recent timestamp
      const spawnSync = fakeSpawnRouter({
        git: (cmd, args) => {
          if (args.includes('--format=%ci')) {
            return { status: 0, stdout: now, stderr: '', error: null };
          }
          return fakeSpawnAvailable('git')(cmd, args);
        },
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const mc = checks.find((c) => c.id === 'env.manifest');
      assert.ok(mc);
      assert.strictEqual(mc.status, 'pass');
    });
  });

  it('emits warn when manifest generatedAt is older than HEAD commit', () => {
    withTempDir((cwd) => {
      mkdirSync(join(cwd, 'content'));
      // Manifest generated 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      fixtureManifest(cwd, { generatedAt: oneHourAgo });
      // HEAD commit is "now"
      const now = new Date().toISOString();
      const spawnSync = fakeSpawnRouter({
        git: (cmd, args) => {
          if (args.includes('--format=%ci')) {
            return { status: 0, stdout: now, stderr: '', error: null };
          }
          return fakeSpawnAvailable('git')(cmd, args);
        },
        gh: fakeSpawnMissing(),
      });
      const checks = checkEnvironment({ cwd, env: {}, spawnSync });
      const mc = checks.find((c) => c.id === 'env.manifest');
      assert.ok(mc);
      assert.strictEqual(mc.status, 'warn');
      assert.match(mc.message, /stale|older/i);
    });
  });
});

// ── doctor command integration tests ─────────────────────────────────────────

describe('doctor command — --help', () => {
  it('prints help and returns without error', async () => {
    const cap = captureConsole();
    try {
      await doctor(['--help'], { offline: true });
    } finally {
      cap.restore();
    }
    const text = cap.lines.join('\n');
    assert.match(text, /kbx doctor/);
    assert.match(text, /--json/);
    assert.match(text, /--offline/);
    assert.match(text, /--runtime/);
  });
});

describe('doctor command — human output sections', () => {
  it('includes all five sections in human output', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home-'));
      try {
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git', '2.40.0'),
          gh: fakeSpawnAvailable('gh', '2.40.0'),
          copilot: fakeSpawnAvailable('copilot', '1.0.0'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        try {
          await doctor([], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
          process.exitCode = origExitCode;
        }
        const text = cap.lines.join('\n');
        assert.match(text, /Runtime/);
        assert.match(text, /MCP/);
        assert.match(text, /Template/);
        assert.match(text, /Adoption readiness/);
        assert.match(text, /Environment/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('doctor command — --json output', () => {
  it('emits valid JSON with sections and ok fields', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home-'));
      try {
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnAvailable('gh'),
          copilot: fakeSpawnAvailable('copilot'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        try {
          await doctor(['--json'], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
          process.exitCode = origExitCode;
        }
        const text = cap.lines.join('\n');
        const parsed = JSON.parse(text);
        assert.ok(Array.isArray(parsed.sections), 'sections should be an array');
        assert.ok(typeof parsed.ok === 'boolean', 'ok should be boolean');
        assert.ok(parsed.sections.length >= 5, 'should have at least 5 sections');
        for (const section of parsed.sections) {
          assert.ok(section.name, 'section should have name');
          assert.ok(Array.isArray(section.checks), 'section should have checks');
          for (const check of section.checks) {
            assert.ok(check.id, 'check should have id');
            assert.ok(['pass', 'warn', 'fail'].includes(check.status), `bad status: ${check.status}`);
            assert.ok(check.message, 'check should have message');
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('JSON ok=true when all checks pass or warn', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home2-'));
      try {
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnAvailable('gh'),
          copilot: fakeSpawnAvailable('copilot'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        try {
          await doctor(['--json'], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
          process.exitCode = origExitCode;
        }
        const parsed = JSON.parse(cap.lines.join('\n'));
        // copilot available, no fail checks expected here
        // (git available, copilot available — may have warns for missing content/kbexplorer.json)
        const failChecks = parsed.sections.flatMap((s) => s.checks).filter((c) => c.status === 'fail');
        if (parsed.ok) {
          assert.strictEqual(failChecks.length, 0);
        } else {
          assert.ok(failChecks.length > 0, 'ok=false but no fail checks found');
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('doctor command — exit code', () => {
  it('sets exitCode=1 when a check fails (binary missing)', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home3-'));
      try {
        // copilot missing → runtime.available = fail
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnAvailable('gh'),
          copilot: fakeSpawnMissing(),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        process.exitCode = 0;
        try {
          await doctor([], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
        }
        assert.strictEqual(process.exitCode, 1);
        process.exitCode = origExitCode;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('does NOT set exitCode=1 when all checks are pass or warn', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home4-'));
      try {
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnAvailable('gh'),
          copilot: fakeSpawnAvailable('copilot'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        process.exitCode = 0;
        try {
          await doctor([], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
        }
        // With copilot available, no fail checks — exitCode should remain 0
        assert.strictEqual(process.exitCode, 0);
        process.exitCode = origExitCode;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('doctor command — --runtime flag honored', () => {
  it('--runtime claude selects claude adapter', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home5-'));
      try {
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnMissing(),
          claude: fakeSpawnAvailable('claude', '0.2.0'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        try {
          await doctor(['--runtime', 'claude', '--json'], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
          process.exitCode = origExitCode;
        }
        const parsed = JSON.parse(cap.lines.join('\n'));
        const runtimeSection = parsed.sections.find((s) => s.name === 'Runtime');
        assert.ok(runtimeSection);
        const selectedCheck = runtimeSection.checks.find((c) => c.id === 'runtime.selected');
        assert.ok(selectedCheck);
        assert.match(selectedCheck.message, /claude/);
        assert.match(selectedCheck.message, /--runtime flag/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('doctor command — gitmodules mismatch reported', () => {
  it('reports mismatch in Template section JSON output', async () => {
    withTempDir(async (cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'kb-dr-home6-'));
      try {
        writeJson(join(cwd, '.kbx.json'), {
          template: 'https://github.com/anokye-labs/kbexplorer-template.git',
          ref: null,
          refType: 'release',
          mode: 'submodule',
        });
        const gitmodules = `[submodule ".kbx"]\n\tpath = .kbx\n\turl = https://github.com/other/template.git\n`;
        writeFileSync(join(cwd, '.gitmodules'), gitmodules, 'utf-8');
        const spawnSync = fakeSpawnRouter({
          git: fakeSpawnAvailable('git'),
          gh: fakeSpawnMissing(),
          copilot: fakeSpawnAvailable('copilot'),
        });
        const cap = captureConsole();
        const origExitCode = process.exitCode;
        try {
          await doctor(['--json'], {
            cwd,
            env: { HOME: home, USERPROFILE: home },
            spawnSync,
            getLatestTag: null,
            offline: true,
          });
        } finally {
          cap.restore();
          process.exitCode = origExitCode;
        }
        const parsed = JSON.parse(cap.lines.join('\n'));
        const templateSection = parsed.sections.find((s) => s.name === 'Template');
        assert.ok(templateSection);
        const gmCheck = templateSection.checks.find((c) => c.id === 'template.gitmodules');
        assert.ok(gmCheck, 'template.gitmodules check missing');
        assert.strictEqual(gmCheck.status, 'warn');
        assert.match(gmCheck.message, /differs/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
