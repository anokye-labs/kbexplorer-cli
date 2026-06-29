import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { writeHostManifest, manifestOutPath, watchPaths } = await import('../../src/commands/dev.js');

function makeHostWithVendoredTemplate() {
  const host = mkdtempSync(join(tmpdir(), 'kb-dev-'));
  // Minimal host content
  mkdirSync(resolve(host, 'content'), { recursive: true });
  writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  - id: x\n    label: X\n');
  writeFileSync(
    resolve(host, 'content', 'home.md'),
    '---\nid: home\ntitle: Home\ncluster: x\nconnections: []\n---\n\nbody\n'
  );
  writeFileSync(resolve(host, 'README.md'), '# host readme\n');
  // Vendored .kbexplorer skeleton
  const app = resolve(host, '.kbx');
  mkdirSync(resolve(app, 'src', 'generated'), { recursive: true });
  writeFileSync(resolve(app, 'package.json'), '{"name":"kbexplorer-template"}');
  return { host, app };
}

describe('dev command helpers', () => {
  it('manifestOutPath points at .kbx/src/generated/repo-manifest.json', () => {
    const { app } = makeHostWithVendoredTemplate();
    try {
      const p = manifestOutPath(app);
      assert.ok(p.endsWith(join('src', 'generated', 'repo-manifest.json')));
    } finally {
      rmSync(resolve(app, '..'), { recursive: true, force: true });
    }
  });

  it('writeHostManifest writes host content into the template manifest path', async () => {
    const { host, app } = makeHostWithVendoredTemplate();
    try {
      const origCwd = process.cwd();
      process.chdir(host);
      try {
        const { outPath, manifest } = await writeHostManifest(process.cwd(), app);
        assert.ok(existsSync(outPath));
        const onDisk = JSON.parse(readFileSync(outPath, 'utf-8'));
        assert.equal(typeof onDisk.authoredContent, 'object');
        // Manifest contains HOST content (home.md), not template stock
        assert.ok(Object.keys(onDisk.authoredContent).some((k) => k.endsWith('home.md')));
        assert.equal(onDisk.readme.trim(), '# host readme');
        // Returned manifest matches on-disk content for the keys we care about
        assert.deepEqual(Object.keys(manifest.authoredContent), Object.keys(onDisk.authoredContent));
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it('watchPaths returns only paths that exist in the host', () => {
    const { host } = makeHostWithVendoredTemplate();
    try {
      const paths = watchPaths(host);
      assert.ok(paths.some((p) => p.endsWith('content')));
      assert.ok(paths.some((p) => p.endsWith('README.md')));
      // .kbx.json doesn't exist in this fixture → filtered out
      assert.ok(!paths.some((p) => p.endsWith('.kbx.json')));
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});

