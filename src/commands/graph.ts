/**
 * kbx graph — thin wiring over the engine's authored-content-graph helpers
 * (anokye-labs/kbexplorer-engine#18/#19, epic anokye-labs/kbexplorer-template#463).
 *
 * NAMESPACE NOTE: this is a *different* domain from the existing top-level
 * `kbx validate` (content-model/ descriptor tree) and `kbx derive` (docx/prose
 * → JSON-LD). `kbx graph <sub>` operates over the authored-content graph
 * (content/*.md + config.yaml + catalogue.json) via five engine exports:
 *
 *   kbx graph validate   → validateGraph(input)       — gates (exit 1 on error)
 *   kbx graph assess     → assessGraph(input, opts)   — non-gating quality scoring; --gate exits 1 on sub-threshold scores
 *   kbx graph derive     → deriveNeeds(catalogue, contentFiles)
 *   kbx graph compare    → compareContent(catalogue, contentFiles)
 *   kbx graph enrich     → enrichFromManifest(catalogue, manifest)
 *
 * The CLI holds no graph-domain logic here: it only resolves argv into the
 * engine functions' input shapes, calls them, and renders the result (human
 * report by default, `--json` for machine-readable output). All structural
 * rules, scoring, and catalogue-pipeline logic live in the engine.
 */

import { resolve, basename, extname } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  validateGraph,
  assessGraph,
  deriveNeeds,
  compareContent,
  enrichFromManifest,
  type GraphValidationInput,
  type GraphValidationResult,
  type ValidationFinding,
  type GraphAssessmentInput,
  type AssessmentResult,
  type Catalogue,
  type CatalogueContentFiles,
  type DeriveNeedsResult,
  type CompareContentResult,
  type EnrichFromManifestResult,
} from '@anokye-labs/kbexplorer-engine';
import { buildRepoManifest, type RepoManifest } from '../lib/manifest-build.ts';
import { resolveContentDir } from '../lib/kb-env.ts';
import {
  parseGraphArgs,
  parseGraphValidateArgs,
  parseGraphAssessArgs,
  parseGraphDeriveArgs,
  parseGraphCompareArgs,
  parseGraphEnrichArgs,
} from '../lib/args.ts';

const USAGE = `
  kbx graph — authored-content graph validate/assess/derive/compare/enrich

  Usage: kbx graph <subcommand> [options]

  Subcommands:
    validate    Structural integrity gate (dangling links, dup ids, ...) — exits 1 on error
    assess      Non-gating quality scoring + suggestions — --gate exits 1 on sub-threshold scores
    derive      Report catalogue.json nodes missing authored content
    compare     Compare catalogue.json against existing content files
    enrich      Cross-reference catalogue.json with repo issues/PRs/commits

  Common options:
    --content <dir>    Content directory (default: content)
    --json             Emit machine-readable JSON
    --help, -h         Show this help

  validate/assess additionally build a RepoManifest slice via the engine's
  buildManifest() (local FileSystemSource — no live GitHub data).

  derive/compare/enrich additionally read content/catalogue.json:
    --catalogue <file>  Override the catalogue.json path

  compare options:
    --baseline <dir>    Content-files directory to compare against (default: --content)

  enrich options:
    --manifest <file>   Read a RepoManifest JSON file instead of building one
    --repo <owner/name> Build a remote RepoManifest via the GitHub API
    --out <file>        Output path (default: <content>/catalogue-enriched.json)

  Examples:
    kbx graph validate
    kbx graph validate --json
    kbx graph assess --gate
    kbx graph derive --json
    kbx graph compare --baseline content
    kbx graph enrich --repo anokye-labs/kbexplorer-cli
`;

/** Read `${dir}/*.md` into a `CatalogueContentFiles` map keyed by node id (filename minus `.md`). */
function readContentFiles(dir: string): CatalogueContentFiles {
  const out: CatalogueContentFiles = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (extname(entry) !== '.md') continue;
    out[basename(entry, '.md')] = readFileSync(resolve(dir, entry), 'utf-8');
  }
  return out;
}

/** Load + parse `content/catalogue.json`; prints an error and returns null when absent/invalid. */
function loadCatalogue(catalogueFile: string): Catalogue | null {
  if (!existsSync(catalogueFile)) {
    console.error(`✗ Catalogue not found at ${catalogueFile} — run the kb-architect pipeline first.`);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(catalogueFile, 'utf-8')) as Catalogue;
    if (!Array.isArray(parsed.nodes)) {
      console.error(`✗ ${catalogueFile} is missing a "nodes" array.`);
      return null;
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ Failed to parse ${catalogueFile}: ${message}`);
    return null;
  }
}

function printValidateHuman(result: GraphValidationResult): void {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          Graph Validation                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Content files:  ${result.summary.contentCount}`);
  console.log(`  Issues:         ${result.summary.issueCount}`);
  console.log(`  Errors:         ${result.errorCount}`);
  console.log(`  Warnings:       ${result.warningCount}`);
  console.log('');

  if (result.findings.length === 0) {
    console.log('✅ Graph is valid.');
    console.log('');
    return;
  }

  const grouped = new Map<string, ValidationFinding[]>();
  for (const f of result.findings) {
    if (!grouped.has(f.rule)) grouped.set(f.rule, []);
    grouped.get(f.rule)?.push(f);
  }
  for (const [rule, items] of grouped) {
    const marker = items[0].severity === 'error' ? '✗' : '⚠';
    console.log(`${marker} ${rule} (${items.length}):`);
    for (const f of items.slice(0, 50)) {
      const where = f.nodeId ?? f.target ?? '';
      const arrow = f.nodeId && f.target ? ` → ${f.target}` : '';
      console.log(`  ${where}${arrow}`);
      console.log(`    ${f.message}`);
    }
    if (items.length > 50) console.log(`  ... and ${items.length - 50} more`);
    console.log('');
  }
}

