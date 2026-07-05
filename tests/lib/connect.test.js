import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  runConnect,
  applyOverrides,
  serializeConnectArtifacts,
  loadOverrides,
  writeConnectArtifacts,
  checkConnectArtifacts,
  normalizeOverrides,
  ConnectError,
  CONNECT_DIR,
  OVERRIDES_FILE,
  ARTIFACT_FILES,
  CONFLATION_MAP_FILE,
  MINTED_EDGES_FILE,
} from '../../src/lib/connect.js';
import { runConnectCommand } from '../../src/commands/connect.js';

function node(id, extra = {}) {
  return {
    id,
    title: id,
    cluster: 'people',
    content: '',
    rawContent: '',
    connections: [],
    source: { type: 'external', provider: 'test' },
    ...extra,
  };
}

function tmpDir() {
  return mkdtempSync(resolve(tmpdir(), 'kbx-connect-'));
}

describe('connect — artifacts are deterministic + byte-identical on re-run', () => {
  it('serializes canonical, timestamp-free artifacts and regenerates identically', () => {
    const graph = {
      nodes: [
        node('doc', { sourceId: 'docs', identity: 'kg://doc/d', linkedRefs: [{ kind: 'kg', href: 'kg://epic/e', role: 'describes' }] }),
        node('epic', { sourceId: 'gh', identity: 'kg://epic/e' }),
      ],
      edges: [],
    };
    const a = serializeConnectArtifacts(runConnect(graph));
    const b = serializeConnectArtifacts(runConnect(graph));
    for (const f of ARTIFACT_FILES) assert.equal(a[f], b[f]);
    // minted edge present, no timestamps anywhere.
    assert.match(a[MINTED_EDGES_FILE], /"from": "doc"/);
    for (const f of ARTIFACT_FILES) assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a[f]), `${f} has a timestamp`);
  });
});

