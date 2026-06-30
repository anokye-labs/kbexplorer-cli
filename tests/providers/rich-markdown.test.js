import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROVIDER_API_VERSION,
  checkProviderCompatibility,
  buildAddress,
} from '@anokye-labs/kbexplorer-core';

const mod = await import('../../src/providers/rich-markdown.js');
const provider = mod.default;
const { apiVersion, capabilities, resolveIdentityOptions, RichMarkdownError, RichMarkdownErrorCode } = mod;

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');

const INLINE = '---\nid: inline-doc\nentityType: note\n---\n# Inline\n\nLinks to [a](kg://target){rel=leads}.\n';

describe('rich-markdown provider — module contract', () => {
  it('default-exports a provider factory', () => {
    assert.equal(typeof provider, 'function');
  });

  it('declares the provider API version and graph capabilities', () => {
    assert.equal(apiVersion, PROVIDER_API_VERSION);
    assert.deepEqual([...capabilities], ['graph:nodes', 'graph:edges']);
    assert.ok(Object.isFrozen(capabilities));
  });

  it('is compatible with a host that supports its capabilities', () => {
    const verdict = checkProviderCompatibility(
      { apiVersion, capabilities },
      { apiVersion: PROVIDER_API_VERSION, capabilities: ['graph:nodes', 'graph:edges', 'sources'] },
    );
    assert.equal(verdict.compatible, true);
  });

  it('is flagged incompatible when the host lacks a required capability', () => {
    const verdict = checkProviderCompatibility(
      { apiVersion, capabilities },
      { apiVersion: PROVIDER_API_VERSION, capabilities: ['graph:nodes'] },
    );
    assert.equal(verdict.compatible, false);
    assert.match(verdict.reason, /graph:edges/);
  });

  it('builds a provider with an id, name and resolve()', () => {
    const p = provider({ name: 'My Docs', options: { content: INLINE } });
    assert.equal(p.id, 'rich-markdown-my-docs');
    assert.equal(p.name, 'My Docs');
    assert.equal(typeof p.resolve, 'function');
  });

  it('defaults the id when unnamed', () => {
    assert.equal(provider({ options: { content: INLINE } }).id, 'rich-markdown');
  });
});

describe('rich-markdown provider — resolve()', () => {
  it('ingests inline content into a node + typed edges (no filesystem)', async () => {
    const p = provider({ cluster: 'docs', options: { content: INLINE, sourcePath: 'inline.md' } });
    const { nodes, edges } = await p.resolve({ config: {} });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].cluster, 'docs');
    assert.equal(nodes[0].provider, 'rich-markdown');
    assert.equal(nodes[0].entityType, 'note');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].relation, 'leads');
    assert.equal(edges[0].to, 'kg://target');
  });

  it('reads a Markdown file from disk via options.path + cwd', async () => {
    const p = provider({
      options: { path: 'docs/samples/rich-markdown-sample.md', cwd: REPO_ROOT },
    });
    const { nodes, edges } = await p.resolve({ config: {} });
    assert.equal(nodes[0].data.id, 'rich-markdown-sample');
    assert.ok(nodes[0].data.richMarkdown.blocks.length === 4);
    assert.ok(edges.length >= 3);
  });

  it('applies config.identity scheme/authority to the minted address', async () => {
    const p = provider({ options: { content: INLINE } });
    const { nodes } = await p.resolve({
      config: { identity: { scheme: 'kb', authority: 'corp' } },
    });
    assert.equal(nodes[0].id, buildAddress('inline-doc', { scheme: 'kb', authority: 'corp' }));
  });

  it('lets provider options override config.identity', async () => {
    const p = provider({ options: { content: INLINE, scheme: 'org-kb', authority: 'docs' } });
    const { nodes } = await p.resolve({
      config: { identity: { scheme: 'kb', authority: 'corp' } },
    });
    assert.equal(nodes[0].id, buildAddress('inline-doc', { scheme: 'org-kb', authority: 'docs' }));
  });
});

describe('rich-markdown provider — resolveIdentityOptions', () => {
  it('prefers options, then per-source authority, then default authority', () => {
    const kb = {
      identity: { scheme: 'kb', authority: 'global', sourceAuthorities: { 'rich-markdown': 'docs' } },
    };
    assert.deepEqual(resolveIdentityOptions({}, kb), { scheme: 'kb', authority: 'docs' });
    assert.deepEqual(resolveIdentityOptions({ authority: 'override' }, kb), {
      scheme: 'kb',
      authority: 'override',
    });
    assert.deepEqual(
      resolveIdentityOptions({ sourceAuthorityKey: 'missing' }, kb),
      { scheme: 'kb', authority: 'global' },
    );
  });

  it('returns an empty object when no identity config is present', () => {
    assert.deepEqual(resolveIdentityOptions({}, {}), {});
  });
});

describe('rich-markdown provider — errors', () => {
  it('throws NO_SOURCE when neither path nor content is given', async () => {
    const p = provider({ options: {} });
    await assert.rejects(
      () => p.resolve({ config: {} }),
      (e) => e instanceof RichMarkdownError && e.code === RichMarkdownErrorCode.NO_SOURCE,
    );
  });

  it('throws READ_FAILED when the source file is missing', async () => {
    const p = provider({ options: { path: 'does/not/exist.md', cwd: REPO_ROOT } });
    await assert.rejects(
      () => p.resolve({ config: {} }),
      (e) => e instanceof RichMarkdownError && e.code === RichMarkdownErrorCode.READ_FAILED,
    );
  });
});