function printAssessHuman(result: AssessmentResult): void {
  console.log('');
  console.log(
    `Graph: ${result.summary.nodeCount} nodes, ${result.summary.edgeCount} edges, ${result.summary.clusterCount} clusters`,
  );
  console.log('');
  console.log('── Constraints ──');
  const { nodeCount, edgeCount, clusterCount, orphanNodes, hubReachability } = result.constraints;
  console.log(`${nodeCount.ok ? '✅' : '⚠️ '} Node count: ${nodeCount.value} (limit: ${nodeCount.limit})`);
  console.log(`${edgeCount.ok ? '✅' : '⚠️ '} Edge count: ${edgeCount.value} (limit: ${edgeCount.limit})`);
  console.log(`${clusterCount.ok ? '✅' : '❌'} Clusters: ${clusterCount.value} (limit: ${clusterCount.limit})`);
  if (orphanNodes.length === 0) {
    console.log('✅ No orphan nodes');
  } else {
    console.log(`⚠️  ${orphanNodes.length} orphan node(s): ${orphanNodes.join(', ')}`);
  }
  if (hubReachability.unreachable.length > 0) {
    console.log(
      `❌ Hub reachability: ${hubReachability.unreachable.length} node(s) unreachable from hub "${hubReachability.hubId}"`,
    );
  } else {
    console.log(`✅ Hub reachability: all within ${hubReachability.maxHops} hops of hub "${hubReachability.hubId}"`);
  }
  console.log('');
  console.log('── Quality Scores ──');
  const { scores, scoreDetails } = result;
  console.log(`Connectivity:     ${scores.connectivity}/100`);
  console.log(`Cluster balance:  ${scoreDetails.clusterBalanceApplicable ? `${scores.clusterBalance}/100` : 'N/A'}`);
  console.log(`Link density:     ${scores.density}/100`);
  console.log(`Bidirectionality: ${scores.bidirectionality}/100`);
  console.log(`Content depth:    ${scores.contentDepth}/100`);
  console.log('');
  console.log('── Suggestions ──');
  if (result.suggestions.length === 0) {
    console.log('No suggestions — graph looks great!');
  } else {
    result.suggestions.forEach((s, i) => console.log(`${i + 1}. ${s}`));
  }
  console.log('');
  if (result.gate) {
    if (result.gate.pass) {
      console.log('✅ Quality gate passed — all scores above minimums.');
    } else {
      console.log('❌ Quality gate FAILED — scores below minimums:');
      for (const f of result.gate.failures) {
        console.log(`  ${f.metric} = ${f.actual}/100 (minimum: ${f.minimum})`);
      }
    }
    console.log('');
  }
}

function printDeriveHuman(result: DeriveNeedsResult): void {
  console.log(`${result.total} catalogue nodes, ${result.authored} authored, ${result.derived} need generation:`);
  for (const n of result.nodes) {
    console.log(`  - ${n.id}${n.file ? ` (${n.file})` : ''}`);
  }
  if (result.nodes.length === 0) {
    console.log('  (none — all nodes have content)');
  }
}

function printCompareHuman(result: CompareContentResult): void {
  console.log(`Comparing catalogue (${result.totalNodes} nodes) to content (${result.totalContentFiles} files)`);
  console.log('');
  console.log('── Coverage ──');
  console.log(`Authored (preserved):      ${result.authoredNodes.length}`);
  console.log(`Derived (current):         ${result.derivedCurrent.length}`);
  console.log(`Missing (needs gen):       ${result.missingNodes.length}`);
  console.log(`Extra (not in catalogue):  ${result.extraFiles.length}`);
  for (const n of result.missingNodes) console.log(`  ${n.id}: needs generation`);
  for (const id of result.extraFiles) console.log(`  ${id}: orphaned from catalogue`);
  console.log('');
  console.log('── Drift ──');
  console.log(`Cluster changes: ${result.clusterChanges.length}`);
  for (const c of result.clusterChanges) console.log(`  ${c.id}: ${c.from} → ${c.to}`);
  console.log(`Link count changes: ${result.linkDiffs.length} node(s) differ by >3 links`);
  for (const d of result.linkDiffs) console.log(`  ${d.id}: catalogue=${d.catalogue}, file=${d.file}`);
}

