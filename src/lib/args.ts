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

export function parseInitArgs(args: string[] = []): InitArgs {
  const out: InitArgs = {
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
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--template':
      case '-t':
        out.template = args[++i] ?? null;
        break;
      case '--ref':
      case '--branch':
        out.ref = args[++i] ?? null;
        break;
      case '--vendor':
      case '--no-submodule':
        out.vendor = true;
        break;
      case '--mode':
        out.mode = args[++i] ?? null;
        break;
      case '--yes':
      case '-y':
        out.yes = true;
        break;
      case '--owner':
        out.owner = args[++i] ?? null;
        break;
      case '--repo':
        out.repo = args[++i] ?? null;
        break;
      case '--kb-branch':
        out.kbBranch = args[++i] ?? null;
        break;
      case '--title':
        out.title = args[++i] ?? null;
        break;
      case '--content-mode':
        out.contentMode = args[++i] ?? null;
        break;
      case '--content':
        out.content = args[++i] ?? null;
        break;
      case '--visual':
        out.visual = args[++i] ?? null;
        break;
      case '--theme':
        out.theme = args[++i] ?? null;
        break;
      case '--runtime':
        out.runtime = args[++i] ?? null;
        break;
      case '--runtime-command':
        out.runtimeCommand = args[++i] ?? null;
        break;
      case '--runtime-args':
        out.runtimeArgs = args[++i] ?? null;
        break;
      case '--runtime-output':
        out.runtimeOutput = args[++i] ?? null;
        break;
      case '--config':
        out.config = args[++i] ?? null;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.unknown.push(a);
    }
  }

  if (out.mode === 'vendor') out.vendor = true;
  return out;
}

export function parseGenerateArgs(args: string[] = []): GenerateArgs {
  const out: GenerateArgs = {
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
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--prompt':
      case '-p':
        out.prompt = args[++i] ?? null;
        break;
      case '--model':
        out.model = args[++i] ?? null;
        break;
      case '--allow-tool':
        if (args[i + 1] != null) out.allowTools.push(args[++i]);
        break;
      case '--allow-all-tools':
        out.allowAllTools = true;
        break;
      case '--timeout': {
        const n = Number(args[++i]);
        out.timeout = Number.isFinite(n) ? n : null;
        break;
      }
      case '--no-agent':
        out.noAgent = true;
        break;
      case '--refresh':
      case '--force':
        out.refresh = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--runtime':
        out.runtime = args[++i] ?? null;
        break;
      case '--skip-preflight':
        out.skipPreflight = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.unknown.push(a);
    }
  }

  return out;
}

export function parseDeriveArgs(args: string[] = []): DeriveArgs {
  const out: DeriveArgs = {
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
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--out':
      case '-o':
        out.out = args[++i] ?? null;
        break;
      case '--context':
        out.context = args[++i] ?? null;
        break;
      case '--check':
        out.check = true;
        break;
      case '--refresh':
      case '--force':
        out.refresh = true;
        break;
      case '--model':
        out.model = args[++i] ?? null;
        break;
      case '--allow-tool':
        if (args[i + 1] != null) out.allowTools.push(args[++i]);
        break;
      case '--allow-all-tools':
        out.allowAllTools = true;
        break;
      case '--timeout': {
        const n = Number(args[++i]);
        out.timeout = Number.isFinite(n) ? n : null;
        break;
      }
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--runtime':
        out.runtime = args[++i] ?? null;
        break;
      case '--skip-preflight':
        out.skipPreflight = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (a.startsWith('-')) out.unknown.push(a);
        else out.sources.push(a);
    }
  }

  return out;
}

export function parseUpdateArgs(args: string[] = []): UpdateArgs {
  const out: UpdateArgs = { force: false, help: false, unknown: [] };
  for (const a of args) {
    switch (a) {
      case '--force':
      case '-f':
        out.force = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.unknown.push(a);
    }
  }
  return out;
}

export function parseDoctorArgs(args: string[] = []): DoctorArgs {
  const out: DoctorArgs = { runtime: null, json: false, offline: false, help: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--runtime':
        out.runtime = args[++i] ?? null;
        break;
      case '--json':
        out.json = true;
        break;
      case '--offline':
        out.offline = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.unknown.push(a);
    }
  }
  return out;
}
