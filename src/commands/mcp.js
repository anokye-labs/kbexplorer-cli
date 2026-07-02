/**
 * kbx mcp — expose the affordances as a Model Context Protocol server.
 *
 * The **optional, non-canvas** delivery adapter (PE3-F4). Where the canvas ships
 * with the extension-tool adapter (which registers the affordances as in-process
 * `tools` alongside the canvas — no MCP anywhere), this command exposes the *same*
 * affordance registry as a standalone **stdio MCP server** for hosts that don't
 * load the extension: plain `copilot -p`, Claude Desktop, or any other MCP client.
 *
 * It is a thin transport binding — every tool call routes through the shared
 * `executeAffordance`, so validation, the job layer, and consent (PE3-F3) are
 * inherited unchanged. The server is meant to be *launched by a host* over stdio,
 * not run interactively; see `examples/copilot-mcp-config.json`.
 *
 * Consent over MCP is requested via elicitation when the client supports it, and
 * fails closed otherwise; `--allow` (or `KBX_MCP_CONSENT=allow`) opts into
 * non-interactive consent for automation. BYO-cred: the server inherits the
 * ambient environment (gh, provider keys) exactly as the rest of the CLI does.
 *
 * @module src/commands/mcp
 */

import { main as runServer, SERVER_NAME } from '../mcp/index.js';
import { runMcpServerPreflight, formatMcpServerPreflight } from '../mcp/preflight.js';

const HELP = `
  kbx mcp — knowledge-graph affordances as an MCP server (optional, non-canvas hosts)

  Runs a stdio Model Context Protocol server that exposes the kbexplorer
  affordance actions (search, query_node, graph_neighbors, trace, affected, audit,
  llm_context, derive, and the job layer) as MCP tools named kbx_<affordance>.
  Intended to be launched by an MCP host, not run interactively.

  Usage: kbx mcp [options]

  Options:
    --allow            Non-interactive consent: auto-approve write/sample actions
                       (equivalent to KBX_MCP_CONSENT=allow). Use only in trusted
                       automation. Without it, write/sample actions request
                       consent via MCP elicitation and fail closed when the client
                       cannot elicit.
    --name <name>      Override the advertised server name (default '${SERVER_NAME}').
    --skip-preflight   Skip the provider readiness check (development only).
    --help, -h         Show this help.

  Example (host config — see examples/copilot-mcp-config.json):
    { "mcpServers": { "kbexplorer": { "command": "npx", "args": ["-y", "@anokye-labs/kbx", "mcp"] } } }
`;

/**
 * Parse `kbx mcp` argv into options. Exported for tests.
 *
 * @param {string[]} [args]
 * @returns {{ help: boolean, allow: boolean, skipPreflight: boolean, name: string|undefined, unknown: string[] }}
 */
export function parseMcpArgs(args = []) {
  const opts = { help: false, allow: false, skipPreflight: false, name: undefined, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--allow':
        opts.allow = true;
        break;
      case '--skip-preflight':
        opts.skipPreflight = true;
        break;
      case '--name':
        opts.name = args[++i];
        break;
      default:
        if (typeof arg === 'string' && arg.startsWith('--name=')) {
          opts.name = arg.slice('--name='.length);
        } else {
          opts.unknown.push(arg);
        }
    }
  }
  return opts;
}

/**
 * `kbx mcp` entry.
 *
 * @param {string[]} [argv]  Raw command args (after the command name).
 * @param {object} [deps]    Injectable seams for tests.
 * @param {(opts: object) => Promise<void>} [deps.run]  Server runner (defaults to the real stdio server).
 * @param {(opts?: object) => object} [deps.preflight]  Preflight runner.
 * @param {NodeJS.ProcessEnv} [deps.env=process.env]
 * @param {{ log?: Function, error?: Function }} [deps.io]
 * @param {NodeJS.Process} [deps.proc=process]
 * @returns {Promise<void>}
 */
export default async function mcp(argv = [], deps = {}) {
  const {
    run = runServer,
    preflight = runMcpServerPreflight,
    env = process.env,
    io = {},
    proc = process,
  } = deps;
  const log = io.log ?? console.log;
  const errOut = io.error ?? ((line) => proc.stderr.write(`${line}\n`));

  const opts = parseMcpArgs(argv);

  if (opts.help) {
    log(HELP);
    return;
  }
  if (opts.unknown.length) {
    errOut(`kbx mcp: ignoring unknown args: ${opts.unknown.join(' ')}`);
  }

  if (!opts.skipPreflight) {
    const result = preflight({});
    if (!result.ok) {
      for (const line of formatMcpServerPreflight(result)) errOut(line);
      proc.exitCode = 1;
      return;
    }
  }

  const allow = opts.allow || env.KBX_MCP_CONSENT === 'allow';
  await run({ cwd: proc.cwd(), allow, name: opts.name ?? SERVER_NAME });
}
