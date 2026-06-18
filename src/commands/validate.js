/**
 * kbexplorer validate — deterministic content-model descriptor gate.
 *
 * Validates the structured `content-model/` descriptor tree (person / team /
 * workstream / priority / system-of-record) that `kbexplorer audit` (markdown
 * only) never inspects. Runs with NO LLM and NO `gh` auth, so it is safe as a
 * blocking PR gate.
 *
 * Checks: per-kind required fields, FK edge resolution (dangling refs fail),
 * relation taxonomy on explicit `relations:` entries, unique id per kind, and
 * reports-to (person.manager) cycle detection.
 *
 * Usage:
 *   kbexplorer validate                       # human report, exits 1 on any error
 *   kbexplorer validate --json                # machine-readable JSON to stdout
 *   kbexplorer validate --content-model <dir> # override descriptor directory
 *   kbexplorer validate --dir <dir>           # alias of --content-model
 */

import { resolve } from 'node:path';
import { validateContentModel } from '../lib/content-model.js';

function parseArgs(args) {
  const out = { json: false, dir: null, help: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--content-model' || a === '--dir') out.dir = args[++i] ?? null;
    else if (a.startsWith('--content-model=')) out.dir = a.slice('--content-model='.length);
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length);
    else out.unknown.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`
  kbexplorer validate — deterministic content-model descriptor gate

  Usage: kbexplorer validate [options]

  Options:
    --content-model <dir>   Descriptor directory to validate (default: content-model)
    --dir <dir>             Alias of --content-model
    --json                  Emit machine-readable JSON
    --help, -h              Show this help

  Exit codes:
    0   no errors (clean tree, or no content-model directory present)
    1   one or more error-severity findings
`);
}

function printHumanReport({ findings, summary }) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Content-Model Validation           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (!summary.exists) {
    console.log('  No content-model directory found — nothing to validate.');
    console.log('');
    return;
  }
  const kinds = Object.entries(summary.byKind)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  console.log(`  Descriptors:    ${summary.descriptors}${kinds ? `  (${kinds})` : ''}`);
  console.log(`  Errors:         ${summary.errors}`);
  console.log(`  Warnings:       ${summary.warnings}`);
  console.log('');

  if (findings.length === 0) {
    console.log('✅ Content model is valid.');
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
    for (const f of items.slice(0, 50)) {
      const where = f.file ? f.file : f.files ? f.files.join(', ') : f.id || '';
      console.log(`  ${where}`);
      console.log(`    ${f.message}`);
    }
    if (items.length > 50) console.log(`  ... and ${items.length - 50} more`);
    console.log('');
  }
}

export default async function validateCommand(args) {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const dir = opts.dir
    || process.env.VITE_KB_CONTENT_MODEL
    || 'content-model';
  const rootDir = resolve(cwd, dir);

  const result = validateContentModel({ rootDir });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }

  if (result.summary.errors > 0) {
    process.exit(1);
  }
}
