/**
 * Affordance: `derive` — extract entities/relationships from an unstructured
 * source into a committed canonical JSON-LD artifact (PE1/F8 node-type contract).
 *
 * Write-class, protocol-neutral. The deterministic pipeline lives here (read
 * source → reuse-or-extract → build canonical artifact → validate → emit), but
 * the **fuzzy LLM extraction step is NOT owned by the contract**. It is supplied
 * by the caller through `context.seams.runExtraction` (the adapter or job layer
 * binds the actual `copilot -p` runtime). This is precisely the decoupling
 * required by #153: the do-seam describes the action; the runtime wiring lives
 * elsewhere.
 *
 * Two modes:
 *   - `check: true` — drift gate. Never extracts, never writes; returns whether
 *     the committed artifact is up to date. Fully offline.
 *   - default — reuses a fresh committed extraction byte-for-byte, otherwise
 *     calls `runExtraction`. If extraction is needed and no seam is supplied the
 *     action reports a typed `UNSUPPORTED` error rather than reaching for a
 *     runtime the contract must not own.
 *
 * The artifact is timestamp-free and canonical, so re-derivation of an unchanged
 * source is byte-identical (idempotent).
 *
 * @module src/affordances/operations/derive
 */

import { resolve, basename, extname, relative, isAbsolute } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';
import { readSource, IngestError } from '../../lib/ingest.js';
import {
  buildArtifact,
  canonicalStringify,
  validateArtifact,
  DEFAULT_CONTEXT,
} from '../../lib/jsonld.js';

const DEFAULT_OUT_DIR = 'content/derived';

function toPosix(p) {
  return String(p).split('\\').join('/');
}

function artifactPathFor(sourcePath, outDir) {
  const base = basename(sourcePath, extname(sourcePath));
  return resolve(outDir, `${base}.jsonld`);
}

function readArtifact(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function kbBlock(artifact) {
  return artifact?.kbx ?? artifact?.kbexplorer;
}

function buildAndStringify(document, intermediate, context) {
  const artifact = buildArtifact({
    source: {
      path: document.path,
      format: document.format,
      sha256: document.sha256,
      bytes: document.bytes,
      title: document.title,
    },
    intermediate,
    context,
  });
  return { artifact, bytes: canonicalStringify(artifact), validation: validateArtifact(artifact) };
}

/**
 * Derive a single source (or check it for drift). Pure of CLI concerns; the
 * fuzzy extractor is injected.
 *
 * @param {string} sourcePath
 * @param {object} options
 * @param {string}  options.outDir
 * @param {string}  options.cwd
 * @param {boolean} [options.check=false]
 * @param {boolean} [options.refresh=false]
 * @param {string}  [options.context=DEFAULT_CONTEXT]
 * @param {(document: object) => Promise<object>} [options.runExtraction]
 */
async function deriveOne(sourcePath, options) {
  const {
    outDir,
    cwd,
    check = false,
    refresh = false,
    context = DEFAULT_CONTEXT,
    runExtraction,
  } = options;

  const absSource = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
  const document = readSource(absSource, { cwd });
  const outPath = artifactPathFor(sourcePath, outDir);
  const relOut = toPosix(relative(cwd, outPath));
  const existing = readArtifact(outPath);
  const kb = existing ? kbBlock(existing) : null;
  const sourceFresh = kb?.source?.sha256 === document.sha256;
  const reusable = Boolean(kb?.extraction && sourceFresh && !refresh);

  const result = (status, drift, reason, built) => ({
    source: document.path,
    outPath,
    relOut,
    status,
    drift,
    reason,
    artifact: built?.artifact,
    bytes: built?.bytes,
    validation: built?.validation,
    nodeCount: built?.artifact && kbBlock(built.artifact)?.nodes?.length,
    edgeCount: built?.artifact && kbBlock(built.artifact)?.edges?.length,
  });

  // ── Drift mode: never extract, never write. ──
  if (check) {
    if (!existing) return result('drift', true, `no committed artifact at ${relOut} (run derive)`);
    if (!kb?.extraction)
      return result('drift', true, `committed ${relOut} has no embedded extraction to verify`);
    if (!sourceFresh) return result('drift', true, `source changed since derivation`);
    const expected = buildAndStringify(document, kb.extraction, context);
    if (expected.bytes !== readFileSync(outPath, 'utf-8')) {
      return result(
        'drift',
        true,
        `committed ${relOut} differs from a fresh deterministic emit`,
        expected
      );
    }
    return result('ok', false, 'up to date', expected);
  }

  // ── Derive mode. ──
  let intermediate;
  let reused = false;
  if (reusable) {
    intermediate = kb.extraction;
    reused = true;
  } else {
    if (typeof runExtraction !== 'function') {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        `derive requires a fuzzy extraction runtime for "${sourcePath}", but none was supplied ` +
          `(context.seams.runExtraction). The contract does not own the LLM runtime.`,
        { source: sourcePath }
      );
    }
    intermediate = await runExtraction(document);
  }

  const built = buildAndStringify(document, intermediate, context);
  if (!built.validation.ok) {
    throw new AffordanceError(
      ERROR_CODES.EXECUTION_FAILED,
      `Emitted JSON-LD for "${sourcePath}" failed contract validation: ${built.validation.errors.join('; ')}`,
      { validation: built.validation }
    );
  }

  const unchanged = existing && readFileSync(outPath, 'utf-8') === built.bytes;
  if (!unchanged) {
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, built.bytes, 'utf-8');
  }
  const status = unchanged ? 'unchanged' : existing ? 'updated' : 'created';
  return result(
    status,
    false,
    reused ? 'reused embedded extraction (no LLM call)' : 'extracted',
    built
  );
}

