/**
 * kbx manifest — thin wrapper over the engine's buildManifest() (cli#258).
 *
 * Covers the parity-relevant shape (authoredContent/configRaw/readme written
 * to the standard <appRoot>/src/generated/repo-manifest.json path) and the
 * `--check` drift gate: in-sync exits 0, drifted content exits non-zero and
 * reports the drifted field, mirroring `kbx connect --check`/`kbx derive --check`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mod = await import('../../src/commands/manifest.ts');
const manifestCommand = mod.default;

function makeHost() {
  const host = mkdtempSync(join(tmpdir(), 'kbx-manifest-'));
  mkdirSync(resolve(host, 'content'), { recursive: true });
  writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  - id: x\n    label: X\n');
  writeFileSync(
    resolve(host, 'content', 'home.md'),
    '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n',
  );
  writeFileSync(resolve(host, 'README.md'), '# host readme\n');
  const app = resolve(host, '.kbx');
  mkdirSync(resolve(app, 'src', 'generated'), { recursive: true });
  writeFileSync(resolve(app, 'package.json'), '{"name":"kbexplorer-template"}');
  return { host, app };
}

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

describe('manifest command — module shape', () => {
  it('exports a default function', () => {
    assert.equal(typeof manifestCommand, 'function');
  });
});

describe('manifest command — build (thin over buildManifest())', () => {
  it('writes the manifest to <appRoot>/src/generated/repo-manifest.json', async () => {
    const { host, app } = makeHost();
    const outPath = resolve(app, 'src', 'generated', 'repo-manifest.json');
    try {
      await inDir(host, () => manifestCommand([]));
      assert.ok(existsSync(outPath));
      const onDisk = JSON.parse(readFileSync(outPath, 'utf-8'));
      assert.equal(typeof onDisk.authoredContent, 'object');
      assert.ok(Object.keys(onDisk.authoredContent).some((k) => k.endsWith('home.md')));
      assert.equal(onDisk.readme.trim(), '# host readme');
      assert.match(onDisk.configRaw, /clusters:/);
      // No live-GitHub fetching from a FileSystemSource — accepted trade-off (cli#258).
      assert.deepEqual(onDisk.issues, []);
      assert.deepEqual(onDisk.pullRequests, []);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

describe('manifest command — --check', () => {
  it('exits 0 and reports in sync when nothing has changed', async () => {
    const { host, app } = makeHost();
    try {
      await inDir(host, () => manifestCommand([]));
      const out = await inDir(host, () => manifestCommand(['--check']));
      assert.match(out, /up to date/i);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('exits non-zero and reports drift when content changed after the last build', async () => {
    const { host, app } = makeHost();
    let exitCode = null;
    const origExit = process.exit;
    process.exit = (c) => { exitCode = c; throw new Error('__exit__'); };
    try {
      await inDir(host, () => manifestCommand([]));
      // Drift the source: add a new authored file after the manifest was written.
      writeFileSync(
        resolve(host, 'content', 'extra.md'),
        '---\nid: extra\ntitle: Extra\ncluster: x\nconnections: []\n---\n\nnew\n',
      );
      const out = await inDir(host, async () => {
        try {
          await manifestCommand(['--check']);
        } catch (e) {
          if (e.message !== '__exit__') throw e;
        }
      });
      assert.equal(exitCode, 1);
      assert.match(out, /drift/i);
      assert.match(out, /authoredContent/);
    } finally {
      process.exit = origExit;
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('does not treat generatedAt/issues/pullRequests/commits/releases as drift', async () => {
    const { host, app } = makeHost();
    const outPath = resolve(app, 'src', 'generated', 'repo-manifest.json');
    try {
      await inDir(host, () => manifestCommand([]));
      const onDisk = JSON.parse(readFileSync(outPath, 'utf-8'));
      // Simulate a stale generatedAt / previously-populated GitHub fields —
      // none of these should trip --check (cli#258's "CRITICAL NUANCE").
      onDisk.generatedAt = '2000-01-01T00:00:00.000Z';
      onDisk.issues = [{ number: 1, title: 'stale', body: '', state: 'open', labels: [], html_url: '', created_at: '', updated_at: '' }];
      writeFileSync(outPath, JSON.stringify(onDisk, null, 2), 'utf-8');
      const out = await inDir(host, () => manifestCommand(['--check']));
      assert.match(out, /up to date/i);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});
