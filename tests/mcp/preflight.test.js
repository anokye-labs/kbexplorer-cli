import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { runMcpServerPreflight, formatMcpServerPreflight, MIN_NODE_MAJOR } = await import(
  '../../src/mcp/preflight.js'
);

describe('mcp/preflight — runMcpServerPreflight', () => {
  it('passes on the current runtime with real affordances', () => {
    const r = runMcpServerPreflight({});
    assert.equal(r.ok, true);
    assert.ok(r.toolCount > 0);
    assert.deepEqual(r.errors, []);
  });

  it('fails on an old Node major', () => {
    const r = runMcpServerPreflight({ nodeVersion: '18.20.0' });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], new RegExp(`>= ${MIN_NODE_MAJOR}`));
  });

  it('reports a registry load failure', () => {
    const r = runMcpServerPreflight({
      describe: () => {
        throw new Error('registry broke');
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /registry broke/);
  });

  it('fails when no affordances are registered', () => {
    const r = runMcpServerPreflight({ describe: () => [] });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /no affordances/i);
  });
});

describe('mcp/preflight — formatMcpServerPreflight', () => {
  it('returns no lines on ok', () => {
    assert.deepEqual(formatMcpServerPreflight({ ok: true, errors: [], warnings: [] }), []);
  });

  it('lists each error and a bypass hint on failure', () => {
    const lines = formatMcpServerPreflight({ ok: false, errors: ['a', 'b'], warnings: [] });
    assert.match(lines[0], /preflight failed/);
    assert.ok(lines.some((l) => l.includes('a')));
    assert.ok(lines.some((l) => /--skip-preflight/.test(l)));
  });
});
