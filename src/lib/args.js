/**
 * Minimal, zero-dependency argument parsing for kbexplorer commands.
 */

/**
 * Parse `init` arguments.
 *
 * Supported flags:
 *   --template, -t <url>        Template repo to install from (default: org template).
 *   --ref, --branch <tag|name>  Specific tag or branch to install.
 *   --vendor, --no-submodule    Install as a one-time copy instead of a git submodule.
 *   --help, -h                  Show help.
 *
 * @param {string[]} args
 * @returns {{ template: string|null, ref: string|null, vendor: boolean, help: boolean, unknown: string[] }}
 */
export function parseInitArgs(args = []) {
  const out = { template: null, ref: null, vendor: false, help: false, unknown: [] };
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

/**
 * Parse `mcp` arguments.
 *
 * Supported flags:
 *   --root <dir>        Add an explicit root directory (repeatable). Used as a
 *                       fallback / supplement when the client does not advertise
 *                       the `roots` capability.
 *   --no-sampling       Never issue `sampling/createMessage`; kb_ask returns the
 *                       grounded context bundle for the host to reason over.
 *   --name <name>       Override the advertised server name (default 'kbexplorer').
 *   --help, -h          Show help.
 *
 * @param {string[]} args
 * @returns {{ roots: string[], noSampling: boolean, name: string|null, help: boolean, unknown: string[] }}
 */
export function parseMcpArgs(args = []) {
  const out = { roots: [], noSampling: false, name: null, help: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--root':
        if (args[i + 1] != null) out.roots.push(args[++i]);
        break;
      case '--no-sampling':
        out.noSampling = true;
        break;
      case '--name':
        out.name = args[++i] ?? null;
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
