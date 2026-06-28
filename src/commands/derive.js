/**
 * kbx derive — build-time fuzzy/docx → JSON-LD extraction (Feature F8).
 *
 * Turns UNSTRUCTURED / semi-structured sources (`.docx`, prose markdown, text)
 * into committed `*.jsonld` entity artifacts that conform to Epic 1 / F1's
 * node-type contract. The pipeline mirrors `generate`: a fuzzy (LLM) phase runs
 * through the F7 programmatic-mode runtime (`copilot -p`) via the runtime
 * router; a deterministic phase normalizes/validates the extraction into
 * canonical JSON-LD.
 *
 *   read source (deterministic)
 *     → extract entities/relationships (fuzzy, copilot -p)
 *       → normalize + validate → emit kg:// JSON-LD (deterministic, canonical)
 *
 * Re-derivation is idempotent (byte-identical output for unchanged input, via a
 * timestamp-free canonical artifact + an embedded extraction reused without
 * re-calling the LLM) and `--check` detects drift (stale committed artifact ⇒
 * non-zero exit) — neither path calls the LLM.
 */

import { resolve, basename, extname, relative } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseDeriveArgs } from '../lib/args.js';
import { readSource, IngestError } from '../lib/ingest.js';
import {
  buildExtractionPrompt,
  extractEntities,
  ExtractionError,
} from '../lib/extract.js';
import {
  buildArtifact,
  canonicalStringify,
  validateArtifact,
  DEFAULT_CONTEXT,
} from '../lib/jsonld.js';
import { routeTask } from '../lib/runtime-router.js';
import {
  isAdapterAvailable,
  resolveBinary,
  RuntimeAdapterError,
  titleCase,
} from '../lib/copilot-runtime.js';
import {
  loadRuntimeConfig,
  resolveRuntime,
  applyRuntimeConfigDefaults,
  RuntimeConfigError,
} from '../lib/runtime-config.js';
import {
  runMcpPreflight,
  formatMcpPreflightErrors,
} from '../lib/mcp-preflight.js';

const DEFAULT_OUT_DIR = 'content/derived';

function printHelp() {
  console.log(`
  kbx derive — build-time fuzzy/docx → JSON-LD extraction

  Usage: kbx derive <source...> [options]

  Reads unstructured sources (.docx, prose .md/.markdown, .txt), uses the
  configured runtime agent to extract entities/relationships, then emits
  committed *.jsonld conforming to the engine's node-type contract.

  Arguments:
    <source...>           One or more source files to derive.

  Options:
    -o, --out <dir>       Output directory for *.jsonld (default ${DEFAULT_OUT_DIR})
        --context <ctx>   Override the JSON-LD @context (default ${DEFAULT_CONTEXT})
        --check           Drift check: do not write; exit non-zero if any committed
                          artifact is stale relative to its source (no LLM call)
        --refresh,--force Re-run fuzzy extraction even if a fresh artifact exists
        --model <model>   Model to use (copilot --model)
        --allow-tool <s>  Scoped tool permission, repeatable (disables implicit allow-all)
        --allow-all-tools Allow all tools without confirmation (default for extraction)
        --timeout <ms>    Time budget for the programmatic run (default 600000)
        --dry-run         Print the assembled agent command + planned outputs; run nothing
        --runtime <name>  Override runtime adapter: "copilot" | "claude" | "custom"
                          (precedence: flag > .kbx.json > KBX_RUNTIME > default)
        --skip-preflight  Skip MCP preflight check (development escape hatch)
    -h, --help            Show this help
`);
}

/** Build runtime options for the fuzzy extraction step from parsed args. */
export function buildDeriveRuntimeOptions(opts, cwd) {
  const useScoped = opts.allowTools && opts.allowTools.length > 0;
  return {
    cwd,
    allowTools: useScoped ? opts.allowTools : [],
    allowAllTools: useScoped ? false : opts.allowAllTools !== false,
    model: opts.model || undefined,
    timeoutMs: opts.timeout || undefined,
    silent: true,
    noColor: true,
  };
}

