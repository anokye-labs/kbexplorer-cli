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
} from '../contract.ts';
import { readSource, IngestError } from '../../lib/ingest.ts';
import {
  buildArtifact,
  canonicalStringify,
  validateArtifact,
  DEFAULT_CONTEXT,
} from '../../lib/jsonld.ts';
import type { AffordanceContext, ExtractionIntermediate } from '../context.ts';

const DEFAULT_OUT_DIR = 'content/derived';

type IngestedDocument = ReturnType<typeof readSource>;
type BuiltArtifact = {
  artifact: ReturnType<typeof buildArtifact>;
  bytes: string;
  validation: ReturnType<typeof validateArtifact>;
};

interface DerivedKbBlock {
  source?: {
    sha256?: string;
  };
  extraction?: ExtractionIntermediate;
  nodes?: unknown[];
  edges?: unknown[];
}

interface DeriveOneOptions {
  outDir: string;
  cwd: string;
  check?: boolean;
  refresh?: boolean;
  context?: string;
  runExtraction?: ((document: IngestedDocument) => Promise<ExtractionIntermediate>) | undefined;
}

interface DeriveResult {
  source: string;
  outPath: string;
  relOut: string;
  status: string;
  drift: boolean;
  reason: string;
  artifact?: ReturnType<typeof buildArtifact>;
  bytes?: string;
  validation?: ReturnType<typeof validateArtifact>;
  nodeCount?: number;
  edgeCount?: number;
}

interface DeriveInput extends Record<string, unknown> {
  sources: string[];
  out?: string;
  check?: boolean;
  refresh?: boolean;
  context?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExtractionIntermediate(value: unknown): value is ExtractionIntermediate {
  return isRecord(value) && Array.isArray(value.entities) && Array.isArray(value.relationships);
}

function toPosix(path: string): string {
  return String(path).split('\\').join('/');
}

function artifactPathFor(sourcePath: string, outDir: string): string {
  const base = basename(sourcePath, extname(sourcePath));
  return resolve(outDir, `${base}.jsonld`);
}

function readArtifact(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function kbBlock(artifact: Record<string, unknown> | null): DerivedKbBlock | null {
  if (!artifact) return null;
  const block = artifact.kbx ?? artifact.kbexplorer;
  return isRecord(block) ? (block as DerivedKbBlock) : null;
}

function buildAndStringify(
  document: IngestedDocument,
  intermediate: ExtractionIntermediate,
  context: string,
): BuiltArtifact {
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
async function deriveOne(sourcePath: string, options: DeriveOneOptions): Promise<DeriveResult> {
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
  const kb = kbBlock(existing);
  const sourceFresh = kb?.source?.sha256 === document.sha256;
  const reusable = Boolean(isExtractionIntermediate(kb?.extraction) && sourceFresh && !refresh);

  const result = (status: string, drift: boolean, reason: string, built?: BuiltArtifact): DeriveResult => ({
    source: document.path,
    outPath,
    relOut,
    status,
    drift,
    reason,
    artifact: built?.artifact,
    bytes: built?.bytes,
    validation: built?.validation,
    nodeCount: built?.artifact ? kbBlock(built.artifact as unknown as Record<string, unknown>)?.nodes?.length : undefined,
    edgeCount: built?.artifact ? kbBlock(built.artifact as unknown as Record<string, unknown>)?.edges?.length : undefined,
  });

  // ── Drift mode: never extract, never write. ──
  if (check) {
    if (!existing) return result('drift', true, `no committed artifact at ${relOut} (run derive)`);
    if (!isExtractionIntermediate(kb?.extraction)) {
      return result('drift', true, `committed ${relOut} has no embedded extraction to verify`);
    }
    if (!sourceFresh) return result('drift', true, 'source changed since derivation');
    const expected = buildAndStringify(document, kb.extraction, context);
    if (expected.bytes !== readFileSync(outPath, 'utf-8')) {
      return result(
        'drift',
        true,
        `committed ${relOut} differs from a fresh deterministic emit`,
        expected,
      );
    }
    return result('ok', false, 'up to date', expected);
  }

  // ── Derive mode. ──
  let intermediate: ExtractionIntermediate;
  let reused = false;
  if (reusable && isExtractionIntermediate(kb?.extraction)) {
    intermediate = kb.extraction;
    reused = true;
  } else {
    if (typeof runExtraction !== 'function') {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        `derive requires a fuzzy extraction runtime for "${sourcePath}", but none was supplied ` +
          `(context.seams.runExtraction). The contract does not own the LLM runtime.`,
        { source: sourcePath },
      );
    }
    intermediate = await runExtraction(document);
  }

  const built = buildAndStringify(document, intermediate, context);
  if (!built.validation.ok) {
    throw new AffordanceError(
      ERROR_CODES.EXECUTION_FAILED,
      `Emitted JSON-LD for "${sourcePath}" failed contract validation: ${built.validation.errors.join('; ')}`,
      { validation: built.validation },
    );
  }

  const unchanged = existsSync(outPath) && readFileSync(outPath, 'utf-8') === built.bytes;
  if (!unchanged) {
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, built.bytes, 'utf-8');
  }
  const status = unchanged ? 'unchanged' : existing ? 'updated' : 'created';
  return result(
    status,
    false,
    reused ? 'reused embedded extraction (no LLM call)' : 'extracted',
    built,
  );
}

export default defineAffordance({
  name: 'derive',
  title: 'Derive entities',
  summary:
    'Extract entities/relationships from unstructured sources into committed canonical JSON-LD (or check for drift).',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // `check` mode is the deterministic, offline drift gate — it never writes or
    // extracts, so it is side-effect-free and skips the consent prompt (runs
    // unattended in CI). Any non-check invocation is gated as a write.
    readOnlyWhen: (input: Record<string, unknown>) => Boolean((input as DeriveInput).check),
    // Write-class: discloses the committed *.jsonld artifacts it will write
    // (one per source, in the output directory). Deterministic from input.
    disclose: (input: Record<string, unknown>) => {
      const args = input as DeriveInput;
      const outDir = (args.out && String(args.out)) || DEFAULT_OUT_DIR;
      const sources = Array.isArray(args.sources) ? args.sources : [];
      // `check` mode never writes; disclose nothing to write in that case.
      if (args.check) return { writes: [] };
      return {
        writes: sources.map((source) => {
          const base = basename(String(source), extname(String(source)));
          return toPosix(`${outDir}/${base}.jsonld`);
        }),
      };
    },
  },
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
  async execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as DeriveInput;
    const outDir = resolve(context.cwd, args.out || DEFAULT_OUT_DIR);
    const ctxIri = args.context || DEFAULT_CONTEXT;
    const runExtraction = context.seams?.runExtraction;

    const results: DeriveResult[] = [];
    for (const source of args.sources) {
      try {
        results.push(
          await deriveOne(source, {
            outDir,
            cwd: context.cwd,
            check: args.check ?? false,
            refresh: args.refresh ?? false,
            context: ctxIri,
            runExtraction,
          }),
        );
      } catch (err: unknown) {
        if (err instanceof AffordanceError) throw err;
        if (err instanceof IngestError) {
          throw new AffordanceError(ERROR_CODES.INVALID_INPUT, `[${err.code}] ${err.message}`, {
            source,
          });
        }
        throw new AffordanceError(
          ERROR_CODES.EXECUTION_FAILED,
          `derive failed for "${source}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { results, drift: results.some((result) => result.drift) };
  },
});

export { deriveOne, artifactPathFor };
