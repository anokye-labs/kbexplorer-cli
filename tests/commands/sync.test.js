import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mod = await import('../../src/commands/sync.js');
const syncCommand = mod.default;
const { computeSync, evaluateConnect, DEFAULT_GRAPH } = mod;

const hash = (d) => ({ algorithm: 'sha256', digest: d, encoding: 'hex' });
const dnode = (id, src, href, digest) => ({
  id,
  sourceId: src,
  derivation: { mode: 'derived', generator: 'g@1', inputs: [{ kind: 'git', href, contentHash: hash(digest) }] },
});

async function inDir(dir, fn) {
  const prevCwd = process.cwd();
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(prevCwd);
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join('\n');
}

describe('sync command — module shape', () => {
  it('exports the default command + helpers', () => {
    assert.equal(typeof syncCommand, 'function');
    assert.equal(typeof computeSync, 'function');
    assert.equal(typeof evaluateConnect, 'function');
    assert.equal(DEFAULT_GRAPH, '.kbx/connection/composite-graph.json');
  });
});

describe('computeSync (injected graphs)', () => {
  it('detects drift from a changed input hash', () => {
    const { status, baselineDesc } = computeSync({
      currentGraph: { nodes: [dnode('a', 'gh', 'x', 'h2')] },
      baselineGraph: { nodes: [dnode('a', 'gh', 'x', 'h1')] },
      connect: null,
      against: 'prior.json',
    });
    assert.equal(status.drift, true);
    assert.deepEqual(status.graph.dirtyInputs, ['x']);
    assert.equal(baselineDesc, 'prior.json');
    assert.equal(status.sources.find((s) => s.source === 'gh').status, 'drifted');
  });

  it('reports in-sync when nothing changed', () => {
    const { status } = computeSync({
      currentGraph: { nodes: [dnode('a', 'gh', 'x', 'h1')] },
      baselineGraph: { nodes: [dnode('a', 'gh', 'x', 'h1')] },
      connect: null,
    });
    assert.equal(status.drift, false);
    assert.equal(status.inSync, true);
  });

  it('throws GRAPH_NOT_FOUND when the graph file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    try {
      assert.throws(() => computeSync({ cwd: dir, connect: null }), /Graph file not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the current graph from disk at the default path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    try {
      mkdirSync(resolve(dir, '.kbx/connection'), { recursive: true });
      writeFileSync(
        resolve(dir, DEFAULT_GRAPH),
        JSON.stringify({ nodes: [dnode('a', 'gh', 'x', 'h1')] }),
        'utf-8'
      );
      const { status, graphPath } = computeSync({ cwd: dir, baselineGraph: null, connect: null });
      assert.equal(graphPath, DEFAULT_GRAPH);
      assert.equal(status.full, true); // no baseline
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluateConnect', () => {
  it('returns null when no connection artifacts exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    try {
      assert.equal(evaluateConnect(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces the injected connect --check result when artifacts exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    try {
      mkdirSync(resolve(dir, '.kbx/connection'), { recursive: true });
      writeFileSync(resolve(dir, '.kbx/connection/minted-edges.json'), '[]\n', 'utf-8');
      const res = evaluateConnect(dir, {
        runConnect: () => ({ ok: false, drift: [{ file: 'minted-edges.json', reason: 'stale' }] }),
      });
      assert.equal(res.ok, false);
      assert.equal(res.drift.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sync command — end to end (--check)', () => {
  it('exits non-zero and prints drift when a source drifted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    let exitCode = null;
    const origExit = process.exit;
    process.exit = (c) => { exitCode = c; throw new Error('__exit__'); };
    try {
      mkdirSync(resolve(dir, '.kbx/connection'), { recursive: true });
      writeFileSync(resolve(dir, DEFAULT_GRAPH), JSON.stringify({ nodes: [dnode('a', 'gh', 'x', 'h2')] }), 'utf-8');
      const prior = resolve(dir, 'prior.json');
      writeFileSync(prior, JSON.stringify({ nodes: [dnode('a', 'gh', 'x', 'h1')] }), 'utf-8');
      const out = await inDir(dir, async () => {
        try {
          await syncCommand(['--check', '--against', 'prior.json']);
        } catch (e) {
          if (e.message !== '__exit__') throw e;
        }
      });
      assert.equal(exitCode, 1);
      assert.match(out, /drifted/i);
    } finally {
      process.exit = origExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check --json emits machine-readable status and stays clean when in sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
    try {
      mkdirSync(resolve(dir, '.kbx/connection'), { recursive: true });
      const g = JSON.stringify({ nodes: [dnode('a', 'gh', 'x', 'h1')] });
      writeFileSync(resolve(dir, DEFAULT_GRAPH), g, 'utf-8');
      writeFileSync(resolve(dir, 'prior.json'), g, 'utf-8');
      const out = await inDir(dir, async () => {
        await syncCommand(['--check', '--json', '--against', 'prior.json']);
      });
      const parsed = JSON.parse(out);
      assert.equal(parsed.mode, 'check');
      assert.equal(parsed.drift, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown options', async () => {
    let exitCode = null;
    const origExit = process.exit;
    process.exit = (c) => { exitCode = c; throw new Error('__exit__'); };
    try {
      const dir = mkdtempSync(join(tmpdir(), 'kbx-sync-'));
      await inDir(dir, async () => {
        try {
          await syncCommand(['--bogus']);
        } catch (e) {
          if (e.message !== '__exit__') throw e;
        }
      });
      assert.equal(exitCode, 1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      process.exit = origExit;
    }
  });
});