export default defineAffordance({
  name: 'derive',
  title: 'Derive entities',
  summary:
    'Extract entities/relationships from unstructured sources into committed canonical JSON-LD (or check for drift).',
  actionClass: ACTION_CLASSES.WRITE,
  input: defineSchema({
    sources: {
      type: 'array',
      item: { type: 'string' },
      required: true,
      minItems: 1,
      description: 'One or more source files (.docx / prose .md / .txt).',
    },
    out: {
      type: 'string',
      description: `Output directory for *.jsonld (default ${DEFAULT_OUT_DIR}).`,
    },
    check: {
      type: 'boolean',
      default: false,
      description: 'Drift gate: never write/extract; flag stale artifacts.',
    },
    refresh: {
      type: 'boolean',
      default: false,
      description: 'Force re-extraction even if a fresh artifact exists.',
    },
    context: { type: 'string', description: `JSON-LD @context (default ${DEFAULT_CONTEXT}).` },
  }),
  output: defineSchema({
    results: { type: 'array' },
    drift: { type: 'boolean' },
  }),
  async execute(context, input) {
    const outDir = resolve(context.cwd, input.out || DEFAULT_OUT_DIR);
    const ctxIri = input.context || DEFAULT_CONTEXT;
    const runExtraction = context.seams?.runExtraction;

    const results = [];
    for (const src of input.sources) {
      try {
        results.push(
          await deriveOne(src, {
            outDir,
            cwd: context.cwd,
            check: input.check ?? false,
            refresh: input.refresh ?? false,
            context: ctxIri,
            runExtraction,
          })
        );
      } catch (err) {
        if (err instanceof AffordanceError) throw err;
        if (err instanceof IngestError) {
          throw new AffordanceError(ERROR_CODES.INVALID_INPUT, `[${err.code}] ${err.message}`, {
            source: src,
          });
        }
        throw new AffordanceError(
          ERROR_CODES.EXECUTION_FAILED,
          `derive failed for "${src}": ${err.message}`
        );
      }
    }

    return { results, drift: results.some((r) => r.drift) };
  },
});

export { deriveOne, artifactPathFor };
