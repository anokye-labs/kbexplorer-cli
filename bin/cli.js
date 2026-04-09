#!/usr/bin/env node

/**
 * kbexplorer CLI — turn any repo into a navigable knowledge graph.
 *
 * Commands:
 *   init       Add .kbexplorer submodule + install agents/skills + configure
 *   generate   Run architect → transform → writer content pipeline
 *   dev        Start dev server in local mode
 *   build      Production build
 *   manifest   Regenerate repo manifest
 *   update     Pull latest template + refresh agents/skills
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const COMMANDS = {
  init: '../src/commands/init.js',
  generate: '../src/commands/generate.js',
  dev: '../src/commands/dev.js',
  build: '../src/commands/build.js',
  manifest: '../src/commands/manifest.js',
  update: '../src/commands/update.js',
};

function printUsage() {
  console.log(`
  kbexplorer — Interactive Knowledge Base Explorer CLI

  Usage: kbexplorer <command> [options]

  Commands:
    init        Add .kbexplorer submodule, install agents/skills, configure
    generate    Run content generation pipeline (architect → transform → writer)
    dev         Start dev server in local mode
    build       Production build
    manifest    Regenerate repo manifest from local data
    update      Pull latest template + refresh agents/skills

  Options:
    --help      Show this help message
    --version   Show version

  Examples:
    npx kbexplorer init
    npx kbexplorer generate
    npx kbexplorer dev
    npx kbexplorer build --base /docs/
`);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkg = await import(resolve(__dirname, '..', 'package.json'), { with: { type: 'json' } });
  console.log(pkg.default.version);
  process.exit(0);
}

if (!COMMANDS[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run "kbexplorer --help" for usage.`);
  process.exit(1);
}

const mod = await import(COMMANDS[command]);
await mod.default(args.slice(1));
