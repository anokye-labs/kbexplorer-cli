export interface ParseArgsOptionSpec {
  name: string;
  aliases: string[];
  type: 'boolean' | 'value' | 'number' | 'array';
  acceptEquals?: boolean;
  parser?: (value: string) => unknown;
}

export interface ParseArgsSpec {
  defaults?: Record<string, unknown>;
  options?: ParseArgsOptionSpec[];
  positionals?: string;
  collectUnknown?: boolean;
}

export interface InitArgs {
  template: string | null;
  ref: string | null;
  vendor: boolean;
  help: boolean;
  yes: boolean;
  owner: string | null;
  repo: string | null;
  kbBranch: string | null;
  title: string | null;
  mode: string | null;
  contentMode: string | null;
  content: string | null;
  visual: string | null;
  theme: string | null;
  runtime: string | null;
  runtimeCommand: string | null;
  runtimeArgs: string | null;
  runtimeOutput: string | null;
  config: string | null;
  unknown: string[];
}

export interface GenerateArgs {
  prompt: string | null;
  model: string | null;
  allowTools: string[];
  allowAllTools: boolean | null;
  timeout: number | null;
  noAgent: boolean;
  refresh: boolean;
  dryRun: boolean;
  runtime: string | null;
  skipPreflight: boolean;
  help: boolean;
  unknown: string[];
}

export interface DeriveArgs {
  sources: string[];
  out: string | null;
  context: string | null;
  check: boolean;
  refresh: boolean;
  model: string | null;
  allowTools: string[];
  allowAllTools: boolean | null;
  timeout: number | null;
  dryRun: boolean;
  runtime: string | null;
  skipPreflight: boolean;
  help: boolean;
  unknown: string[];
}

export interface UpdateArgs {
  force: boolean;
  help: boolean;
  unknown: string[];
}

export interface DoctorArgs {
  runtime: string | null;
  json: boolean;
  offline: boolean;
  help: boolean;
  unknown: string[];
}

export function parseArgs(spec: ParseArgsSpec = {}, argv: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(spec.defaults ?? {}) };
  const optionSpecs = spec.options ?? [];
  const positionalsKey = spec.positionals;
  const collectUnknown = spec.collectUnknown !== false;
  const positionals: string[] = [];

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
        let value: string | null | undefined;
        const equalsIndex = arg.indexOf('=');
        const acceptsEquals = option.acceptEquals ?? true;
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
          if (value !== null) {
            const list = out[option.name];
            if (Array.isArray(list)) list.push(value);
          }
        } else if (option.parser) {
          out[option.name] = option.parser(value ?? '');
        } else {
          out[option.name] = value;
        }
      }
      break;
    }

    if (matched) continue;

    if (arg.startsWith('-') && arg !== '-') {
      if (collectUnknown) {
        const knownUnknown = out.unknown;
        if (Array.isArray(knownUnknown)) knownUnknown.push(arg);
      }
    } else if (positionalsKey) {
      positionals.push(arg);
    } else if (collectUnknown) {
      const knownUnknown = out.unknown;
      if (Array.isArray(knownUnknown)) knownUnknown.push(arg);
    }
  }

  if (positionalsKey) {
    out[positionalsKey] = positionals;
  }

  return out;
}

export function parseInitArgs(args: string[] = []): InitArgs {
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
  ) as unknown as InitArgs;
  if (out.mode === 'vendor') out.vendor = true;
  return out;
}

export function parseGenerateArgs(args: string[] = []): GenerateArgs {
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
  ) as unknown as GenerateArgs;
}

export function parseDeriveArgs(args: string[] = []): DeriveArgs {
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
  ) as unknown as DeriveArgs;
  out.sources = out.sources ?? [];
  return out;
}

export function parseUpdateArgs(args: string[] = []): UpdateArgs {
  return parseArgs(
    {
      defaults: { force: false, help: false, unknown: [] },
      options: [
        { name: 'force', aliases: ['--force', '-f'], type: 'boolean' },
        { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
      ],
    },
    args,
  ) as unknown as UpdateArgs;
}

export function parseDoctorArgs(args: string[] = []): DoctorArgs {
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
  ) as unknown as DoctorArgs;
}

// ---- parsers merged from former args.js shim (cli#238) ----

export interface AffectedArgs {
  json: boolean;
  ref: string;
  content: string | null;
  graph: string | null;
  since: string;
  positionals: string[];
  unknown: string[];
}

export interface AuditArgs {
  json: boolean;
  content: string | null;
  unknown: string[];
}

export interface BuildArgs {
  base: string | null;
  unknown: string[];
}

export interface ConnectArgs {
  check: boolean;
  help: boolean;
  unknown: string[];
}

export interface DevArgs {
  noWatch: boolean;
  viteArgs: string[];
  unknown: string[];
}