/** Compute the output artifact path for a source file. */
export function artifactPathFor(sourcePath, outDir) {
  const base = basename(sourcePath, extname(sourcePath));
  return resolve(outDir, `${base}.jsonld`);
}

/** Read + parse a committed artifact; null when missing or invalid JSON. */
function readArtifact(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Derive a single source into a JSON-LD artifact (or check it for drift).
 *
 * Pure of CLI concerns and fully injectable for tests: `runExtraction` performs
 * the fuzzy step and is only invoked when a fresh extraction is actually needed.
 *
 * @param {string} sourcePath
 * @param {object} options
 * @param {string}   options.outDir
 * @param {string}   [options.cwd=process.cwd()]
 * @param {boolean}  [options.check=false]    Drift mode (never writes, never extracts).
 * @param {boolean}  [options.refresh=false]  Force re-extraction.
 * @param {string}   [options.context]        @context override.
 * @param {(document: object) => Promise<{entities,relationships}>} [options.runExtraction]
 *        Fuzzy extractor; defaults to {@link extractEntities} over {@link runCopilot}.
 * @returns {Promise<{
 *   source: string, outPath: string, status: string, drift: boolean,
 *   reason?: string, artifact: object, bytes: string, validation: object
 * }>}
 */
export async function deriveSource(sourcePath, options = {}) {
  const {
    outDir,
    cwd = process.cwd(),
    check = false,
    refresh = false,
    context = DEFAULT_CONTEXT,
    runExtraction = (document) => extractEntities({ document }),
  } = options;

  const document = readSource(sourcePath, { cwd });
  const outPath = artifactPathFor(sourcePath, outDir);
  const relOut = toPosix(relative(cwd, outPath));
  const existing = readArtifact(outPath);

  const sourceFresh =
    existing && (existing.kbx ?? existing.kbexplorer)?.source?.sha256 === document.sha256;
  const reusableIntermediate =
    existing && (existing.kbx ?? existing.kbexplorer)?.extraction && sourceFresh && !refresh;

  // ── Drift mode: never extract, never write. ──
  if (check) {
    if (!existing) {
      return result('drift', true, `no committed artifact at ${relOut} (run \`derive\`)`);
    }
    const kb = existing.kbx ?? existing.kbexplorer;
    if (!kb?.extraction) {
      return result('drift', true, `committed ${relOut} has no embedded extraction to verify`);
    }
    if (!sourceFresh) {
      return result(
        'drift',
        true,
        `source changed since derivation (committed sha256 ${short(kb.source?.sha256)} ≠ ${short(document.sha256)})`,
      );
    }
    const expected = buildAndStringify(document, kb.extraction, context);
    const committedBytes = readFileSync(outPath, 'utf-8');
    if (expected.bytes !== committedBytes) {
      return result('drift', true, `committed ${relOut} differs from a fresh deterministic emit`, expected);
    }
    return result('ok', false, `up to date`, expected);
  }

  // ── Derive mode: reuse embedded intermediate when fresh, else extract. ──
  let intermediate;
  let reused = false;
  if (reusableIntermediate) {
    intermediate = (existing.kbx ?? existing.kbexplorer).extraction;
    reused = true;
  } else {
    intermediate = await runExtraction(document);
  }

  const built = buildAndStringify(document, intermediate, context);
  if (!built.validation.ok) {
    const err = new Error(
      `Emitted JSON-LD for "${sourcePath}" failed contract validation:\n  - ${built.validation.errors.join('\n  - ')}`,
    );
    err.validation = built.validation;
    throw err;
  }

  const unchanged = existing && readFileSync(outPath, 'utf-8') === built.bytes;
  if (!unchanged) {
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, built.bytes, 'utf-8');
  }
  const status = unchanged ? 'unchanged' : existing ? 'updated' : 'created';
  return result(status, false, reused ? 'reused embedded extraction (no LLM call)' : 'extracted', built);

  function buildAndStringify(doc, inter, ctx) {
    const artifact = buildArtifact({
      source: { path: doc.path, format: doc.format, sha256: doc.sha256, bytes: doc.bytes, title: doc.title },
      intermediate: inter,
      context: ctx,
    });
    return { artifact, bytes: canonicalStringify(artifact), validation: validateArtifact(artifact) };
  }

  function result(status, drift, reason, built) {
    return {
      source: document.path,
      outPath,
      relOut,
      status,
      drift,
      reason,
      artifact: built?.artifact,
      bytes: built?.bytes,
      validation: built?.validation,
      nodeCount: built?.artifact?.kbx?.nodes?.length,
      edgeCount: built?.artifact?.kbx?.edges?.length,
    };
  }
}

