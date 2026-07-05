/**
 * Composite-ingestion configuration (E2-M1 / issue #134).
 *
 * Parses and validates the host-level, *additive* `KbxCompositeConfig` that
 * declares the multiple sources/providers a single knowledge base is composed
 * from. The shape is intentionally small and forward-compatible:
 *
 *   {
 *     "sources": [
 *       {
 *         "sourceId":   "docs",                  // unique, stable id
 *         "kind":       "rich-markdown",         // advisory provider type
 *         "module":     "@scope/provider-pkg",   // ES specifier of the factory
 *         "options":    { "cluster": "docs" },   // provider-specific options
 *         "credentials":{ "token": "GH_TOKEN" }  // logical key -> ENV VAR NAME
 *       }
 *     ],
 *     "ingestion": {
 *       "failureMode": "fail-fast" | "best-effort",
 *       "concurrency": 1,
 *       "budgets":     { "maxSources", "maxNodes", "maxEdges", "timeoutMs" }
 *     }
 *   }
 *
 * The block may be nested under a top-level `kbx` key (so it can live alongside
 * other host config) or supplied at the root — both are accepted.
 *
 * Credentials are referenced **by environment-variable name only**; the secret
 * value is resolved from `env` at normalization time and never persisted. A
 * missing env var is not fatal here (the provider decides whether it is
 * required) — it is surfaced as a structured warning instead.
 *
 * Pure & deterministic: no filesystem, no network, no dynamic import. The engine
 * ({@link module:lib/composite-ingest}) consumes the normalized result.
 *
 * @module lib/composite-config
 */

import { normalizeAccessLabel } from './access-label.ts';

/** Stable error codes for composite-config validation failures. */
export const CompositeConfigErrorCode = Object.freeze({
  INVALID: 'KBX_COMPOSITE_INVALID',
  DUPLICATE_SOURCE: 'KBX_COMPOSITE_DUPLICATE_SOURCE',
  MISSING_RESOLVER: 'KBX_COMPOSITE_MISSING_RESOLVER',
  INVALID_FAILURE_MODE: 'KBX_COMPOSITE_INVALID_FAILURE_MODE',
  INVALID_BUDGET: 'KBX_COMPOSITE_INVALID_BUDGET',
});

