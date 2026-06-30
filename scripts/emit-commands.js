#!/usr/bin/env node
/**
 * Emit the kbx plugin command surface (PE1-F2 / #146).
 *
 * Renders every entry in src/lib/command-surface.js into a Markdown command
 * file under src/assets/commands/. The rendering is deterministic, so this is
 * the writer half of a derive-style drift gate:
 *
 *   node scripts/emit-commands.js           # write/refresh the asset files
 *   node scripts/emit-commands.js --check    # exit non-zero if any file drifted
 *
 * The committed src/assets/commands/*.md files are what the plugin bundle
 * (src/lib/plugin-bundle.js) copies into an installed plugin.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const COMMANDS_DIR = resolve(ROOT, 'src', 'assets', 'commands');

const { renderAllCommands, validateSurface } = await import(
  pathToFileURL(resolve(ROOT, 'src', 'lib', 'command-surface.js')).href
);

function listExisting(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

function main() {
  const check = process.argv.includes('--check');

  const surfaceValidity = validateSurface();
  if (!surfaceValidity.valid) {
    console.error('✗ command surface is invalid:');
    for (const e of surfaceValidity.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const rendered = renderAllCommands();
  const expectedFiles = new Set(rendered.map((r) => r.file));
  const drift = [];

  for (const { file, content } of rendered) {
    const path = join(COMMANDS_DIR, file);
    const current = existsSync(path) ? readFileSync(path, 'utf-8') : null;
    if (current !== content) {
      drift.push(file);
      if (!check) {
        mkdirSync(COMMANDS_DIR, { recursive: true });
        writeFileSync(path, content);
      }
    }
  }

  // Any extra .md file that is no longer part of the surface is drift too.
  for (const file of listExisting(COMMANDS_DIR)) {
    if (!expectedFiles.has(file)) {
      drift.push(file);
      if (!check) rmSync(join(COMMANDS_DIR, file), { force: true });
    }
  }

  if (check) {
    if (drift.length > 0) {
      console.error('✗ command assets are out of date. Run: node scripts/emit-commands.js');
      for (const f of [...new Set(drift)].sort()) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`✓ ${rendered.length} command assets are up to date.`);
    return;
  }

  if (drift.length > 0) {
    console.log(`✓ wrote ${[...new Set(drift)].length} command asset(s) to ${COMMANDS_DIR}`);
  } else {
    console.log(`✓ ${rendered.length} command assets already up to date.`);
  }
}

main();
