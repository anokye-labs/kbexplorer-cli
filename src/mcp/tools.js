/**
 * MCP-tool binding (PE3-F4) — affordances → Model Context Protocol `tools`.
 *
 * This is the **optional, non-canvas** delivery adapter for the affordance action
 * contract (PE3-F1). It is the exact structural twin of the extension-tool
 * adapter ({@link module:src/extension/tools}); the *only* difference is the wire
 * shape it targets. Where the extension adapter emits Copilot CLI `Tool`s for
 * `joinSession`, this adapter emits MCP tool descriptors for an MCP `Server`'s
 * `tools/list` + `tools/call` handlers ({@link module:src/mcp/server}).
 *
 * Because both adapters bind to the *same* registry, they expose the *same*
 * affordances with identical names, schemas, and — crucially — identical consent
 * enforcement, since the gate lives at the action core inside
 * {@link executeAffordance}, not in any adapter. Adding a new affordance (or job)
 * to the registry surfaces it over MCP automatically, with no change here.
 *
 * Each generated tool:
 *   - is named `kbx_<affordance>` (same prefix the extension adapter uses, so a
 *     host that loads both sees one consistent tool vocabulary);
 *   - exposes the affordance's transport-neutral input descriptor as JSON Schema
 *     via the shared bridge ({@link module:src/extension/json-schema}) — no
 *     schema logic is duplicated for MCP;
 *   - surfaces the affordance's `actionClass` (read / write / sample) as
 *     **advisory** metadata in the description (enforcement is PE3-F3, at the core);
 *   - routes its handler straight to {@link executeAffordance}, mapping the typed
 *     result or {@link AffordanceError} back through
 *     {@link module:src/mcp/tool-result}.
 *
 * The `describe` / `execute` / `contextFactory` seams are injectable so the
 * binding is hermetically testable without standing up a real MCP server or the
 * SDK. Nothing here imports the MCP SDK or any transport.
 *
 * @module src/mcp/tools
 */

import {
  describeAffordances,
  executeAffordance,
  createAffordanceContext,
  ACTION_CLASSES,
} from '../affordances/index.js';
import { descriptorToJsonSchema } from '../extension/json-schema.js';
import { successResult, errorResult } from './tool-result.js';

/**
 * Prefix that namespaces affordance tools within an MCP host's tool table.
 * Deliberately identical to the extension adapter's prefix so the two adapters
 * present one coherent `kbx_*` vocabulary regardless of delivery path.
 */
export const TOOL_PREFIX = 'kbx_';

/**
 * Map an affordance name to its MCP tool name.
 *
 * @param {string} affordanceName
 * @returns {string}
 */
export function toolNameFor(affordanceName) {
  return `${TOOL_PREFIX}${affordanceName}`;
}

/** Human-readable, advisory consent hint per action class. */
const ACTION_CLASS_HINT = Object.freeze({
  [ACTION_CLASSES.READ]: 'read-only: observes the graph/repo, no side effects',
  [ACTION_CLASSES.WRITE]: 'write: produces or mutates committed artifacts on disk',
  [ACTION_CLASSES.SAMPLE]: 'sample: assembles context to feed a model (no model call here)',
});

/**
 * Build one MCP tool descriptor from a described affordance.
 *
 * @param {ReturnType<typeof describeAffordances>[number]} described
 *        A serialisable affordance contract (name, title, summary, actionClass,
 *        input, output) — i.e. an entry from {@link describeAffordances}.
 * @param {object} [opts]
 * @param {(name: string, input: object, context?: object) => Promise<*>|*} [opts.execute]
 *        Registry executor seam (defaults to {@link executeAffordance}).
 * @param {() => object} [opts.contextFactory]
 *        Builds the affordance execution context per call (defaults to a fresh
 *        {@link createAffordanceContext} over `process.cwd()`). The MCP wiring
 *        passes a factory that threads MCP elicitation-based consent seams in.
 * @returns {{ name: string, description: string, inputSchema: object, actionClass: string, handler: (args: object) => Promise<object> }}
 */
export function affordanceToMcpTool(described, opts = {}) {
  const { execute = executeAffordance, contextFactory = createAffordanceContext } = opts;
  const { name, title, summary, actionClass } = described;

  const hint = ACTION_CLASS_HINT[actionClass] ?? actionClass;
  const description = `[${actionClass}] ${title} — ${summary} (${hint})`;

  return {
    name: toolNameFor(name),
    description,
    inputSchema: descriptorToJsonSchema(described.input),
    // Advisory consent metadata — exposed, not enforced here (PE3-F3 enforces
    // inside executeAffordance for every adapter). No separate `affordance`
    // field: the extension-tool adapter's Tool has none either (AF-027), and
    // `toolNameFor`/`name` already round-trips to the affordance name via the
    // `kbx_` prefix, so a duplicate field would just be dead weight.
    actionClass,
    async handler(args) {
      try {
        const result = await execute(name, args ?? {}, contextFactory());
        return successResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/**
 * Build the full set of affordance tools for the MCP server's tool surface.
 *
 * @param {object} [opts]
 * @param {() => Array<ReturnType<typeof describeAffordances>[number]>} [opts.describe]
 *        Contract-catalogue seam (defaults to {@link describeAffordances}).
 * @param {(name: string, input: object, context?: object) => Promise<*>|*} [opts.execute]
 * @param {() => object} [opts.contextFactory]
 * @returns {ReturnType<typeof affordanceToMcpTool>[]} One MCP tool per registered
 *          affordance, in canonical order.
 */
export function buildMcpTools(opts = {}) {
  const { describe = describeAffordances, ...toolOpts } = opts;
  return describe().map((d) => affordanceToMcpTool(d, toolOpts));
}
