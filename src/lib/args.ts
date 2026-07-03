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
