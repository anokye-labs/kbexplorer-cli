/**
 * kbexplorer affected — Map a git diff to impacted content nodes.
 *
 * Usage:
 *   kbexplorer affected <ref>           # human report
 *   kbexplorer affected <ref> --json    # machine-readable
 *   kbexplorer affected HEAD~5
 *   kbexplorer affected main
 *
 * If <ref> is omitted, defaults to HEAD (working-tree changes).
 */

import { resolve } from 'node:path';
import { affected } from '../lib/affected.js';
import { resolveContentDir } from '../lib/frontmatter.js';

function parseArgs(args) {
  const out = { json: false, ref: 'HEAD', content: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--content') out.content = args[++i];
    else if (a.startsWith('--content=')) out.content = a.slice('--content='.length);
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (positional[0]) out.ref = positional[0];
  return out;
}

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

export default async function affectedCommand(args) {
  const opts = parseArgs(args);
  const cwd = process.cwd();
  const { contentDir } = resolveContentDir(cwd, opts.content);

  const result = affected({ ref: opts.ref, contentDir, cwd });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }
}
