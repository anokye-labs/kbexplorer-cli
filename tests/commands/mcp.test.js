import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mcpMod = await import('../../src/commands/mcp.js');
const mcp = mcpMod.default;
const { parseMcpArgs } = mcpMod;

/** Collect stderr/log output and a stub process. */
function harness({ cwd = '/repo', env = {} } = {}) {
  const out = { log: [], err: [] };
  const proc = {
    exitCode: 0,
    cwd: () => cwd,
    stderr: { write: (s) => out.err.push(s.replace(/\n$/, '')) },
  };
  const io = { log: (s) => out.log.push(s), error: (s) => out.err.push(s) };
  return { out, proc, io, env };
}

describe('commands/mcp — parseMcpArgs', () => {
  it('parses flags', () => {
    assert.deepEqual(parseMcpArgs(['--help']).help, true);
    assert.deepEqual(parseMcpArgs(['--allow']).allow, true);
    assert.deepEqual(parseMcpArgs(['--skip-preflight']).skipPreflight, true);
    assert.equal(parseMcpArgs(['--name', 'kb']).name, 'kb');
    assert.equal(parseMcpArgs(['--name=kb2']).name, 'kb2');
    assert.deepEqual(parseMcpArgs(['--bogus']).unknown, ['--bogus']);
  });
});

describe('commands/mcp — run', () => {
  it('prints help and does not start the server', async () => {
    const h = harness();
    let ran = false;
    await mcp(['--help'], { ...h, run: async () => (ran = true), preflight: () => ({ ok: true }) });
    assert.equal(ran, false);
    assert.ok(h.out.log.join('\n').includes('kbx mcp'));
  });

  it('runs preflight then starts the server with cwd + defaults', async () => {
    const h = harness({ cwd: '/work' });
    let started;
    let preflighted = false;
    await mcp([], {
      ...h,
      preflight: () => {
        preflighted = true;
        return { ok: true, errors: [], warnings: [], toolCount: 5 };
      },
      run: async (opts) => {
        started = opts;
      },
    });
    assert.equal(preflighted, true);
    assert.deepEqual(started, { cwd: '/work', allow: false, name: 'kbexplorer' });
  });

  it('aborts with exitCode=1 when preflight fails', async () => {
    const h = harness();
    let ran = false;
    await mcp([], {
      ...h,
      preflight: () => ({ ok: false, errors: ['Node too old'], warnings: [] }),
      run: async () => (ran = true),
    });
    assert.equal(ran, false);
    assert.equal(h.proc.exitCode, 1);
    assert.ok(h.out.err.join('\n').includes('Node too old'));
  });

  it('--allow and KBX_MCP_CONSENT=allow both enable non-interactive consent', async () => {
    for (const variant of [{ argv: ['--allow'], env: {} }, { argv: [], env: { KBX_MCP_CONSENT: 'allow' } }]) {
      const h = harness({ env: variant.env });
      let started;
      await mcp(variant.argv, { ...h, preflight: () => ({ ok: true }), run: async (o) => (started = o) });
      assert.equal(started.allow, true);
    }
  });

  it('honours --skip-preflight (never calls preflight)', async () => {
    const h = harness();
    let preflighted = false;
    await mcp(['--skip-preflight'], {
      ...h,
      preflight: () => {
        preflighted = true;
        return { ok: false, errors: ['x'], warnings: [] };
      },
      run: async () => {},
    });
    assert.equal(preflighted, false);
  });

  it('warns on unknown args but still runs', async () => {
    const h = harness();
    let ran = false;
    await mcp(['--bogus'], { ...h, preflight: () => ({ ok: true }), run: async () => (ran = true) });
    assert.equal(ran, true);
    assert.ok(h.out.err.join('\n').includes('unknown args'));
  });
});
