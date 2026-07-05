import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { audit, _internal } = await import('../../src/lib/audit.ts');

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-audit-'));
  const content = resolve(dir, 'content');
  mkdirSync(content, { recursive: true });
  return { dir, content };
}

function write(file, lines) {
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
}

describe('audit — parseClusterKeys', () => {
  it('extracts top-level cluster keys only', () => {
    const yaml = [
      'title: "X"',
      'clusters:',
      '  alpha:',
      '    name: "Alpha"',
      '    color: "#fff"',
      '  beta:',
      '    name: "Beta"',
      'features:',
      '  hud: true',
    ].join('\n');
    const keys = _internal.parseClusterKeys(yaml);
    assert.deepEqual([...keys].sort(), ['alpha', 'beta']);
  });

  it('returns an empty set when no clusters block exists', () => {
    assert.equal(_internal.parseClusterKeys('').size, 0);
    assert.equal(_internal.parseClusterKeys('title: X\n').size, 0);
  });
});

describe('audit — detectParentCycle', () => {
  it('reports nothing for an acyclic chain', () => {
    const nodes = [
      { id: 'a', parent: null },
      { id: 'b', parent: 'a' },
      { id: 'c', parent: 'b' },
    ];
    assert.deepEqual(_internal.detectParentCycle(nodes), []);
  });

  it('detects a 2-node cycle', () => {
    const nodes = [
      { id: 'a', parent: 'b' },
      { id: 'b', parent: 'a' },
    ];
    const cycles = _internal.detectParentCycle(nodes);
    assert.ok(cycles.length >= 1);
    assert.ok(cycles.some((c) => c.cycle.includes('a') && c.cycle.includes('b')));
  });

  it('detects a self-cycle', () => {
    const nodes = [{ id: 'self', parent: 'self' }];
    const cycles = _internal.detectParentCycle(nodes);
    assert.equal(cycles.length, 1);
  });
});

describe('audit — end-to-end', () => {
  it('passes on a valid single-node content tree', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'home.md'), [
        '---',
        'id: "home"',
        'title: "Home"',
        'cluster: overview',
        'connections: []',
        '---',
        '',
        '# Home',
      ]);
      const { findings, summary } = audit({ contentDir: content });
      assert.equal(summary.errors, 0);
      assert.equal(summary.nodes, 1);
      assert.equal(findings.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags missing required fields', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'broken.md'), [
        '---',
        'title: "Missing id and cluster"',
        '---',
        '# X',
      ]);
      const { findings, summary } = audit({ contentDir: content });
      assert.ok(summary.errors >= 2);
      const rules = findings.map((f) => f.rule);
      assert.ok(rules.includes('missing-required-field'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags duplicate ids across files', () => {
    const { dir, content } = makeFixture();
    try {
      for (const name of ['a.md', 'b.md']) {
        write(resolve(content, name), [
          '---',
          'id: "dup"',
          'title: "Dup"',
          'cluster: overview',
          '---',
        ]);
      }
      const { findings } = audit({ contentDir: content });
      const dup = findings.find((f) => f.rule === 'duplicate-id');
      assert.ok(dup, 'expected duplicate-id finding');
      assert.equal(dup.id, 'dup');
      assert.equal(dup.files.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags broken parent references', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'child.md'), [
        '---',
        'id: "child"',
        'title: "Child"',
        'cluster: x',
        'parent: "ghost"',
        '---',
      ]);
      const { findings } = audit({ contentDir: content });
      assert.ok(findings.some((f) => f.rule === 'broken-parent' && f.parent === 'ghost'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags dead connection targets but accepts built-in ids', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'src.md'), [
        '---',
        'id: "src"',
        'title: "Source"',
        'cluster: x',
        'connections:',
        '  - to: "issue-42"',
        '    description: "tracked by"',
        '  - to: "does-not-exist"',
        '    description: "ghost"',
        '---',
      ]);
      const { findings } = audit({ contentDir: content });
      const dead = findings.filter((f) => f.rule === 'dead-connection');
      assert.equal(dead.length, 1, 'only one dead connection (issue-42 is built-in)');
      assert.equal(dead[0].to, 'does-not-exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags filename/id mismatch as a warning', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'wrong-name.md'), [
        '---',
        'id: "different-id"',
        'title: "X"',
        'cluster: x',
        '---',
      ]);
      const { findings } = audit({ contentDir: content });
      const w = findings.find((f) => f.rule === 'filename-id-mismatch');
      assert.ok(w);
      assert.equal(w.severity, 'warning');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