export interface LinksArgs {
  json: boolean;
  unknown: string[];
}

export interface ManifestArgs {
  check: boolean;
  help: boolean;
  unknown: string[];
}

export interface McpArgs {
  help: boolean;
  allow: boolean;
  skipPreflight: boolean;
  name: string | undefined;
  unknown: string[];
}

export interface PluginArgs {
  sub: string | null;
  scope: string;
  sessionDir: string | null;
  json: boolean;
  help: boolean;
  unknown: string[];
  positionals: string[];
  _: string[];
}

export interface ScaffoldArgs {
  slug: string | null;
  cluster: string | null;
  parent: string | null;
  title: string | null;
  emoji: string | null;
  content: string | null;
  force: boolean;
  unknown: string[];
  positionals: string[];
}

export interface SearchIndexArgs {
  check: boolean;
  dryRun: boolean;
  help: boolean;
  json: boolean;
  dir: string | null;
  provider: string | null;
  model: string | null;
  content: string | null;
  batchSize: number | null;
  unknown: string[];
}

export interface SearchArgs {
  query: string | null;
  help: boolean;
  json: boolean;
  limit: number | null;
  cluster: string | null;
  entityType: string | null;
  minScore: number | null;
  dir: string | null;
  provider: string | null;
  model: string | null;
  positionals: string[];
  unknown: string[];
}

export interface SyncArgs {
  check: boolean;
  json: boolean;
  graph: string;
  since: string;
  against: string | null;
  help: boolean;
  unknown: string[];
}

export interface ValidateArgs {
  json: boolean;
  dir: string | null;
  help: boolean;
  unknown: string[];
}

export function parseAffectedArgs(args: string[] = []): AffectedArgs {
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
  ) as unknown as AffectedArgs;
  out.ref = out.positionals[0] ?? out.ref;
  return out;
}

export function parseAuditArgs(args: string[] = []): AuditArgs {
  return parseArgs(
   {
     defaults: { json: false, content: null, unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'content', aliases: ['--content'], type: 'value' },
     ],
   },
   args,
  ) as unknown as AuditArgs;
}

export function parseBuildArgs(args: string[] = []): BuildArgs {
  return parseArgs(
   {
     defaults: { base: null, unknown: [] },
     options: [{ name: 'base', aliases: ['--base'], type: 'value' }],
   },
   args,
  ) as unknown as BuildArgs;
}

export function parseConnectArgs(args: string[] = []): ConnectArgs {
  const out: ConnectArgs = { check: false, help: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) out.unknown.push(arg);
  }
  return out;
}

export function parseDevArgs(args: string[] = []): DevArgs {
  const out = parseArgs(
   {
     defaults: { noWatch: false, viteArgs: [], unknown: [] },
     options: [{ name: 'noWatch', aliases: ['--no-watch'], type: 'boolean' }],
     collectUnknown: false,
   },
   args,
  ) as unknown as DevArgs;
  out.viteArgs = args.filter((arg) => arg !== '--no-watch');
  return out;
}

export function parseLinksArgs(args: string[] = []): LinksArgs {
  return parseArgs(
   {
     defaults: { json: false, unknown: [] },
     options: [{ name: 'json', aliases: ['--json'], type: 'boolean' }],
   },
   args,
  ) as unknown as LinksArgs;
}

export function parseManifestArgs(args: string[] = []): ManifestArgs {
  const out: ManifestArgs = { check: false, help: false, unknown: [] };
  for (const arg of args) {
    if (arg === '--check') out.check = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) out.unknown.push(arg);
  }
  return out;
}

export function parseMcpArgs(args: string[] = []): McpArgs {
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
  ) as unknown as McpArgs;
  out.name = out.name ?? undefined;
  return out;
}

export function parsePluginArgs(args: string[] = []): PluginArgs {
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
  ) as unknown as PluginArgs;
  out.sub = out.positionals[0] ?? null;
  out._ = out.positionals.slice(1);
  return out;
}

export function parseScaffoldArgs(args: string[] = []): ScaffoldArgs {
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
  ) as unknown as ScaffoldArgs;
  out.slug = out.positionals[0] ?? null;
  return out;
}

export function parseSearchIndexArgs(args: string[] = []): SearchIndexArgs {
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
  ) as unknown as SearchIndexArgs;
}

export function parseSearchArgs(args: string[] = []): SearchArgs {
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
       { name: 'limit', aliases: ['--limit'], type: 'number' },
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
  ) as unknown as SearchArgs;
  out.query = out.positionals.join(' ') || null;
  return out;
}

export function parseSyncArgs(args: string[] = []): SyncArgs {
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
  ) as unknown as SyncArgs;
}

export function parseValidateArgs(args: string[] = []): ValidateArgs {
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
  ) as unknown as ValidateArgs;
}

