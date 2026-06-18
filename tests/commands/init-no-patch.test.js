import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'src', 'commands');

/**
 * Gap F-cleanup (#78): template #220 landed — the template's detectHostRoot()
 * now honors VITE_KB_HOST_ROOT, so the CLI must NOT string-patch the vendored
 * template's generate-manifest.js. These tests pin that the dead patch stays
 * removed and that init no longer mutates the manifest script.
 */
describe('init/update no longer patch the template manifest script (#78)', () => {
  const initSrc = readFileSync(resolve(SRC, 'init.js'), 'utf-8');
  const updateSrc = readFileSync(resolve(SRC, 'update.js'), 'utf-8');

  it('init.js does not define or call patchTemplateManifestScript', () => {
    assert.doesNotMatch(initSrc, /patchTemplateManifestScript/);
  });

  it('init.js no longer mutates generate-manifest.js (no string-replace patch)', () => {
    assert.doesNotMatch(initSrc, /VITE_KB_HOST_ROOT patch/);
    assert.doesNotMatch(initSrc, /const hostRoot = detectHostRoot\(\);/);
    // It must not write to a generate-manifest.js script.
    assert.doesNotMatch(initSrc, /generate-manifest\.js/);
  });

  it('update.js no longer imports or calls the removed patch helper', () => {
    assert.doesNotMatch(updateSrc, /patchTemplateManifestScript/);
  });

  it('init module loads cleanly with the helper removed', async () => {
    const mod = await import('../../src/commands/init.js');
    assert.equal(typeof mod.default, 'function');
    assert.equal('patchTemplateManifestScript' in mod, false);
  });
});
