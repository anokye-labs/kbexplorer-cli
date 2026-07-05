import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { buildViteEnv } = await import('../../src/commands/build.ts');
const { writeHostManifest } = await import('../../src/commands/dev.ts');

describe('build command — host-root threading (regression for silent wrong-content ship)', () => {
  it('buildViteEnv threads VITE_KB_HOST_ROOT at the host repo (not the template)', () => {
    const cwd = '/some/host/repo';
    const env = buildViteEnv(cwd);
    // The bug: build omitted VITE_KB_HOST_ROOT, so the template's vite plugin
    // fell back to its own directory and baked the template's demo content into
    // dist/. The build MUST tell vite to render the HOST repo.
    assert.equal(env.VITE_KB_HOST_ROOT, cwd, 'VITE_KB_HOST_ROOT must equal the host cwd');
    assert.equal(env.VITE_KB_LOCAL, 'true');
    assert.equal(env.VITE_ENV_DIR, cwd);
    // This is exactly what `dev` sets — the two commands must be identical here.
  });

  it('buildViteEnv forwards --base as VITE_BASE_PATH only when provided', () => {
    assert.equal(buildViteEnv('/x').VITE_BASE_PATH, undefined);
    assert.equal(buildViteEnv('/x', '/my-kb/').VITE_BASE_PATH, '/my-kb/');
  });

  it('A/B: the manifest build reflects HOST authored content, not the template', async () => {
    // Host repo with its own authored content; a vendored template skeleton.
    const host = mkdtempSync(join(tmpdir(), 'kb-build-'));
    try {
      mkdirSync(resolve(host, 'content'), { recursive: true });
      writeFileSync(resolve(host, 'content', 'config.yaml'), 'clusters:\n  - id: x\n    label: X\n');
      writeFileSync(
        resolve(host, 'content', 'host-only.md'),
        '---\nid: host-only\ntitle: Host Only\ncluster: x\nconnections: []\n---\n\nhost body\n',
      );
      writeFileSync(resolve(host, 'README.md'), '# host readme\n');
      const app = resolve(host, '.kbx');
      mkdirSync(resolve(app, 'src', 'generated'), { recursive: true });
      writeFileSync(resolve(app, 'package.json'), '{"name":"kbexplorer-template"}');

      const origCwd = process.cwd();
      process.chdir(host);
      try {
        // build reuses writeHostManifest — the same host-root path as dev.
        const { outPath } = await writeHostManifest(process.cwd(), app);
        const onDisk = JSON.parse(readFileSync(outPath, 'utf-8'));
        // Manifest must carry the HOST's authored node, proving the host root
        // (not the template dir) was used.
        assert.ok(
          Object.keys(onDisk.authoredContent).some((k) => k.endsWith('host-only.md')),
          'manifest must contain the host authored content',
        );
        assert.equal(onDisk.readme.trim(), '# host readme');
        assert.ok(existsSync(outPath));
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
});
