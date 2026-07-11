/**
 * kbx graph <sub> — thin wiring over the engine's authored-content-graph
 * helpers (anokye-labs/kbexplorer-engine#18/#19, epic
 * anokye-labs/kbexplorer-template#463).
 *
 * These tests only exercise the CLI's argv → engine-input → output wiring —
 * NOT graph-domain rules (those are the engine's `validateGraph`/`assessGraph`/
 * `deriveNeeds`/`compareContent`/`enrichFromManifest`, already covered by the
 * engine's own test suite). Coverage here:
 *   - validate: gates (exit 1 on structural errors), --json shape, --content override
 *   - assess:   honors --gate as a real CI gate, while bare assess remains non-gating
 *   - derive/compare: catalogue.json + content-file wiring, missing-catalogue exit 1
 *   - enrich:   --manifest file wiring, catalogue-enriched.json side effect
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mod = await import('../../src/commands/graph.ts');
const graphCommand = mod.default;

function makeHost() {
  const host = mkdtempSync(join(tmpdir(), 'kbx-graph-'));
  mkdirSync(resolve(host, 'content'), { recursive: true });
  return host;
}

async function inDir(dir, fn) {
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  process.chdir(dir);
  process.exitCode = undefined;
  let exitCode;
  try {
    await fn();
    exitCode = process.exitCode;
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
    console.log = origLog;
    console.error = origErr;
  }
  return { out: lines.join('\n'), exitCode };
}

describe('graph command — module shape', () => {
  it('exports a default function', () => {
    assert.equal(typeof graphCommand, 'function');
  });

  it('prints usage and does not throw when called with no subcommand', async () => {
    const host = makeHost();
    try {
      const { out, exitCode } = await inDir(host, () => graphCommand([]));
      assert.match(out, /kbx graph/);
      assert.match(out, /validate/);
      assert.notEqual(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('reports an unknown subcommand with a non-zero exit', async () => {
    const host = makeHost();
    try {
      const { out, exitCode } = await inDir(host, () => graphCommand(['bogus']));
      assert.match(out, /Unknown graph subcommand/);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

describe('graph validate — gates on structural errors', () => {
  it('exits 0 with ok:true on a clean, link-free single node', async () => {
    const host = makeHost();
    try {
      writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  x:\n    name: X\n');
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
      );
      const { out, exitCode } = await inDir(host, () => graphCommand(['validate', '--json']));
      const result = JSON.parse(out);
      assert.equal(result.ok, true);
      assert.equal(result.errorCount, 0);
      assert.notEqual(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits 1 when a link points at a non-existent node', async () => {
    const host = makeHost();
    try {
      writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  x:\n    name: X\n');
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\n---\n\nSee [dangling](does-not-exist) for details.\n',
      );
      const { out, exitCode } = await inDir(host, () => graphCommand(['validate', '--json']));
      const result = JSON.parse(out);
      assert.equal(result.ok, false);
      assert.ok(result.errorCount > 0);
      assert.ok(result.findings.some((f) => f.rule === 'broken-inline-link'));
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('human output (no --json) prints a validation report', async () => {
    const host = makeHost();
    try {
      writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  x:\n    name: X\n');
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
      );
      const { out } = await inDir(host, () => graphCommand(['validate']));
      assert.match(out, /Graph Validation/);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

function writePassingAssessFixture(host) {
  for (let i = 0; i < 100; i++) {
    const id = `node-${i}`;
    const targets = [];
    const seen = new Set();
    const pushTarget = (targetId) => {
      if (targetId !== id && !seen.has(targetId)) {
        targets.push(targetId);
        seen.add(targetId);
      }
    };
    const partner = i % 2 === 0 && i + 1 < 100 ? i + 1 : i - 1;
    if (partner >= 0 && partner < 100) {
      pushTarget(`node-${partner}`);
    }
    for (let offset = 1; targets.length < 5; offset++) {
      const candidate = (i + offset + (i % 2 === 0 ? 3 : 1)) % 100;
      pushTarget(`node-${candidate}`);
    }
    const body = `${'This is a long body paragraph with enough content to satisfy the content depth threshold. '.repeat(25)}\n\n${targets.map((target) => `- [${target}](${target})`).join('\n')}\n`;
    writeFileSync(
      resolve(host, 'content', `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\ncluster: core\n---\n\n${body}`,
    );
  }
}

describe('graph assess — gates when opted in', () => {
  it('exits 1 when --gate is passed and scores fall below minimums', async () => {
    const host = makeHost();
    try {
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
      );
      const { out, exitCode } = await inDir(host, () => graphCommand(['assess', '--gate', '--json']));
      const result = JSON.parse(out);
      assert.ok(result.gate, 'gate info should be populated when --gate is passed');
      assert.equal(result.gate.pass, false);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits 0 when --gate is passed and all scores meet minimums', async () => {
    const host = makeHost();
    try {
      writePassingAssessFixture(host);
      const { out, exitCode } = await inDir(host, () => graphCommand(['assess', '--gate', '--json']));
      const result = JSON.parse(out);
      assert.ok(result.gate, 'gate info should be populated when --gate is passed');
      assert.equal(result.gate.pass, true);
      assert.notEqual(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits 0 without --gate even when scores fall below minimums', async () => {
    const host = makeHost();
    try {
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
      );
      const { out, exitCode } = await inDir(host, () => graphCommand(['assess', '--json']));
      const result = JSON.parse(out);
      assert.equal(result.gate, undefined);
      assert.notEqual(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('human output prints quality scores', async () => {
    const host = makeHost();
    try {
      writeFileSync(
        resolve(host, 'content', 'home.md'),
        '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
      );
      const { out } = await inDir(host, () => graphCommand(['assess']));
      assert.match(out, /Quality Scores/);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

describe('graph derive/compare — catalogue + content-file wiring', () => {
  function makeCatalogueHost() {
    const host = makeHost();
    writeFileSync(
      resolve(host, 'content', 'catalogue.json'),
      JSON.stringify({
        nodes: [
          { id: 'alpha', title: 'Alpha', cluster: 'core', derived: true },
          { id: 'beta', title: 'Beta', cluster: 'core', authored: true },
        ],
      }),
    );
    writeFileSync(resolve(host, 'content', 'beta.md'), '# Beta\n\nauthored body.\n');
    writeFileSync(resolve(host, 'content', 'extra.md'), '# Extra\n\nnot in catalogue.\n');
    return host;
  }

  it('derive exits 1 when catalogue.json is missing', async () => {
    const host = makeHost();
    try {
      const { out, exitCode } = await inDir(host, () => graphCommand(['derive']));
      assert.match(out, /Catalogue not found/);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('derive reports the node needing generation (no authored frontmatter)', async () => {
    const host = makeCatalogueHost();
    try {
      const { out, exitCode } = await inDir(host, () => graphCommand(['derive', '--json']));
      const result = JSON.parse(out);
      assert.equal(result.total, 2);
      assert.ok(result.nodes.some((n) => n.id === 'alpha'));
      assert.notEqual(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('compare reports the extra content file not present in the catalogue', async () => {
    const host = makeCatalogueHost();
    try {
      const { out } = await inDir(host, () => graphCommand(['compare', '--json']));
      const result = JSON.parse(out);
      assert.ok(result.extraFiles.includes('extra'));
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

describe('graph enrich — manifest wiring', () => {
  it('writes catalogue-enriched.json and reports issue counts from a --manifest file', async () => {
    const host = makeHost();
    try {
      writeFileSync(
        resolve(host, 'content', 'catalogue.json'),
        JSON.stringify({ nodes: [{ id: 'alpha', title: 'Alpha', cluster: 'core' }] }),
      );
      writeFileSync(
        resolve(host, 'manifest.json'),
        JSON.stringify({
          configRaw: null,
          authoredContent: {},
          tree: [],
          readme: null,
          issues: [{ number: 1, title: 'alpha issue', body: 'about alpha', state: 'open', labels: [], url: 'https://x/1' }],
          pullRequests: [],
          commits: [],
          generatedAt: '2024-01-01T00:00:00.000Z',
        }),
      );
      const { out, exitCode } = await inDir(host, () =>
        graphCommand(['enrich', '--manifest', 'manifest.json', '--json']),
      );
      const result = JSON.parse(out);
      assert.equal(result.summary.issueCount, 1);
      assert.notEqual(exitCode, 1);
      const enrichedPath = resolve(host, 'content', 'catalogue-enriched.json');
      assert.ok(existsSync(enrichedPath));
      const onDisk = JSON.parse(readFileSync(enrichedPath, 'utf-8'));
      assert.ok(Array.isArray(onDisk.nodes));
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits 1 when catalogue.json is missing', async () => {
    const host = makeHost();
    try {
      const { out, exitCode } = await inDir(host, () => graphCommand(['enrich']));
      assert.match(out, /Catalogue not found/);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits 1 when --manifest points at a non-existent file', async () => {
    const host = makeHost();
    try {
      writeFileSync(
        resolve(host, 'content', 'catalogue.json'),
        JSON.stringify({ nodes: [] }),
      );
      const { out, exitCode } = await inDir(host, () =>
        graphCommand(['enrich', '--manifest', 'does-not-exist.json']),
      );
      assert.match(out, /Manifest not found/);
      assert.equal(exitCode, 1);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});