describe('connect — write + --check parity (mirrors derive --check)', () => {
  it('writes then passes --check on clean, fails on drift', () => {
    const dir = tmpDir();
    try {
      const cdir = resolve(dir, CONNECT_DIR);
      const graph = { nodes: [node('a', { identity: 'kg://a' })], edges: [] };
      const artifacts = serializeConnectArtifacts(runConnect(graph));
      const report = writeConnectArtifacts(cdir, artifacts);
      assert.equal(report.every((r) => r.status === 'created'), true);

      // clean check passes
      assert.equal(checkConnectArtifacts(cdir, artifacts).ok, true);

      // re-write is idempotent (unchanged)
      assert.equal(writeConnectArtifacts(cdir, artifacts).every((r) => r.status === 'unchanged'), true);

      // tamper one file → drift detected, names the file
      writeFileSync(resolve(cdir, CONFLATION_MAP_FILE), '{"groups":[],"warnings":["x"]}\n', 'utf-8');
      const res = checkConnectArtifacts(cdir, artifacts);
      assert.equal(res.ok, false);
      assert.equal(res.drift.length, 1);
      assert.equal(res.drift[0].file, CONFLATION_MAP_FILE);

      // missing file → drift
      rmSync(resolve(cdir, MINTED_EDGES_FILE));
      const res2 = checkConnectArtifacts(cdir, artifacts);
      assert.ok(res2.drift.some((d) => d.file === MINTED_EDGES_FILE && /missing/.test(d.reason)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connect — manual overrides steer the result through the unchanged engines', () => {
  it('a same-as override forces a conflation; a differentiated-from override blocks it', () => {
    const graph = {
      nodes: [node('p1', { sourceId: 's1', identity: 'kg://p/1' }), node('p2', { sourceId: 's2', identity: 'kg://p/2' })],
      edges: [],
    };
    // Baseline: no claims → no conflation.
    assert.equal(runConnect(graph).groups.length, 0);

    // same-as override → conflated into one group.
    const merged = runConnect(graph, {
      overrides: { identityClaims: [{ node: 'p1', claim: 'same-as', ref: 'kg://p/2' }] },
    });
    assert.equal(merged.groups.length, 1);
    assert.deepEqual(merged.groups[0].members, ['p1', 'p2']);

    // add a differentiated-from override on the same pair → contradiction, blocked.
    const blocked = runConnect(graph, {
      overrides: {
        identityClaims: [
          { node: 'p1', claim: 'same-as', ref: 'kg://p/2' },
          { node: 'p2', claim: 'differentiated-from', ref: 'kg://p/1' },
        ],
      },
    });
    assert.equal(blocked.groups.length, 0);
    assert.equal(blocked.stats.contradictions, 1);
  });

  it('a linkedRef override mints an edge between distinct nodes', () => {
    const graph = {
      nodes: [node('a', { identity: 'kg://a' }), node('b', { identity: 'kg://b' })],
      edges: [],
    };
    assert.equal(runConnect(graph).minted.length, 0);
    const out = runConnect(graph, {
      overrides: { linkedRefs: [{ node: 'a', ref: 'kg://b', role: 'leads' }] },
    });
    assert.equal(out.minted.length, 1);
    assert.equal(out.minted[0].from, 'a');
    assert.equal(out.minted[0].to, 'b');
    assert.equal(out.minted[0].relation, 'leads');
  });

  it('applyOverrides does not mutate the input graph', () => {
    const graph = { nodes: [node('a', { identity: 'kg://a' })] };
    applyOverrides(graph, { identityClaims: [{ node: 'a', claim: 'same-as', ref: 'kg://b' }] });
    assert.ok(!('identityClaims' in graph.nodes[0]));
  });
});

describe('connect — overrides loading: input file is never written, missing = no-op', () => {
  it('loadOverrides returns null when the file is missing or empty', () => {
    const dir = tmpDir();
    try {
      const cdir = resolve(dir, CONNECT_DIR);
      mkdirSync(cdir, { recursive: true });
      assert.equal(loadOverrides(cdir), null);
      writeFileSync(resolve(cdir, OVERRIDES_FILE), '   \n', 'utf-8');
      assert.equal(loadOverrides(cdir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeConnectArtifacts never creates or overwrites the override INPUT file', () => {
    const dir = tmpDir();
    try {
      const cdir = resolve(dir, CONNECT_DIR);
      mkdirSync(cdir, { recursive: true });
      const overridePath = resolve(cdir, OVERRIDES_FILE);
      const authored = '{\n  "identityClaims": [\n    { "node": "p1", "claim": "same-as", "ref": "kg://p/2" }\n  ]\n}\n';
      writeFileSync(overridePath, authored, 'utf-8');

      const artifacts = serializeConnectArtifacts(runConnect({ nodes: [node('a', { identity: 'kg://a' })] }));
      writeConnectArtifacts(cdir, artifacts);

      // override file is byte-for-byte untouched, and is not one of the outputs.
      assert.equal(readFileSync(overridePath, 'utf-8'), authored);
      assert.ok(!ARTIFACT_FILES.includes(OVERRIDES_FILE));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizeOverrides rejects malformed input', () => {
    assert.throws(() => normalizeOverrides([]), ConnectError);
    assert.throws(
      () => normalizeOverrides({ identityClaims: [{ node: 'a' }] }),
      /needs `node`, `claim`, and `ref`/
    );
    assert.deepEqual(normalizeOverrides(null), { identityClaims: [], linkedRefs: [] });
  });
});

describe('connect — runConnectCommand end-to-end over a temp repo (injected graph)', () => {
  it('writes artifacts, then --check passes; mutating an artifact makes --check report drift', async () => {
    const dir = tmpDir();
    try {
      const graph = {
        nodes: [node('a', { sourceId: 's1', identity: 'kg://a', linkedRefs: [{ kind: 'kg', href: 'kg://b', role: 'leads' }] }), node('b', { sourceId: 's2', identity: 'kg://b' })],
        edges: [],
      };
      const w = await runConnectCommand({ cwd: dir, graph });
      assert.equal(w.check, false);
      assert.equal(w.stats.mintedEdges, 1);
      assert.ok(existsSync(resolve(dir, CONNECT_DIR, MINTED_EDGES_FILE)));

      const ok = await runConnectCommand({ cwd: dir, graph, check: true });
      assert.equal(ok.ok, true);

      writeFileSync(resolve(dir, CONNECT_DIR, MINTED_EDGES_FILE), '[]\n', 'utf-8');
      const drifted = await runConnectCommand({ cwd: dir, graph, check: true });
      assert.equal(drifted.ok, false);
      assert.equal(drifted.drift[0].file, MINTED_EDGES_FILE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
