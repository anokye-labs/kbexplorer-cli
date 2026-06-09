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
