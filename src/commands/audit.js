/**
 * kbx audit — Schema and structural integrity check.
 *
 * Reports hard errors and warnings that the soft `links` analysis doesn't
 * cover: duplicate ids, malformed frontmatter, missing required fields,
 * broken parent refs, parent cycles, dead connection targets, undeclared
 * clusters.
 *
 * Usage:
 *   kbx audit                # human report, exits 1 on any error
 *   kbx audit --json         # machine-readable JSON to stdout
 *   kbx audit --content X    # override content directory
 */

import { resolve } from 'node:path';
import { audit } from '../lib/audit.js';
import { resolveContentDir } from '../lib/frontmatter.js';

function parseArgs(args) {
  const out = { json: false, content: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--content') out.content = args[++i];
    else if (a.startsWith('--content=')) out.content = a.slice('--content='.length);
  }
  return out;
}

function printHumanReport({ findings, summary }) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Content Audit Report               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Files scanned:  ${summary.files}`);
  console.log(`  Nodes parsed:   ${summary.nodes}`);
  console.log(`  Errors:         ${summary.errors}`);
  console.log(`  Warnings:       ${summary.warnings}`);
  console.log('');

  if (findings.length === 0) {
    console.log('✅ No structural issues found.');
    console.log('');
    return;
  }

  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.rule)) grouped.set(f.rule, []);
    grouped.get(f.rule).push(f);
  }

  for (const [rule, items] of grouped) {
    const marker = items[0].severity === 'error' ? '✗' : '⚠';
    console.log(`${marker} ${rule} (${items.length}):`);
    for (const f of items.slice(0, 20)) {
      const where = f.file
        ? f.file
        : f.files
        ? f.files.join(', ')
        : f.id || '';
      console.log(`  ${where}`);
      console.log(`    ${f.message}`);
    }
    if (items.length > 20) {
      console.log(`  ... and ${items.length - 20} more`);
    }
    console.log('');
  }
}

export default async function auditCommand(args) {
  const opts = parseArgs(args);
  const cwd = process.cwd();
  const { contentDir, contentPath } = resolveContentDir(cwd, opts.content);

  const result = audit({
    contentDir,
    cwd,
    contentPath,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }

  if (result.summary.errors > 0) {
    process.exit(1);
  }
}