/** Error thrown when a composite config is structurally invalid. */
export class CompositeConfigError extends Error {
  constructor(message, { code = CompositeConfigErrorCode.INVALID, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CompositeConfigError';
    this.code = code;
  }
}

/** The two supported ingestion failure modes. */
export const FAILURE_MODES = Object.freeze(['fail-fast', 'best-effort']);

/** Default ingestion policy applied when the `ingestion` block is omitted. */
export const DEFAULT_INGESTION = Object.freeze({
  failureMode: 'fail-fast',
  concurrency: 1,
  budgets: Object.freeze({}),
});

/** Budget keys understood by the engine (all optional, all positive integers). */
const BUDGET_KEYS = Object.freeze(['maxSources', 'maxNodes', 'maxEdges', 'timeoutMs']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** Pull the composite block out of either `{ kbx: {...} }` or a root object. */
function unwrap(raw) {
  if (!isPlainObject(raw)) {
    throw new CompositeConfigError('Composite config must be an object.', {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  // Prefer an explicit `kbx` envelope; fall back to the root object.
  if (
    isPlainObject(raw.kbx) &&
    (Array.isArray(raw.kbx.sources) || isPlainObject(raw.kbx.ingestion))
  ) {
    return raw.kbx;
  }
  return raw;
}

/**
 * Resolve a source's `credentials` map (logical key → ENV VAR NAME) into actual
 * values from `env`. Returns `{ resolved, warnings }`; a missing env var yields a
 * warning and an absent key (never throws — the provider decides if required).
 *
 * @param {string} sourceId
 * @param {unknown} credentials
 * @param {Record<string,string|undefined>} env
 * @returns {{ resolved: Record<string,string>, envNames: Record<string,string>, warnings: string[] }}
 */
function resolveCredentials(sourceId, credentials, env) {
  const resolved = {};
  const envNames = {};
  const warnings = [];
  if (credentials == null) return { resolved, envNames, warnings };
  if (!isPlainObject(credentials)) {
    throw new CompositeConfigError(
      `Source "${sourceId}": "credentials" must be a { logicalKey: ENV_VAR_NAME } map.`,
      { code: CompositeConfigErrorCode.INVALID }
    );
  }
  for (const [key, envName] of Object.entries(credentials)) {
    if (typeof envName !== 'string' || !envName) {
      throw new CompositeConfigError(
        `Source "${sourceId}": credential "${key}" must map to a non-empty env var name.`,
        { code: CompositeConfigErrorCode.INVALID }
      );
    }
    envNames[key] = envName;
    const value = env[envName];
    if (value == null || value === '') {
      warnings.push(
        `Source "${sourceId}": credential "${key}" env var "${envName}" is unset; ` +
          'the provider will receive no value for it.'
      );
      continue;
    }
    resolved[key] = value;
  }
  return { resolved, envNames, warnings };
}

/**
 * Validate and normalize one `sources[]` entry.
 *
 * @param {unknown} entry
 * @param {number} index
 * @param {Record<string,string|undefined>} env
 */
function normalizeSource(entry, index, env) {
  if (!isPlainObject(entry)) {
    throw new CompositeConfigError(`sources[${index}] must be an object.`, {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  const sourceId = entry.sourceId ?? entry.id;
  if (typeof sourceId !== 'string' || !sourceId.trim()) {
    throw new CompositeConfigError(`sources[${index}] requires a non-empty "sourceId".`, {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  const kind = entry.kind ?? entry.type;
  if (kind != null && typeof kind !== 'string') {
    throw new CompositeConfigError(`Source "${sourceId}": "kind" must be a string when set.`, {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  if (entry.module != null && (typeof entry.module !== 'string' || !entry.module.trim())) {
    throw new CompositeConfigError(
      `Source "${sourceId}": "module" must be a non-empty string when set.`,
      {
        code: CompositeConfigErrorCode.INVALID,
      }
    );
  }
  // A source must be resolvable to a provider: either a module specifier (the
  // engine dynamic-imports it) or a `kind` a host-supplied resolver understands.
  if (entry.module == null && kind == null) {
    throw new CompositeConfigError(
      `Source "${sourceId}": specify a "module" (ES specifier) or a "kind" so the engine can resolve a provider.`,
      { code: CompositeConfigErrorCode.MISSING_RESOLVER }
    );
  }
  if (entry.options != null && !isPlainObject(entry.options)) {
    throw new CompositeConfigError(`Source "${sourceId}": "options" must be an object when set.`, {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  // Optional access label (a KBAccessLabel): every node/edge this source produces
  // inherits it unless the node/edge already carries its own label. Label-only —
  // the host enforces. An empty/garbage block normalizes away to no label.
  if (entry.access != null && !isPlainObject(entry.access)) {
    throw new CompositeConfigError(
      `Source "${sourceId}": "access" must be a KBAccessLabel object when set.`,
      { code: CompositeConfigErrorCode.INVALID }
    );
  }
  const access = normalizeAccessLabel(entry.access);
  const { resolved, envNames, warnings } = resolveCredentials(sourceId, entry.credentials, env);
  return {
    source: {
      sourceId: sourceId.trim(),
      kind: kind ?? null,
      module: entry.module ?? null,
      options: entry.options ? { ...entry.options } : {},
      cluster: typeof entry.cluster === 'string' ? entry.cluster : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      ...(access ? { access } : {}),
      credentials: resolved,
      credentialEnv: envNames,
    },
    warnings,
  };
}

/** Validate and normalize the `ingestion` policy block. */
function normalizeIngestion(raw) {
  if (raw == null) return { ...DEFAULT_INGESTION, budgets: {} };
  if (!isPlainObject(raw)) {
    throw new CompositeConfigError('"ingestion" must be an object when set.', {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  const failureMode = raw.failureMode ?? DEFAULT_INGESTION.failureMode;
  if (!FAILURE_MODES.includes(failureMode)) {
    throw new CompositeConfigError(
      `"ingestion.failureMode" must be one of ${FAILURE_MODES.join(' | ')} (got ${JSON.stringify(failureMode)}).`,
      { code: CompositeConfigErrorCode.INVALID_FAILURE_MODE }
    );
  }
  let concurrency = DEFAULT_INGESTION.concurrency;
  if (raw.concurrency != null) {
    if (!isPositiveInt(raw.concurrency)) {
      throw new CompositeConfigError('"ingestion.concurrency" must be a positive integer.', {
        code: CompositeConfigErrorCode.INVALID,
      });
    }
    concurrency = raw.concurrency;
  }
  const budgets = {};
  if (raw.budgets != null) {
    if (!isPlainObject(raw.budgets)) {
      throw new CompositeConfigError('"ingestion.budgets" must be an object when set.', {
        code: CompositeConfigErrorCode.INVALID_BUDGET,
      });
    }
    for (const [key, value] of Object.entries(raw.budgets)) {
      if (!BUDGET_KEYS.includes(key)) {
        throw new CompositeConfigError(
          `Unknown budget "${key}". Supported: ${BUDGET_KEYS.join(', ')}.`,
          { code: CompositeConfigErrorCode.INVALID_BUDGET }
        );
      }
      if (!isPositiveInt(value)) {
        throw new CompositeConfigError(`"ingestion.budgets.${key}" must be a positive integer.`, {
          code: CompositeConfigErrorCode.INVALID_BUDGET,
        });
      }
      budgets[key] = value;
    }
  }
  return { failureMode, concurrency, budgets };
}

/**
 * Normalize a raw `KbxCompositeConfig` into a validated, engine-ready shape.
 *
 * @param {unknown} raw   Parsed config object (root or `{ kbx: {...} }`).
 * @param {{ env?: Record<string,string|undefined> }} [opts]
 * @returns {{
 *   sources: Array<{ sourceId:string, kind:string|null, module:string|null,
 *                    options:object, cluster?:string, name?:string,
 *                    credentials:Record<string,string>, credentialEnv:Record<string,string> }>,
 *   ingestion: { failureMode:string, concurrency:number, budgets:object },
 *   warnings: string[]
 * }}
 * @throws {CompositeConfigError}
 */
export function normalizeCompositeConfig(raw, opts = {}) {
  const env = opts.env ?? process.env;
  const block = unwrap(raw);
  if (!Array.isArray(block.sources)) {
    throw new CompositeConfigError('Composite config requires a "sources" array.', {
      code: CompositeConfigErrorCode.INVALID,
    });
  }
  if (block.sources.length === 0) {
    throw new CompositeConfigError('Composite config "sources" must declare at least one source.', {
      code: CompositeConfigErrorCode.INVALID,
    });
  }

  const sources = [];
  const warnings = [];
  const seen = new Set();
  block.sources.forEach((entry, index) => {
    const { source, warnings: w } = normalizeSource(entry, index, env);
    if (seen.has(source.sourceId)) {
      throw new CompositeConfigError(`Duplicate sourceId "${source.sourceId}".`, {
        code: CompositeConfigErrorCode.DUPLICATE_SOURCE,
      });
    }
    seen.add(source.sourceId);
    sources.push(source);
    warnings.push(...w);
  });

  return { sources, ingestion: normalizeIngestion(block.ingestion), warnings };
}
