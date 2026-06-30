/**
 * kbx connect — persist + verify the cross-source connection layer (E3-C4 / #140).
 *
 * Runs the connect pipeline (edge-mint #137 → conflation #138 → SoR-precedence
 * #139) over the repo graph, applying the human-authored `manual-overrides.json`
 * INPUT, and writes three deterministic, committed OUTPUT artifacts under
 * `.kbx/connection/`. `--check` re-runs in memory and fails on any byte drift,
 * mirroring `derive --check`.
 *
 *   load graph → apply manual overrides → mint → conflate → resolve precedence
 *     → serialize canonical artifacts → write (or --check parity)
 */

import { resolve, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { buildGraph } from '../lib/graph-builder.js';
import {
  CONNECT_DIR,
  OVERRIDES_FILE,
  runConnect,
  serializeConnectArtifacts,
  loadOverrides,
  writeConnectArtifacts,
  checkConnectArtifacts,
  ConnectError,
} from '../lib/connect.js';

function printHelp() {
  console.log(`
  kbx connect — persist + verify the cross-source connection layer

  Usage: kbx connect [options]

  Runs edge-mint → referent conflation → SoR-precedence over the repo graph,
  applies the human-authored ${CONNECT_DIR}/${OVERRIDES_FILE} (INPUT, never
  overwritten), and writes deterministic OUTPUT artifacts under ${CONNECT_DIR}/:
    • minted-edges.json     reference edges minted between distinct nodes (#137)
    • conflation-map.json   same-referent groups + contradiction warnings (#138)
    • precedence-map.json   per-node resolved winners + preserved conflicts (#139)

  Options:
        --check            Drift gate: do not write; exit non-zero if any committed
                           artifact differs from a fresh deterministic emit
    -h, --help             Show this help
`);
}

function toPosix(p) {
  return String(p).split('\\').join('/');
}

/** Best-effort precedence config from a JSON .kbx.json (no YAML dependency). */
function loadPrecedence(cwd) {
  const path = resolve(cwd, '.kbx.json');
  if (!existsSync(path)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    return cfg.precedence ?? cfg.kbx?.precedence ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Programmatic entry — pure of process.exit so it is testable. Returns a result
 * describing what happened; the CLI wrapper maps it to stdout + exit codes.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd=process.cwd()]
 * @param {boolean} [options.check=false]
 * @param {object}  [options.graph]  Inject a graph (tests); defaults to buildGraph(cwd).
 * @returns {{ check: boolean, dir: string, ok: boolean,
 *            report?: Array<object>, drift?: Array<object>, stats: object }}
 */
export function runConnectCommand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const dir = resolve(cwd, CONNECT_DIR);
  const graph = options.graph ?? buildGraph(cwd);
  const overrides = loadOverrides(dir);
  const precedence = options.precedence ?? loadPrecedence(cwd);

  const result = runConnect(graph, { overrides, precedence });
  const artifacts = serializeConnectArtifacts(result);

  if (options.check) {
    const { ok, drift } = checkConnectArtifacts(dir, artifacts);
    return { check: true, dir, ok, drift, stats: result.stats };
  }
  const report = writeConnectArtifacts(dir, artifacts);
  return { check: false, dir, ok: true, report, stats: result.stats };
}

export default async function connect(args = []) {
  const check = args.includes('--check');
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--check' && a !== '-h' && a !== '--help');
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(', ')}`);
    console.error('Run "kbx connect --help" for usage.');
    process.exit(1);
  }

  const cwd = process.cwd();
  let res;
  try {
    res = runConnectCommand({ cwd, check });
  } catch (err) {
    if (err instanceof ConnectError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const relDir = toPosix(relative(cwd, res.dir)) || CONNECT_DIR;
  const s = res.stats;
  const summary = `${s.mintedEdges} minted edge(s), ${s.conflatedGroups} conflated group(s), ${s.precedenceResolved} resolved / ${s.precedenceConflicts} preserved conflict(s)`;

  if (res.check) {
    if (!res.ok) {
      console.error(`\n✗ Connection drift in ${res.drift.length} artifact(s):`);
      for (const d of res.drift) console.error(`  ✗ ${relDir}/${d.file} — ${d.reason}`);
      console.error(`\n  Run \`kbx connect\` to regenerate, then review + commit the diff.`);
      process.exit(1);
    }
    console.log(`✅ Connection artifacts up to date (${summary}).`);
    return;
  }

  for (const r of res.report) console.log(`  ✓ ${r.status}: ${relDir}/${r.file}`);
  console.log(`\n✅ Wrote connection artifacts → ${relDir}/ (${summary}).`);
}
