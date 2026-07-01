/**
 * kbx sync — detect source drift + reconcile the deterministic KB (PE4-F1 / #157).
 *
 * The head of the PE4 trust loop: keep the committed knowledge graph in sync
 * with its sources. Two modes on one verb, mirroring the `connect`/`derive`
 * `--check` idiom:
 *
 *   • `kbx sync --check`  — DRIFT GATE (detection only, CI-safe). Composes the
 *     E2 affected-source dispatch (#136) — diffing the committed composite graph
 *     against a baseline (the same file at `--since <ref>`, or a `--against
 *     <path>` graph) by `SourceRef.contentHash`, never a clock — with the E3
 *     connect `--check` byte-parity gate (#140) when a connection layer exists.
 *     Emits a multi-source sync status and exits non-zero on drift.
 *
 *   • `kbx sync`          — RECONCILE. Deterministically regenerates the
 *     committed downstream artifacts that are pure functions of already-committed
 *     inputs: re-runs the connect pipeline (edge-mint → conflation → precedence)
 *     writing `.kbx/connection/*.json`. Node-content / LLM regeneration is
 *     explicitly deferred to incremental regen (PE4-F2 / #158); sync only
 *     reconciles the deterministic layer and reports what drifted.
 *
 * Deterministic & idempotent: the drift computation carries no timestamps; only
 * baseline/artifact acquisition touches git/fs.
 */

import { resolve, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { computeSyncStatus } from '../lib/drift.js';
import { loadBaselineGraph } from './affected.js';
import { runConnectCommand } from './connect.js';
import { CONNECT_DIR, ARTIFACT_FILES, ConnectError } from '../lib/connect.js';

/** Default committed composite graph, relative to the repo root. */
export const DEFAULT_GRAPH = `${CONNECT_DIR}/composite-graph.json`;

function toPosix(p) {
  return String(p).split('\\').join('/');
}

function parseArgs(args) {
  const out = { check: false, json: false, graph: DEFAULT_GRAPH, since: 'HEAD', against: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--graph') out.graph = args[++i];
    else if (a.startsWith('--graph=')) out.graph = a.slice('--graph='.length);
    else if (a === '--since') out.since = args[++i];
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--against') out.against = args[++i];
    else if (a.startsWith('--against=')) out.against = a.slice('--against='.length);
    else out.unknown = [...(out.unknown ?? []), a];
  }
  return out;
}

function printHelp() {
  console.log(`
  kbx sync — detect source drift + reconcile the deterministic KB

  Usage: kbx sync [--check] [options]

  Composes the affected-source dispatch (#136) and the connect drift gate (#140)
  into a multi-source sync status: which sources drifted (an input content hash
  changed), which nodes went stale (downstream of a drift), and whether the
  committed ${CONNECT_DIR}/ artifacts still match a fresh deterministic emit.

  Modes:
    (default)              Reconcile: regenerate the committed connection
                           artifacts under ${CONNECT_DIR}/ from the current graph.
    --check                Drift gate: never write; exit non-zero if the graph or
                           the connection artifacts have drifted.

  Options:
        --graph <path>     Committed composite graph (default ${DEFAULT_GRAPH})
        --since <ref>      Baseline git ref for the graph diff (default HEAD)
        --against <path>   Diff against another graph file instead of --since
        --json             Emit machine-readable JSON
    -h, --help             Show this help
`);
}

/** Coerce assorted persisted graph shapes into `{ nodes, edges }`. */
function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object') return { nodes: [], edges: [] };
  const nodes = raw.nodes ?? raw['@graph'] ?? [];
  const edges = raw.edges ?? raw['@edges'] ?? [];
  return { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] };
}

