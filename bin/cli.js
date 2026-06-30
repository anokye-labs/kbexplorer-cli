#!/usr/bin/env node

/**
 * kbx CLI — turn any repo into a navigable knowledge graph.
 *
 * Commands:
 *   init       Add .kbx submodule + install agents/skills + configure
 *   generate   Run architect → transform → writer content pipeline
 *   dev        Start dev server in local mode
 *   build      Production build
 *   manifest   Regenerate repo manifest
 *   update     Pull latest template + refresh agents/skills
 *   doctor     Diagnose local runtime, MCP, template setup, and adoption readiness
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  links: '../src/commands/links.js',
  audit: '../src/commands/audit.js',
  validate: '../src/commands/validate.js',
  affected: '../src/commands/affected.js',
  scaffold: '../src/commands/scaffold.js',
  derive: '../src/commands/derive.js',
  connect: '../src/commands/connect.js',
  doctor: '../src/commands/doctor.js',
  plugin: '../src/commands/plugin.js',
  'search-index': '../src/commands/search-index.js',
  search: '../src/commands/search.js',
};

function printUsage() {
  console.log(`
  kbx — Interactive Knowledge Base Explorer CLI

  Usage: kbx <command> [options]

  Commands:
    init        Add .kbx submodule, install agents/skills, configure
    generate    Run content generation pipeline (architect → transform → writer)
    dev         Start dev server in local mode
    build       Production build
    manifest    Regenerate repo manifest from local data
    links       Analyze graph health (orphans, broken refs, coverage gaps)
    audit       Schema/structural validation (duplicate ids, broken parents, cycles)
    validate    Deterministic content-model/ descriptor gate (FK refs, kinds, cycles)
    affected    Map a git diff to impacted content nodes via citations
    scaffold    Create a new content/<slug>.md skeleton with valid frontmatter
    derive      Extract entities from .docx/prose into committed *.jsonld (F8)
    connect     Persist + drift-check the cross-source connection layer (.kbx/connection/)
    search-index  Build or check semantic search artifacts
    search      Semantic search over the knowledge graph
    update      Pull latest template + refresh agents/skills
    doctor      Diagnose local runtime, MCP, template setup, and adoption readiness
    plugin      Install or share the kbx Copilot plugin bundle (install/share/resolve)

  Options:
    --help      Show this help message
    --version   Show version

  init options:
    --template, -t <url>       Install from a custom template repo
    --ref, --branch <ref>      Install a specific template tag or branch
    --vendor, --no-submodule   One-time copy instead of a git submodule
    --mode <submodule|vendor>  Install mode (alternative to --vendor)
    --yes, -y                  Non-interactive onboarding (CI / templated)
    --owner/--repo/--kb-branch/--title   Headless scaffold values
    --content-mode/--content/--visual/--theme/--runtime   Headless options
    --config <file>            JSON defaults file for --yes

  generate options:
    --prompt, -p <text>        Override the architect prompt sent to copilot
    --model <model>            Model to use (copilot --model)
    --allow-tool <spec>        Scoped tool permission, repeatable (e.g. 'shell(git)')
    --allow-all-tools          Allow all tools (default for the agent step)
    --no-agent                 Skip the copilot step; only transform an existing catalogue
    --refresh, --force         Re-run the agent even if catalogue.json exists
    --dry-run                  Print the assembled copilot command and exit

  derive options:
    <source...>                One or more .docx/.md/.markdown/.txt sources
    --out, -o <dir>            Output directory for *.jsonld (default content/derived)
    --check                    Drift check: non-zero exit if a committed artifact is stale
    --refresh, --force         Re-run fuzzy extraction even if a fresh artifact exists
    --dry-run                  Print the assembled copilot command + planned outputs

  dev options:
    --no-watch                 Don't watch host content for changes (one-shot manifest)
    (other args forwarded to Vite, e.g. --host, --port)

  validate options:
    --content-model <dir>      Descriptor directory to validate (default: content-model)
    --dir <dir>                Alias of --content-model
    --json                     Emit machine-readable JSON

  doctor options:
    --runtime <name>           Check a specific adapter ("copilot" | "claude" | "custom")
    --json                     Emit machine-readable JSON
    --offline                  Skip network-dependent checks (latest tag lookup)

  Examples:
    npx kbx init
    npx kbx init --template https://github.com/my-org/my-template.git
    npx kbx init --vendor --ref main
    npx kbx generate
    npx kbx derive docs/org-chart.docx
    npx kbx derive docs/*.md --check
    npx kbx dev
    npx kbx build --base /docs/
    npx kbx validate
    npx kbx validate --json
    npx kbx doctor
    npx kbx doctor --runtime claude
    npx kbx doctor --json
    npx kbx plugin install --scope user
    npx kbx plugin share
`);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkgUrl = pathToFileURL(resolve(__dirname, '..', 'package.json')).href;
  const pkg = await import(pkgUrl, { with: { type: 'json' } });
  console.log(pkg.default.version);
  process.exit(0);
}

if (!COMMANDS[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run "kbx --help" for usage.`);
  process.exit(1);
}

const mod = await import(COMMANDS[command]);
await mod.default(args.slice(1));
