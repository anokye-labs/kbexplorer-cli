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
 *   --help, -h                 Show help.
 *
 * @param {string[]} args
 * @returns {{
 *   prompt: string|null, model: string|null, allowTools: string[],
 *   allowAllTools: boolean|null, timeout: number|null, noAgent: boolean,
 *   refresh: boolean, dryRun: boolean, help: boolean, unknown: string[]
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
