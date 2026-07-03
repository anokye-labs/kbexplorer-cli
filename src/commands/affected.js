/**
 * kbx affected — report the set of nodes affected by changed inputs.
 *
 * Two complementary dispatch modes share one verb (issue #136, E2-M3):
 *
 *   1. **Legacy git-citation** (default, unchanged). Maps a git diff to the
 *      content nodes whose prose *cites* the changed files. Preserves today's
 *      behavior exactly for git sources.
 *
 *        kbx affected <ref>           # human report
 *        kbx affected <ref> --json    # machine-readable
 *
 *   2. **Composite content-hash dispatch** (`--graph`). Generalizes the
 *      computation to any source kind in the composite graph: it diffs each
 *      input's `SourceRef.contentHash` against a prior committed baseline, then
 *      takes the transitive closure over `Derivation.inputs` and graph edges.
 *      The recompute signal is a changed content hash — never a clock.
 *
 *        kbx affected --graph .kbx/connection/graph.json [--since <ref>] [--json]
 *
 *      `--since <ref>` selects the baseline (default `HEAD`): the engine reads
 *      the same graph file at that git ref via `git show`. When no prior state
 *      exists (file absent at the ref, or empty), every node is treated as
 *      affected — a full build.
 *
 * Deterministic & idempotent: the affected computation carries no timestamps;
 * only baseline acquisition touches git/fs.
 */

import { resolve, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { affected } from '../lib/affected.js';
import { affectedFromGraphs } from '../lib/affected-graph.js';
import { resolveContentDir } from '../lib/kb-env.js';

function parseArgs(args) {
  const out = { json: false, ref: 'HEAD', content: null, graph: null, since: 'HEAD' };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--content') out.content = args[++i];
    else if (a.startsWith('--content=')) out.content = a.slice('--content='.length);
    else if (a === '--graph') out.graph = args[++i];
    else if (a.startsWith('--graph=')) out.graph = a.slice('--graph='.length);
    else if (a === '--since') out.since = args[++i];
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (positional[0]) out.ref = positional[0];
  return out;
}

// -- Legacy git-citation report ----------------------------------------------

function printHumanReport(result) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Affected Nodes Report              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Ref:              ${result.ref}`);
  console.log(`  Changed files:    ${result.changedFiles.length}`);
  console.log(`  Indexed nodes:    ${result.nodeCount}`);
  console.log(`  Affected nodes:   ${result.affected.length}`);
  console.log(`  Uncited changes:  ${result.uncited.length}`);
  console.log('');

  if (result.affected.length > 0) {
    console.log('Affected node ids:');
    for (const id of result.affected) console.log(`  • ${id}`);
    console.log('');
  }

  const cited = result.detail.filter((d) => d.nodes.length > 0);
  if (cited.length > 0) {
    console.log('File → node mapping:');
    for (const d of cited) {
      console.log(`  ${d.file}`);
      for (const id of d.nodes) console.log(`    → ${id}`);
    }
    console.log('');
  }

  if (result.uncited.length > 0) {
    console.log('Uncited changed files (consider adding nodes that cover them):');
    for (const f of result.uncited.slice(0, 20)) console.log(`  ${f}`);
    if (result.uncited.length > 20) {
      console.log(`  ... and ${result.uncited.length - 20} more`);
    }
    console.log('');
  }

  if (result.affected.length === 0) {
    console.log('✅ No content nodes cite the changed files.');
    console.log('');
  }
}

// -- Composite content-hash dispatch -----------------------------------------

/** Coerce assorted persisted graph shapes into `{ nodes, edges }`. */
function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object') return { nodes: [], edges: [] };
  const nodes = raw.nodes ?? raw['@graph'] ?? [];
  const edges = raw.edges ?? raw['@edges'] ?? [];
  return { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] };
}

/** Read + parse a graph JSON file into `{ nodes, edges }`. */
function readGraphFile(path) {
  return normalizeGraph(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * Read the baseline graph (the same file at `since`) from git. Returns `null`
 * when the file does not exist at that ref (no prior state => full build).
 * Injectable for hermetic tests via `opts.gitShow`.
 *
 * @returns {{ nodes: object[], edges: object[] }|null}
 */
export function loadBaselineGraph({ cwd, graphPath, since }, opts = {}) {
  const gitShow =
    opts.gitShow ??
    ((rel, ref) =>
      execFileSync('git', ['show', `${ref}:${rel}`], {
        cwd,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
  const rel = relative(cwd, resolve(cwd, graphPath)).split('\\').join('/');
  try {
    const raw = gitShow(rel, since);
    if (!raw || !raw.trim()) return null;
    return normalizeGraph(JSON.parse(raw));
  } catch {
    return null;
  }
}

function printCompositeReport(result, ctx) {
  console.log('');
  console.log('+------------------------------------------+');
  console.log('|   Affected Nodes Report (composite)      |');
  console.log('+------------------------------------------+');
  console.log('');
  console.log(`  Graph:            ${ctx.graph}`);
  console.log(
    `  Baseline (since): ${result.full ? `${ctx.since} (none - full build)` : ctx.since}`
  );
  console.log(`  Indexed nodes:    ${result.nodeCount}`);
  console.log(`  Dirty inputs:     ${result.dirtyInputs.length}`);
  console.log(`  Affected nodes:   ${result.affected.length}`);
  console.log('');

  if (result.full) {
    console.log('No prior state - treating all nodes as affected (full build).');
    console.log('');
  } else if (result.dirtyInputs.length > 0) {
    console.log('Dirty inputs (changed content hash vs baseline):');
    for (const href of result.dirtyInputs) console.log(`  ~ ${href}`);
    console.log('');
  }

  if (result.affected.length > 0) {
    console.log('Affected node ids:');
    for (const id of result.affected) console.log(`  - ${id}`);
    console.log('');
  } else {
    console.log('No nodes affected - nothing to regenerate.');
    console.log('');
  }
}

// -- Entry point --------------------------------------------------------------

export default async function affectedCommand(args) {
  const opts = parseArgs(args);
  const cwd = process.cwd();

  // Composite content-hash dispatch when a graph file is supplied.
  if (opts.graph) {
    const graphPath = resolve(cwd, opts.graph);
    if (!existsSync(graphPath)) {
      console.error(`Graph file not found: ${opts.graph}`);
      process.exitCode = 1;
      return;
    }
    const current = readGraphFile(graphPath);
    const baseline = loadBaselineGraph({ cwd, graphPath: opts.graph, since: opts.since });
    const result = affectedFromGraphs(current, baseline);
    if (opts.json) {
      console.log(JSON.stringify({ graph: opts.graph, since: opts.since, ...result }, null, 2));
    } else {
      printCompositeReport(result, { graph: opts.graph, since: opts.since });
    }
    return;
  }

  // Legacy git-citation mode (unchanged).
  const { contentDir } = resolveContentDir(cwd, opts.content);
  const result = affected({ ref: opts.ref, contentDir, cwd });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }
}