export default async function derive(args = []) {
  const opts = parseDeriveArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.unknown.length > 0) {
    console.error(`Unknown option(s): ${opts.unknown.join(', ')}`);
    console.error('Run "kbx derive --help" for usage.');
    process.exit(1);
  }
  if (opts.sources.length === 0) {
    console.error('✗ No source files given. Usage: kbx derive <source...> [options]');
    process.exit(1);
  }

  const cwd = process.cwd();
  const outDir = resolve(cwd, opts.out || DEFAULT_OUT_DIR);
  const context = opts.context || DEFAULT_CONTEXT;

  // ── Resolve runtime adapter (precedence: --runtime flag > .kbx.json > env > default) ──
  let runtimeConfig;
  let runtimeAdapter;
  try {
    runtimeConfig = loadRuntimeConfig(cwd);
    runtimeAdapter = resolveRuntime({ flag: opts.runtime, config: runtimeConfig });
  } catch (err) {
    if (err instanceof RuntimeConfigError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  // CLI --timeout wins; config timeoutMs fills the gap.
  const runtimeOptions = applyRuntimeConfigDefaults(buildDeriveRuntimeOptions(opts, cwd), runtimeConfig);

  // ── Dry run: show the assembled command + planned outputs, run nothing. ──
  if (opts.dryRun) {
    const binary = resolveBinary({ envVar: runtimeAdapter.binaryEnv, defaultBinary: runtimeAdapter.defaultBinary });
    console.log(`Dry run — would derive the following sources (runtime: ${runtimeAdapter.name}):`);
    for (const src of opts.sources) {
      let doc;
      try {
        doc = readSource(src, { cwd });
      } catch (err) {
        console.log(`  ✗ ${src} — ${err.message}`);
        continue;
      }
      const outPath = toPosix(relative(cwd, artifactPathFor(src, outDir)));
      const prompt = buildExtractionPrompt(doc);
      const argv = runtimeAdapter.buildArgs({
        prompt,
        outputFormat: 'json',
        silent: true,
        noColor: true,
        ...stripCwd(runtimeOptions),
      });
      console.log(`  • ${src} → ${outPath}`);
      console.log(`    ${binary} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    }
    return;
  }

  // ── Fuzzy extractor (only used when a fresh extraction is needed). ──
  const runExtraction = (document) =>
    routeTask(
      { name: `extract:${document.path}`, kind: 'fuzzy', document },
      {
        logger: console,
        runFuzzy: (task) =>
          extractEntities({
            document: task.document,
            runtimeOptions: { adapter: runtimeAdapter, ...runtimeOptions },
          }),
      },
    ).then((r) => r.result);

  // In derive (non-check) mode we may need the LLM — verify availability up front
  // unless every source can be served from a fresh committed artifact.
  if (!opts.check && !isAdapterAvailable(runtimeAdapter) && needsExtraction(opts, cwd, outDir)) {
    console.error(`✗ ${titleCase(runtimeAdapter.name)} CLI not found on PATH.`);
    if (runtimeAdapter.installUrl) {
      console.error(`  Install it: ${runtimeAdapter.installUrl}`);
    }
    if (runtimeAdapter.binaryEnv) {
      console.error(`  Or set ${runtimeAdapter.binaryEnv} to its full path.`);
    }
    console.error(`  (Already-derived sources with unchanged input do not need ${titleCase(runtimeAdapter.name)}.)`);
    process.exit(1);
  }

  // ── MCP preflight: verify required servers are configured before any LLM call ──
  // Only runs when the runtime config declares an `mcp` block AND a fuzzy
  // extraction will actually run — like the availability check above, sources
  // served from fresh committed artifacts need no LLM and no MCP servers.
  // (--check and --dry-run never reach here with LLM work either.)
  if (!opts.check && !opts.dryRun && runtimeConfig?.mcp && needsExtraction(opts, cwd, outDir)) {
    if (opts.skipPreflight) {
      console.warn('⚠ --skip-preflight: skipping MCP server verification (development mode).');
    } else {
      const preflight = runMcpPreflight({ adapter: runtimeAdapter, config: runtimeConfig, cwd });
      for (const w of preflight.warnings) {
        console.warn(`⚠ ${w}`);
      }
      if (!preflight.ok) {
        const lines = formatMcpPreflightErrors(preflight.missing, runtimeAdapter.name, cwd);
        for (const line of lines) {
          console.error(line);
        }
        process.exit(1);
      }
    }
  }

  const results = [];
  let hadError = false;
  for (const src of opts.sources) {
    try {
      const res = await deriveSource(src, {
        outDir,
        cwd,
        check: opts.check,
        refresh: opts.refresh,
        context,
        runExtraction,
      });
      results.push(res);
      reportOne(res, opts.check);
    } catch (err) {
      hadError = true;
      if (err instanceof IngestError || err instanceof ExtractionError) {
        console.error(`✗ ${src}: [${err.code}] ${err.message}`);
      } else if (err instanceof RuntimeAdapterError) {
        console.error(`✗ ${src}: ${runtimeAdapter.name} run failed (${err.code}): ${err.message}`);
      } else {
        console.error(`✗ ${src}: ${err.message}`);
      }
    }
  }

  if (opts.check) {
    const drifted = results.filter((r) => r.drift);
    if (drifted.length > 0 || hadError) {
      console.error(`\n✗ Drift detected in ${drifted.length} artifact(s).`);
      process.exit(1);
    }
    console.log(`\n✅ All ${results.length} artifact(s) up to date.`);
    return;
  }

  if (hadError) process.exit(1);
  console.log(`\n✅ Derived ${results.length} source(s) → ${toPosix(relative(cwd, outDir))}/`);
}

function reportOne(res, check) {
  if (check) {
    if (res.drift) console.error(`  ✗ drift: ${res.relOut} — ${res.reason}`);
    else console.log(`  ✓ ${res.relOut} — ${res.reason}`);
    return;
  }
  const counts = res.nodeCount != null ? ` (${res.nodeCount} nodes, ${res.edgeCount} edges)` : '';
  console.log(`  ✓ ${res.status}: ${res.relOut}${counts} — ${res.reason}`);
}

/** Whether any source still requires an LLM extraction (no fresh committed artifact). */
function needsExtraction(opts, cwd, outDir) {
  if (opts.refresh) return true;
  for (const src of opts.sources) {
    let doc;
    try {
      doc = readSource(src, { cwd });
    } catch {
      // Let deriveSource surface the ingest error later; not an LLM need.
      continue;
    }
    const existing = readArtifact(artifactPathFor(src, outDir));
    const fresh = existing && (existing.kbx ?? existing.kbexplorer)?.source?.sha256 === doc.sha256 && (existing.kbx ?? existing.kbexplorer)?.extraction;
    if (!fresh) return true;
  }
  return false;
}

function stripCwd({ cwd, ...rest }) {
  return rest;
}

function short(hash) {
  return String(hash ?? '∅').replace(/^sha256:/, '').slice(0, 12);
}

function toPosix(p) {
  return String(p).split('\\').join('/');
}