function readGraphFile(path) {
  return normalizeGraph(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * Evaluate connection-artifact parity, but only when a connection layer exists
 * (at least one committed artifact under `.kbx/connection/`). Repos that never
 * ran `connect` simply omit the connection signal rather than reporting phantom
 * drift. Injectable for tests via `opts.runConnect`.
 *
 * @returns {{ ok: boolean, drift: Array<object> }|null}
 */
export function evaluateConnect(cwd, opts = {}) {
  const dir = resolve(cwd, CONNECT_DIR);
  const hasArtifacts = ARTIFACT_FILES.some((f) => existsSync(resolve(dir, f)));
  if (!hasArtifacts) return null;
  const run = opts.runConnect ?? ((o) => runConnectCommand(o));
  try {
    const res = run({ cwd, check: true });
    return { ok: res.ok === true, drift: Array.isArray(res.drift) ? res.drift : [] };
  } catch (err) {
    if (err instanceof ConnectError) return { ok: false, drift: [{ file: '(connect)', reason: err.message }] };
    throw err;
  }
}

/**
 * Programmatic entry — pure of process.exit so it is testable. Loads the graph,
 * its baseline, and the connection-parity signal, then computes the sync status.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd=process.cwd()]
 * @param {string}  [options.graph=DEFAULT_GRAPH]
 * @param {string}  [options.since='HEAD']
 * @param {string|null} [options.against]
 * @param {object}  [options.currentGraph]   Inject the current graph (tests).
 * @param {object}  [options.baselineGraph]  Inject the baseline graph (tests).
 * @param {object}  [options.connect]        Inject the connect parity result (tests).
 * @returns {{ graphPath: string, baselineDesc: string, status: object }}
 */
export function computeSync(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const graphPath = options.graph ?? DEFAULT_GRAPH;
  const absGraph = resolve(cwd, graphPath);

  let current = options.currentGraph;
  if (!current) {
    if (!existsSync(absGraph)) {
      const err = new Error(`Graph file not found: ${graphPath}`);
      err.code = 'GRAPH_NOT_FOUND';
      throw err;
    }
    current = readGraphFile(absGraph);
  }

  let baseline = options.baselineGraph ?? null;
  let baselineDesc;
  if (!options.baselineGraph) {
    if (options.against) {
      const absAgainst = resolve(cwd, options.against);
      baseline = existsSync(absAgainst) ? readGraphFile(absAgainst) : null;
      baselineDesc = options.against;
    } else {
      baseline = loadBaselineGraph({ cwd, graphPath, since: options.since ?? 'HEAD' });
      baselineDesc = options.since ?? 'HEAD';
    }
  } else {
    baselineDesc = options.against ?? options.since ?? '(injected)';
  }

  const connect = options.connect !== undefined ? options.connect : evaluateConnect(cwd, options);
  const status = computeSyncStatus({ current, baseline, connect });
  return { graphPath, baselineDesc, status };
}

function printReport({ graphPath, baselineDesc, status }) {
  const s = status;
  console.log('');
  console.log('+------------------------------------------+');
  console.log('|   KB Sync Status (multi-source)          |');
  console.log('+------------------------------------------+');
  console.log('');
  console.log(`  Graph:            ${graphPath}`);
  console.log(`  Baseline:         ${s.full ? `${baselineDesc} (none - full build)` : baselineDesc}`);
  console.log(`  Indexed nodes:    ${s.graph.nodeCount}`);
  console.log(`  Dirty inputs:     ${s.graph.dirtyInputs.length}`);
  console.log(`  Affected nodes:   ${s.graph.affected.length}`);
  if (s.connect) {
    console.log(`  Connection layer: ${s.connect.ok ? 'up to date' : `${s.connect.drift.length} artifact(s) drifted`}`);
  }
  console.log('');

  if (s.full) {
    console.log('No prior state - full build (nothing committed to be out of sync with).');
    console.log('');
    return;
  }

  const drifted = s.sources.filter((x) => x.status !== 'in-sync');
  if (drifted.length > 0) {
    console.log('Source sync status:');
    for (const src of drifted) {
      const mark = src.status === 'drifted' ? '~' : '!';
      console.log(`  ${mark} ${src.source} — ${src.status} (${src.affected.length} affected node(s))`);
    }
    console.log('');
  }

  if (s.graph.dirtyInputs.length > 0) {
    console.log('Dirty inputs (changed content hash vs baseline):');
    for (const href of s.graph.dirtyInputs) console.log(`  ~ ${href}`);
    console.log('');
  }

  if (s.connect && !s.connect.ok) {
    console.log('Connection artifacts drifted:');
    for (const d of s.connect.drift) console.log(`  x ${d.file} — ${d.reason}`);
    console.log('');
  }

  if (!s.drift) {
    console.log('OK In sync - no source drift detected.');
    console.log('');
  }
}

export default async function syncCommand(args = []) {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.unknown && opts.unknown.length > 0) {
    console.error(`Unknown option(s): ${opts.unknown.join(', ')}`);
    console.error('Run "kbx sync --help" for usage.');
    process.exit(1);
  }

  const cwd = process.cwd();
  let computed;
  try {
    computed = computeSync({ cwd, graph: opts.graph, since: opts.since, against: opts.against });
  } catch (err) {
    if (err && err.code === 'GRAPH_NOT_FOUND') {
      console.error(`x ${err.message}`);
      console.error('  Run `kbx generate` / your composite ingest to produce it first.');
      process.exit(1);
    }
    throw err;
  }

  // ── Drift gate: report + exit code, never write. ──
  if (opts.check) {
    if (opts.json) {
      console.log(JSON.stringify({ mode: 'check', graph: computed.graphPath, baseline: computed.baselineDesc, ...computed.status }, null, 2));
    } else {
      printReport(computed);
    }
    if (computed.status.drift) {
      if (!opts.json) {
        console.error('x Drift detected. Run `kbx sync` to reconcile the deterministic layer,');
        console.error('  then refresh affected content (incremental regen, #158) and commit.');
      }
      process.exit(1);
    }
    return;
  }

  // ── Reconcile: regenerate the deterministic connection artifacts. ──
  let reconcile = null;
  const dir = resolve(cwd, CONNECT_DIR);
  const hasConnectDir = existsSync(dir);
  if (hasConnectDir) {
    try {
      reconcile = runConnectCommand({ cwd, check: false });
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(`x ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      mode: 'reconcile',
      graph: computed.graphPath,
      baseline: computed.baselineDesc,
      status: computed.status,
      reconcile: reconcile ? { report: reconcile.report, stats: reconcile.stats } : null,
    }, null, 2));
    return;
  }

  printReport(computed);
  if (reconcile) {
    const relDir = toPosix(relative(cwd, dir)) || CONNECT_DIR;
    for (const r of reconcile.report) console.log(`  ${r.status === 'unchanged' ? '=' : '+'} ${r.status}: ${relDir}/${r.file}`);
    console.log(`\nOK Reconciled connection artifacts -> ${relDir}/.`);
  } else {
    console.log('No connection layer to reconcile (run `kbx connect` to create one).');
  }
  console.log('Node-content regeneration is deferred to incremental regen (#158).');
}
