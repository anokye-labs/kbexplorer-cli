/**
 * Minimal, zero-dependency argument parsing for kbexplorer commands.
 */

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
  const out = {
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
  // `--mode vendor` implies a vendored install.
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
  const out = {
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
  const out = {
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

/**
 * Parse `update` arguments.
 *
 * Supported flags:
 *   --force, -f   Apply updates without prompting. For vendor installs, replace
 *                 `.kbexplorer/` after backing it up (never clobbers silently).
 *   --help, -h    Show help.
 *
 * @param {string[]} args
 * @returns {{ force: boolean, help: boolean, unknown: string[] }}
 */
export function parseUpdateArgs(args = []) {
  const out = { force: false, help: false, unknown: [] };
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
  const out = { runtime: null, json: false, offline: false, help: false, unknown: [] };
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
