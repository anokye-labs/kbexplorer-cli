/**
 * Minimal declarative argument parser for kbx commands.
 */

export function parseArgs(spec = {}, argv = []) {
  const out = { ...(spec.defaults ?? {}) };
  const optionSpecs = spec.options ?? [];
  const positionalsKey = spec.positionals;
  const collectUnknown = spec.collectUnknown !== false;
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
   const arg = argv[i];
   if (arg === '--') {
     positionals.push(...argv.slice(i + 1));
     break;
   }

   let matched = false;
   for (const option of optionSpecs) {
     const alias = option.aliases.find((candidate) => candidate === arg || arg.startsWith(`${candidate}=`));
     if (!alias) continue;

     matched = true;
     if (option.type === 'boolean') {
       out[option.name] = true;
     } else {
       let value;
       const equalsIndex = arg.indexOf('=');
       const acceptsEquals = option.acceptEquals ?? option.type !== 'boolean';
       if (acceptsEquals && equalsIndex >= 0) {
         value = arg.slice(equalsIndex + 1);
       } else {
         value = argv[++i];
       }
       if (value === undefined) value = null;
       if (option.type === 'number') {
         const n = Number(value);
         out[option.name] = Number.isFinite(n) ? n : null;
       } else if (option.type === 'array') {
         if (value !== null) out[option.name].push(value);
       } else if (option.parser) {
         out[option.name] = option.parser(value);
       } else {
         out[option.name] = value;
       }
     }
     break;
   }

   if (matched) continue;

   if (arg.startsWith('-') && arg !== '-') {
     if (collectUnknown) out.unknown.push(arg);
   } else if (positionalsKey) {
     positionals.push(arg);
   } else if (collectUnknown) {
     out.unknown.push(arg);
   }
  }

  if (positionalsKey) {
   out[positionalsKey] = positionals;
  }

  return out;
}

/**
 * Parse `init` arguments.
 *
 * Supported flags:
 *   --template, -t <url>        Template repo to install from (default: org template).
 *   --ref, --branch <tag|name>  Specific template tag or branch to install.
 *   --vendor, --no-submodule    Install as a one-time copy instead of a git submodule.
 *   --mode <submodule|vendor>   Install mode (alternative to --vendor).
 *   --yes, -y                   Non-interactive: take all config from flags/--config + detection.
 *   --owner <name>              GitHub owner (default: detected git remote).
 *   --repo <name>               GitHub repo (default: detected git remote).
 *   --kb-branch <name>          Knowledge-base content branch (default: detected branch).
 *   --title <text>              Knowledge-base title (default: "<repo> Knowledge Base").
 *   --content-mode <m>          repo | authored | both (default: repo).
 *   --content <dir>             Content directory for authored/both modes (default: content).
 *   --visual <m>                emoji | sprites | heroes | none (default: emoji).
 *   --theme <t>                 dark | light | sepia (default: dark).
 *   --runtime <name>            copilot | claude | custom | skip (default: copilot).
 *   --runtime-command <cmd>     Custom runtime command (when --runtime custom).
 *   --runtime-args <tmpl>       Custom runtime args template, space-separated (use {prompt}).
 *   --runtime-output <fmt>      Custom runtime output format (text | jsonl).
 *   --config <file>             JSON file of defaults for any of the above.
 *   --help, -h                  Show help.
 *
 * `--branch` remains an alias of `--ref` (the template ref) for backward
 * compatibility; use `--kb-branch` for the knowledge-base content branch.
 *
 * @param {string[]} args
 * @returns {object}
 */
