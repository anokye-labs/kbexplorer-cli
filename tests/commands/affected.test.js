import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const affectedModule = await import('../../src/commands/affected.ts');
const { loadBaselineGraph } = affectedModule;
const affectedCommand = affectedModule.default;

const hash = (d) => ({ algorithm: 'sha256', digest: d, encoding: 'hex' });
const dnode = (id, href, digest) => ({
  id,
  derivation: { mode: 'derived', generator: 'g@1', inputs: [{ kind: 'git', href, contentHash: hash(digest) }] },
});

/** Run an async fn with cwd switched to `dir`, capturing console.log output. */
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

describe('affected command — module shape', () => {
  it('exports a default function and loadBaselineGraph', () => {
    assert.equal(typeof affectedCommand, 'function');
    assert.equal(typeof loadBaselineGraph, 'function');
  });
});

describe('loadBaselineGraph (injected gitShow)', () => {
  it('parses the prior graph the ref returns', () => {
    const prior = { nodes: [dnode('a', 'x', 'h1')] };
    const out = loadBaselineGraph(
      { cwd: '/repo', graphPath: 'graph.json', since: 'HEAD' },
      { gitShow: () => JSON.stringify(prior) }
    );
    assert.deepEqual(out.nodes[0].id, 'a');
  });

  it('returns null when the file is absent at the ref (git throws)', () => {
    const out = loadBaselineGraph(
      { cwd: '/repo', graphPath: 'graph.json', since: 'HEAD' },
      {
        gitShow: () => {
          throw new Error('fatal: path does not exist');
        },
      }
    );
    assert.equal(out, null);
  });

  it('returns null on empty or unparseable content', () => {
    assert.equal(
      loadBaselineGraph({ cwd: '/r', graphPath: 'g.json', since: 'HEAD' }, { gitShow: () => '' }),
      null
    );
    assert.equal(
      loadBaselineGraph({ cwd: '/r', graphPath: 'g.json', since: 'HEAD' }, { gitShow: () => '{bad' }),
      null
    );
  });

  it('normalizes JSON-LD @graph/@edges shapes', () => {
    const out = loadBaselineGraph(
      { cwd: '/r', graphPath: 'g.json', since: 'HEAD' },
      { gitShow: () => JSON.stringify({ '@graph': [{ '@id': 'kg://n' }], '@edges': [] }) }
    );
    assert.equal(out.nodes[0]['@id'], 'kg://n');
  });
});

describe('affected command — composite mode, no git baseline => full build', () => {
  it('reports a full build (JSON) when there is no prior committed state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-affcmd-'));
    try {
      writeFileSync(
        resolve(dir, 'graph.json'),
        JSON.stringify({ nodes: [dnode('a', 'x', 'h1'), { id: 'b' }] }),
        'utf-8'
      );
      const out = await inDir(dir, () =>
        affectedCommand(['--graph', 'graph.json', '--json'])
      );
      const parsed = JSON.parse(out);
      assert.equal(parsed.full, true);
      assert.deepEqual(parsed.affected, ['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when the graph file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-affcmd-'));
    try {
      const out = await inDir(dir, () => affectedCommand(['--graph', 'nope.json']));
      assert.match(out, /Graph file not found/);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0; // reset for the rest of the suite
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('affected command — composite mode, real git baseline', () => {
  it('diffs the committed graph at HEAD and reports the changed node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-affgit-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init', '-q');
      git('config', 'user.email', 'a@b.c');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      const graphPath = resolve(dir, 'graph.json');
      // Baseline: node "a" derived from src/a.ts@h1; node "b" derived from a's identity.
      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [
            dnode('a', 'src/a.ts', 'h1'),
            { id: 'b', derivation: { mode: 'derived', inputs: [{ kind: 'git', href: 'a' }] } },
          ],
        }),
        'utf-8'
      );
      git('add', '-A');
      git('commit', '-qm', 'baseline');

      // Working change: a's input hash flips h1 -> h2.
      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [
            dnode('a', 'src/a.ts', 'h2'),
            { id: 'b', derivation: { mode: 'derived', inputs: [{ kind: 'git', href: 'a' }] } },
          ],
        }),
        'utf-8'
      );

      const out = await inDir(dir, () =>
        affectedCommand(['--graph', 'graph.json', '--since', 'HEAD', '--json'])
      );
      const parsed = JSON.parse(out);
      assert.equal(parsed.full, false);
      assert.deepEqual(parsed.dirtyInputs, ['src/a.ts']);
      // "a" is the seed; "b" derives from a => downstream affected.
      assert.deepEqual(parsed.affected, ['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
