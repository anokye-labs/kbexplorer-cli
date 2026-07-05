/**
 * kbx validate — deterministic content-model descriptor gate.
 *
 * Validates the structured `content-model/` descriptor tree (person / team /
 * workstream / priority / system-of-record) that `kbx audit` (markdown
 * only) never inspects. Runs with NO LLM and NO `gh` auth, so it is safe as a
 * blocking PR gate.
 *
 * Checks: per-kind required fields, FK edge resolution (dangling refs fail),
 * relation taxonomy on explicit `relations:` entries, unique id per kind, and
 * reports-to (person.manager) cycle detection.
 *
 * Usage:
 *   kbx validate                       # human report, exits 1 on any error
 *   kbx validate --json                # machine-readable JSON to stdout
 *   kbx validate --content-model <dir> # override descriptor directory
 *   kbx validate --dir <dir>           # alias of --content-model
 */

import { resolve } from 'node:path';
import { validateContentModel } from '../lib/descriptor-model.ts';
import { parseValidateArgs as parseSharedValidateArgs, type ValidateArgs } from '../lib/args.ts';

type ValidateResult = ReturnType<typeof validateContentModel>;
type ValidateFinding = ValidateResult['findings'][number];

function parseArgs(args: string[] = []): ValidateArgs {
  return parseSharedValidateArgs(args);
}

function printHelp() {
  console.log(`
  kbx validate — deterministic content-model descriptor gate

  Usage: kbx validate [options]

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

function printHumanReport({ findings, summary }: ValidateResult): void {
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

  const grouped = new Map<string, ValidateFinding[]>();
  for (const f of findings) {
    if (!grouped.has(f.rule)) grouped.set(f.rule, []);
    grouped.get(f.rule)?.push(f);
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

export default async function validateCommand(args: string[] = []): Promise<void> {
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