function printEnrichHuman(result: EnrichFromManifestResult, outPath: string): void {
  const s = result.summary;
  console.log(`${s.issueCount} issues, ${s.prCount} PRs, ${s.commitCount} commits`);
  console.log(`Enriched ${s.totalNodes} nodes:`);
  console.log(`  ${s.nodesWithIssues} have related issues`);
  console.log(`  ${s.nodesWithPRs} have related PRs`);
  console.log(`  ${s.nodesWithCommits} have related commits`);
  console.log(`Written to ${outPath}`);
}

async function runValidate(cwd: string, args: string[]): Promise<void> {
  const opts = parseGraphValidateArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const manifest = await buildRepoManifest(cwd, { contentOverride: opts.content ?? undefined });
  const input: GraphValidationInput = {
    authoredContent: manifest.authoredContent,
    configRaw: manifest.configRaw,
    nodemapRaw: manifest.nodemapRaw,
    tree: manifest.tree,
    issues: manifest.issues,
  };
  const result = validateGraph(input);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printValidateHuman(result);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function runAssess(cwd: string, args: string[]): Promise<void> {
  const opts = parseGraphAssessArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const manifest = await buildRepoManifest(cwd, { contentOverride: opts.content ?? undefined });
  const input: GraphAssessmentInput = { authoredContent: manifest.authoredContent };
  const result = assessGraph(input, { gate: opts.gate });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printAssessHuman(result);
  }
  // Default: non-gating (engine#18) — always exits 0.
  // Opt-in: --gate turns quality thresholds into a real CI gate (exit 1 on failure).
  if (opts.gate && result.gate && !result.gate.pass) {
    process.exitCode = 1;
  }
}

function runDerive(cwd: string, args: string[]): void {
  const opts = parseGraphDeriveArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { contentDir } = resolveContentDir(cwd, opts.content ?? undefined);
  const catalogueFile = opts.catalogue ? resolve(cwd, opts.catalogue) : resolve(contentDir, 'catalogue.json');
  const catalogue = loadCatalogue(catalogueFile);
  if (!catalogue) {
    process.exitCode = 1;
    return;
  }
  const contentFiles = readContentFiles(contentDir);
  const result = deriveNeeds(catalogue, contentFiles);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDeriveHuman(result);
  }
}

function runCompare(cwd: string, args: string[]): void {
  const opts = parseGraphCompareArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { contentDir } = resolveContentDir(cwd, opts.content ?? undefined);
  const catalogueFile = opts.catalogue ? resolve(cwd, opts.catalogue) : resolve(contentDir, 'catalogue.json');
  const catalogue = loadCatalogue(catalogueFile);
  if (!catalogue) {
    process.exitCode = 1;
    return;
  }
  const baselineDir = opts.baseline ? resolve(cwd, opts.baseline) : contentDir;
  const contentFiles = readContentFiles(baselineDir);
  const result = compareContent(catalogue, contentFiles);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printCompareHuman(result);
  }
}

async function runEnrich(cwd: string, args: string[]): Promise<void> {
  const opts = parseGraphEnrichArgs(args);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { contentDir } = resolveContentDir(cwd, opts.content ?? undefined);
  const catalogueFile = opts.catalogue ? resolve(cwd, opts.catalogue) : resolve(contentDir, 'catalogue.json');
  const catalogue = loadCatalogue(catalogueFile);
  if (!catalogue) {
    process.exitCode = 1;
    return;
  }

  let manifest: RepoManifest;
  if (opts.manifest) {
    const manifestFile = resolve(cwd, opts.manifest);
    if (!existsSync(manifestFile)) {
      console.error(`✗ Manifest not found at ${manifestFile}. Run \`kbx manifest\` first.`);
      process.exitCode = 1;
      return;
    }
    manifest = JSON.parse(readFileSync(manifestFile, 'utf-8')) as RepoManifest;
  } else {
    manifest = await buildRepoManifest(cwd, { contentOverride: opts.content ?? undefined, repo: opts.repo ?? undefined });
  }

  const result = enrichFromManifest(catalogue, manifest);
  const outPath = opts.out ? resolve(cwd, opts.out) : resolve(contentDir, 'catalogue-enriched.json');
  writeFileSync(outPath, JSON.stringify(result.catalogue, null, 2), 'utf-8');

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printEnrichHuman(result, outPath);
  }
}

export default async function graph(args: string[] = []): Promise<void> {
  const opts = parseGraphArgs(args);
  const cwd = process.cwd();

  if (opts.help || !opts.sub) {
    console.log(USAGE);
    return;
  }

  switch (opts.sub) {
    case 'validate':
      await runValidate(cwd, opts._);
      return;
    case 'assess':
      await runAssess(cwd, opts._);
      return;
    case 'derive':
      runDerive(cwd, opts._);
      return;
    case 'compare':
      runCompare(cwd, opts._);
      return;
    case 'enrich':
      await runEnrich(cwd, opts._);
      return;
    default:
      console.error(`Unknown graph subcommand: ${opts.sub}`);
      console.error('Run "kbx graph --help" for usage.');
      process.exitCode = 1;
  }
}
