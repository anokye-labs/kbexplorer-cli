/**
 * Rich-Markdown provider (Wave 0b / kbexplorer-cli#133).
 *
 * A loadable `defineProvider()` module that ingests ONE Markdown document into a
 * {@link KBGraph} fragment. It is the thin, impure boundary around the pure
 * ingestion library (`../lib/rich-markdown.js`): it reads the source bytes and
 * resolves identity configuration, then delegates all parsing/extraction to the
 * library so the deterministic core stays free of I/O.
 *
 * Configuration (via the provider's {@link ExternalProviderConfig}):
 *   options.path     — repo-relative path to the Markdown file to ingest.
 *   options.content  — inline Markdown (alternative to `path`; useful in tests).
 *   options.sourcePath — provenance label when `content` is supplied inline.
 *   options.cwd      — base directory for resolving `path` (default process.cwd()).
 *   options.scheme / options.authority — identity address overrides.
 *   options.sourceAuthorityKey — key into `config.identity.sourceAuthorities`.
 *   options.entityType — override the node's entity type (else read from frontmatter).
 *   cluster          — cluster id assigned to the produced node.
 *
 * Identity scheme/authority resolve from the provider options first, then the
 * knowledge base's `config.identity` block (an additive v0.1.0 contract), then
 * the core defaults (`kg://`, no authority).
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  defineProvider,
  PROVIDER_API_VERSION,
  slugify,
} from '@anokye-labs/kbexplorer-core';
import { ingestRichMarkdown } from '../lib/rich-markdown.js';

/** Stable error codes for provider configuration failures. */
export const RichMarkdownErrorCode = Object.freeze({
  NO_SOURCE: 'RICHMD_NO_SOURCE',
  READ_FAILED: 'RICHMD_READ_FAILED',
});

/** Error thrown when the provider is misconfigured or its source can't be read. */
export class RichMarkdownError extends Error {
  constructor(message, { code = RichMarkdownErrorCode.NO_SOURCE, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RichMarkdownError';
    this.code = code;
  }
}

/**
 * Resolve identity addressing options from the provider config + the KB config.
 * Provider options win; then `config.identity` (per-source authority, then the
 * default authority); then core defaults.
 *
 * @param {object} providerOptions  the provider's `options` block.
 * @param {object} [kbConfig]       the resolved {@link KBConfig}.
 * @returns {{ scheme?: string, authority?: string }}
 */
export function resolveIdentityOptions(providerOptions = {}, kbConfig = {}) {
  const identity = kbConfig?.identity ?? {};
  const sourceKey = providerOptions.sourceAuthorityKey ?? 'rich-markdown';
  const authority =
    providerOptions.authority ??
    identity.sourceAuthorities?.[sourceKey] ??
    identity.authority;
  const scheme = providerOptions.scheme ?? identity.scheme;
  const out = {};
  if (scheme != null) out.scheme = scheme;
  if (authority != null) out.authority = authority;
  return out;
}

/**
 * Load the Markdown source described by the provider options.
 * @returns {{ content: string, path: string | undefined }}
 */
function loadSource(options) {
  if (typeof options.content === 'string') {
    return { content: options.content, path: options.sourcePath };
  }
  if (typeof options.path === 'string' && options.path) {
    const cwd = options.cwd ?? process.cwd();
    const abs = resolvePath(cwd, options.path);
    try {
      return { content: readFileSync(abs, 'utf-8'), path: options.path };
    } catch (err) {
      throw new RichMarkdownError(
        `rich-markdown provider could not read source "${options.path}": ${err.message}`,
        { code: RichMarkdownErrorCode.READ_FAILED, cause: err },
      );
    }
  }
  throw new RichMarkdownError(
    'rich-markdown provider requires `options.path` (a Markdown file) or `options.content` (inline Markdown).',
    { code: RichMarkdownErrorCode.NO_SOURCE },
  );
}

/**
 * The provider factory. Exposed as the module's default export wrapped in
 * `defineProvider` so a host can recognize and type-check it.
 */
const richMarkdownProvider = defineProvider((config = {}) => {
  const options = config.options ?? {};
  const id = options.id ?? (config.name ? `rich-markdown-${slugify(config.name)}` : 'rich-markdown');
  return {
    id,
    name: config.name ?? 'Rich-Markdown Provider',
    requiredAffordances: [],
    async resolve(context = {}) {
      const { content, path } = loadSource(options);
      const identity = resolveIdentityOptions(options, context.config ?? {});
      const cluster = config.cluster ?? options.cluster ?? 'default';
      return ingestRichMarkdown({
        content,
        path,
        identity,
        cluster,
        providerId: id,
        entityType: options.entityType,
      });
    },
  };
});

export default richMarkdownProvider;

/** The provider-contract API version this module targets (see core's PROVIDER_API_VERSION). */
export const apiVersion = PROVIDER_API_VERSION;

/** Capabilities this provider needs the host engine to support. */
export const capabilities = Object.freeze(['graph:nodes', 'graph:edges']);