export function parseInitArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       template: null,
       ref: null,
       vendor: false,
       help: false,
       yes: false,
       owner: null,
       repo: null,
       kbBranch: null,
       title: null,
       mode: null,
       contentMode: null,
       content: null,
       visual: null,
       theme: null,
       runtime: null,
       runtimeCommand: null,
       runtimeArgs: null,
       runtimeOutput: null,
       config: null,
       unknown: [],
     },
     options: [
       { name: 'template', aliases: ['--template', '-t'], type: 'value' },
       { name: 'ref', aliases: ['--ref', '--branch'], type: 'value' },
       { name: 'vendor', aliases: ['--vendor', '--no-submodule'], type: 'boolean' },
       { name: 'mode', aliases: ['--mode'], type: 'value' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'yes', aliases: ['--yes', '-y'], type: 'boolean' },
       { name: 'owner', aliases: ['--owner'], type: 'value' },
       { name: 'repo', aliases: ['--repo'], type: 'value' },
       { name: 'kbBranch', aliases: ['--kb-branch'], type: 'value' },
       { name: 'title', aliases: ['--title'], type: 'value' },
       { name: 'contentMode', aliases: ['--content-mode'], type: 'value' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'visual', aliases: ['--visual'], type: 'value' },
       { name: 'theme', aliases: ['--theme'], type: 'value' },
       { name: 'runtime', aliases: ['--runtime'], type: 'value' },
       { name: 'runtimeCommand', aliases: ['--runtime-command'], type: 'value' },
       { name: 'runtimeArgs', aliases: ['--runtime-args'], type: 'value' },
       { name: 'runtimeOutput', aliases: ['--runtime-output'], type: 'value' },
       { name: 'config', aliases: ['--config'], type: 'value' },
     ],
   },
   args,
  );
  if (out.mode === 'vendor') out.vendor = true;
  return out;
}

/**
 * Parse `generate` arguments.
 *
 * Supported flags:
 *   --prompt, -p <text>        Override the architect prompt sent to copilot.
 *   --model <model>            Model passed to copilot (`--model`).
 *   --allow-tool <spec>        Scoped tool permission (repeatable). Providing any
 *                              scoped tool disables the implicit `--allow-all-tools`.
 *   --allow-all-tools          Allow all tools (default for the agent step).
 *   --timeout <ms>             Time budget for the programmatic run.
 *   --no-agent                 Skip the fuzzy (copilot) step; deterministic only.
 *   --refresh, --force         Re-run the agent even if catalogue.json exists.
 *   --dry-run                  Print the assembled `copilot -p` command; do not run.
 *   --runtime <name>           Override runtime adapter: "copilot" | "claude" | "custom".
 *   --skip-preflight           Skip MCP preflight check (development escape hatch).
 *   --help, -h                 Show help.
 *
 * @param {string[]} args
 * @returns {{
 *   prompt: string|null, model: string|null, allowTools: string[],
 *   allowAllTools: boolean|null, timeout: number|null, noAgent: boolean,
 *   refresh: boolean, dryRun: boolean, runtime: string|null,
 *   skipPreflight: boolean, help: boolean, unknown: string[]
 * }}
 */
