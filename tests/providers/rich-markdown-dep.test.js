import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_API_VERSION,
  checkProviderCompatibility,
} from '@anokye-labs/kbexplorer-core';

// Integration test: prove the CLI loads the rich-Markdown provider through the
// *dependency* (the bare package specifier), exactly as a `config.yaml` ->
// `defineProvider()` entry would resolve it. The provider itself lives in
// @anokye-labs/kbexplorer-provider-rich-markdown; this guards that the CLI's
// install of that package stays wired and functional end-to-end.
const providerMod = await import('@anokye-labs/kbexplorer-provider-rich-markdown');
const libMod = await import('@anokye-labs/kbexplorer-provider-rich-markdown/lib');

const provider = providerMod.default;

const INLINE = '---\nid: inline-doc\nentityType: note\n---\n# Inline\n\nLinks to [a](kg://target){rel=leads}.\n';

describe('rich-markdown provider — loaded via the package dependency', () => {
  it('default-exports a defineProvider() factory targeting the host API version', () => {
    assert.equal(typeof provider, 'function');
    assert.equal(providerMod.apiVersion, PROVIDER_API_VERSION);
    assert.ok(Array.isArray(providerMod.capabilities));
    const { compatible } = checkProviderCompatibility(
      { apiVersion: providerMod.apiVersion, capabilities: providerMod.capabilities },
      { capabilities: providerMod.capabilities },
    );
    assert.equal(compatible, true);
  });

  it('resolves inline content into a node + typed edges through the dependency', async () => {
    const instance = provider({ name: 'Docs', cluster: 'docs', options: { content: INLINE } });
    const { nodes, edges } = await instance.resolve({ config: {} });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].data.id, 'inline-doc');
    assert.equal(nodes[0].cluster, 'docs');
    assert.equal(nodes[0].entityType, 'note');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].relation, 'leads');
    assert.equal(edges[0].to, 'kg://target');
  });

  it('exposes the pure ingestion library on the ./lib subpath', () => {
    assert.equal(typeof libMod.ingestRichMarkdown, 'function');
    const { nodes } = libMod.ingestRichMarkdown({ content: INLINE, cluster: 'docs' });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].data.id, 'inline-doc');
  });
});