export function parseGenerateArgs(args = []) {
  return parseArgs(
   {
     defaults: {
       prompt: null,
       model: null,
       allowTools: [],
       allowAllTools: null,
       timeout: null,
       noAgent: false,
       refresh: false,
       dryRun: false,
       runtime: null,
       skipPreflight: false,
       help: false,
       unknown: [],
     },
     options: [
       { name: 'prompt', aliases: ['--prompt', '-p'], type: 'value' },
       { name: 'model', aliases: ['--model'], type: 'value' },
       { name: 'allowTools', aliases: ['--allow-tool'], type: 'array' },
       { name: 'allowAllTools', aliases: ['--allow-all-tools'], type: 'boolean' },
       { name: 'timeout', aliases: ['--timeout'], type: 'number' },
       { name: 'noAgent', aliases: ['--no-agent'], type: 'boolean' },
       { name: 'refresh', aliases: ['--refresh', '--force'], type: 'boolean' },
       { name: 'dryRun', aliases: ['--dry-run'], type: 'boolean' },
       { name: 'runtime', aliases: ['--runtime'], type: 'value' },
       { name: 'skipPreflight', aliases: ['--skip-preflight'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

/**
 * Parse `derive` arguments.
 *
 * Supported flags:
 *   <source...>                One or more source files (.docx/.md/.markdown/.txt).
 *   --out <dir>                Output directory for emitted *.jsonld (default content/derived).
 *   --context <ctx>            Override the JSON-LD @context (default schema.org).
 *   --check                    Drift mode: do not write; exit non-zero if any committed
 *                              artifact is stale relative to its source. No LLM call.
 *   --refresh, --force         Re-run fuzzy extraction even if a fresh artifact exists.
 *   --model <model>            Model passed to copilot (`--model`).
 *   --allow-tool <spec>        Scoped tool permission (repeatable); disables implicit allow-all.
 *   --allow-all-tools          Allow all tools (default for the extraction step).
 *   --timeout <ms>             Time budget for the programmatic run.
 *   --dry-run                  Print the assembled copilot command + planned outputs; run nothing.
 *   --runtime <name>           Override runtime adapter: "copilot" | "claude" | "custom".
 *   --skip-preflight           Skip MCP preflight check (development escape hatch).
 *   --help, -h                 Show help.
 *
 * @param {string[]} args
 * @returns {{
 *   sources: string[], out: string|null, context: string|null, check: boolean,
 *   refresh: boolean, model: string|null, allowTools: string[], allowAllTools: boolean|null,
 *   timeout: number|null, dryRun: boolean, runtime: string|null,
 *   skipPreflight: boolean, help: boolean, unknown: string[]
 * }}
 */
export function parseDeriveArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       sources: [],
       out: null,
       context: null,
       check: false,
       refresh: false,
       model: null,
       allowTools: [],
       allowAllTools: null,
       timeout: null,
       dryRun: false,
       runtime: null,
       skipPreflight: false,
       help: false,
       unknown: [],
     },
     options: [
       { name: 'out', aliases: ['--out', '-o'], type: 'value' },
       { name: 'context', aliases: ['--context'], type: 'value' },
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'refresh', aliases: ['--refresh', '--force'], type: 'boolean' },
       { name: 'model', aliases: ['--model'], type: 'value' },
       { name: 'allowTools', aliases: ['--allow-tool'], type: 'array' },
       { name: 'allowAllTools', aliases: ['--allow-all-tools'], type: 'boolean' },
       { name: 'timeout', aliases: ['--timeout'], type: 'number' },
       { name: 'dryRun', aliases: ['--dry-run'], type: 'boolean' },
       { name: 'runtime', aliases: ['--runtime'], type: 'value' },
       { name: 'skipPreflight', aliases: ['--skip-preflight'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
     positionals: 'sources',
   },
   args,
  );
  out.sources = out.sources ?? [];
  return out;
}

/**
 * Parse `update` arguments.
 *
 * Supported flags:
 *   --force, -f   Apply updates without prompting. For vendor installs, replace
 *                 `.kbx/` after backing it up (never clobbers silently).
 *   --help, -h    Show help.
 *
 * @param {string[]} args
 * @returns {{ force: boolean, help: boolean, unknown: string[] }}
 */
export function parseUpdateArgs(args = []) {
  return parseArgs(
   {
     defaults: { force: false, help: false, unknown: [] },
     options: [
       { name: 'force', aliases: ['--force', '-f'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

/**
 * Parse `doctor` arguments.
 *
 * Supported flags:
 *   --runtime <name>   Force a specific adapter for the diagnosis.
 *   --json             Emit machine-readable JSON output.
 *   --offline          Skip network-dependent checks (latest tag lookup).
 *   --help, -h         Show help.
 *
 * @param {string[]} args
 * @returns {{ runtime: string|null, json: boolean, offline: boolean, help: boolean, unknown: string[] }}
 */
export function parseDoctorArgs(args = []) {
  return parseArgs(
   {
     defaults: { runtime: null, json: false, offline: false, help: false, unknown: [] },
     options: [
       { name: 'runtime', aliases: ['--runtime'], type: 'value' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'offline', aliases: ['--offline'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

export function parseAffectedArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { json: false, ref: 'HEAD', content: null, graph: null, since: 'HEAD', unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'graph', aliases: ['--graph'], type: 'value' },
       { name: 'since', aliases: ['--since'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.ref = out.positionals[0] ?? out.ref;
  return out;
}

export function parseAuditArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, content: null, unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'content', aliases: ['--content'], type: 'value' },
     ],
   },
   args,
  );
}

export function parseBuildArgs(args = []) {
  return parseArgs(
   {
     defaults: { base: null, unknown: [] },
     options: [{ name: 'base', aliases: ['--base'], type: 'value' }],
   },
   args,
  );
}

export function parseConnectArgs(args = []) {
  return parseArgs(
   {
     defaults: { check: false, help: false, unknown: [] },
     options: [
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

export function parseDevArgs(args = []) {
  return parseArgs(
   {
     defaults: { noWatch: false, viteArgs: [], unknown: [] },
     options: [{ name: 'noWatch', aliases: ['--no-watch'], type: 'boolean' }],
     positionals: 'viteArgs',
     collectUnknown: false,
   },
   args,
  );
}

export function parseLinksArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, unknown: [] },
     options: [{ name: 'json', aliases: ['--json'], type: 'boolean' }],
   },
   args,
  );
}

export function parseManifestArgs(args = []) {
  return parseArgs({ defaults: { unknown: [] }, options: [] }, args);
}

export function parseMcpArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { help: false, allow: false, skipPreflight: false, name: undefined, unknown: [] },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'allow', aliases: ['--allow'], type: 'boolean' },
       { name: 'skipPreflight', aliases: ['--skip-preflight'], type: 'boolean' },
       { name: 'name', aliases: ['--name'], type: 'value' },
     ],
   },
   args,
  );
  out.name = out.name ?? undefined;
  return out;
}

export function parsePluginArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { sub: null, scope: 'project', sessionDir: null, json: false, help: false, unknown: [] },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'scope', aliases: ['--scope', '-s'], type: 'value' },
       { name: 'sessionDir', aliases: ['--session-dir'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.sub = out.positionals[0] ?? null;
  out._ = out.positionals.slice(1);
  return out;
}

export function parseScaffoldArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       slug: null,
       cluster: null,
       parent: null,
       title: null,
       emoji: null,
       content: null,
       force: false,
       unknown: [],
     },
     options: [
       { name: 'cluster', aliases: ['--cluster'], type: 'value' },
       { name: 'parent', aliases: ['--parent'], type: 'value' },
       { name: 'title', aliases: ['--title'], type: 'value' },
       { name: 'emoji', aliases: ['--emoji'], type: 'value' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'force', aliases: ['--force', '-f'], type: 'boolean' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.slug = out.positionals[0] ?? null;
  return out;
}

export function parseSearchIndexArgs(args = []) {
  return parseArgs(
   {
     defaults: {
       check: false,
       dryRun: false,
       help: false,
       json: false,
       dir: null,
       provider: null,
       model: null,
       content: null,
       batchSize: null,
       unknown: [],
     },
     options: [
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'dryRun', aliases: ['--dry-run'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'dir', aliases: ['--dir'], type: 'value' },
       { name: 'provider', aliases: ['--provider'], type: 'value' },
       { name: 'model', aliases: ['--model'], type: 'value' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'batchSize', aliases: ['--batch-size'], type: 'number' },
     ],
   },
   args,
  );
}

export function parseSearchArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       query: null,
       help: false,
       json: false,
       limit: null,
       cluster: null,
       entityType: null,
       minScore: null,
       dir: null,
       provider: null,
       model: null,
       unknown: [],
     },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'limit', aliases: ['--limit'], type: 'value' },
       { name: 'cluster', aliases: ['--cluster'], type: 'value' },
       { name: 'entityType', aliases: ['--entity-type'], type: 'value' },
       { name: 'minScore', aliases: ['--min-score'], type: 'number' },
       { name: 'dir', aliases: ['--dir'], type: 'value' },
       { name: 'provider', aliases: ['--provider'], type: 'value' },
       { name: 'model', aliases: ['--model'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.query = out.positionals.join(' ') || null;
  return out;
}

export function parseSyncArgs(args = []) {
  return parseArgs(
   {
     defaults: { check: false, json: false, graph: '.kbx/connection/composite-graph.json', since: 'HEAD', against: null, help: false, unknown: [] },
     options: [
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'graph', aliases: ['--graph'], type: 'value' },
       { name: 'since', aliases: ['--since'], type: 'value' },
       { name: 'against', aliases: ['--against'], type: 'value' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

export function parseValidateArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, dir: null, help: false, unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'dir', aliases: ['--content-model', '--dir'], type: 'value' },
     ],
   },
   args,
  );
}
