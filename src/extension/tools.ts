/**
 * Extension-tool binding (PE3-F5) — affordances → Copilot CLI `tools`.
 *
 * This is the **primary, Wave-1 delivery adapter** for the affordance action
 * contract (PE3-F1). It turns each affordance in the registry into a Copilot CLI
 * extension `Tool` so that the same extension which ships the kbexplorer canvas
 * also registers the graph actions as built-in tools — in-process, sharing the
 * session and the graph the canvas renders. **No MCP, no transport, no
 * JSON-RPC of our own** lives here; the only wire protocol is whatever the
 * Copilot extension SDK speaks for `joinSession`, and that is confined to the
 * wiring module ({@link module:src/extension/index}).
 *
 * Each generated tool:
 *   - is named `kbx_<affordance>` (globally-unique within the host);
 *   - exposes the affordance's transport-neutral input descriptor as JSON Schema
 *     `parameters` (see {@link module:src/extension/json-schema});
 *   - surfaces the affordance's `actionClass` (read / write / sample) as
 *     **advisory** metadata — both inline in the description and as a structured
 *     field on the tool object. The consent layer (PE3-F3 / #155) enforces it
 *     later; this adapter only exposes it;
 *   - routes its handler straight to {@link executeAffordance}, mapping the typed
 *     result or {@link AffordanceError} back through
 *     {@link module:src/extension/tool-result}.
 *
 * The `execute` and `contextFactory` seams are injectable so the binding is
 * hermetically testable without standing up a real session.
 *
 * @module src/extension/tools
 */

import { describeAffordances } from '../affordances/index.ts';
import { buildToolDefinition } from '../affordances/tool-bridge.ts';
import { successResult, errorResult } from './tool-result.ts';

/** Prefix that namespaces affordance tools within the host's global tool table. */
export const TOOL_PREFIX = 'kbx_';

/**
 * Map an affordance name to its host-unique tool name.
 *
 * @param {string} affordanceName
 * @returns {string}
 */
export function toolNameFor(affordanceName) {
  return `${TOOL_PREFIX}${affordanceName}`;
}

/**
* Build one Copilot CLI `Tool` from a described affordance.
*
* @param {ReturnType<typeof describeAffordances>[number]} described
*        A serialisable affordance contract (name, title, summary, actionClass,
*        input, output) — i.e. an entry from {@link describeAffordances}.
* @param {object} [opts]
* @param {(name: string, input: object, context?: object) => Promise<*>|*} [opts.execute]
*        Registry executor seam (defaults to {@link executeAffordance}).
* @param {() => object} [opts.contextFactory]
*        Builds the affordance execution context per call (defaults to a fresh
*        {@link createAffordanceContext} over `process.cwd()`).
* @returns {object} A `Tool` definition (`{ name, description, parameters, handler, actionClass }`).
*/
export function affordanceToTool(described, opts = {}) {
 const { execute, contextFactory } = opts;
 const tool = buildToolDefinition(described, {
   prefix: TOOL_PREFIX,
   execute,
   contextFactory,
   wrapSuccess: successResult,
   wrapError: errorResult,
 });
 const { inputSchema, ...rest } = tool;

 return {
   ...rest,
   // The extension tool surface wants `parameters` for host-transport schema.
   parameters: inputSchema,
 };
}

/**
 * Build the full set of affordance tools for the extension `tools` surface.
 *
 * @param {object} [opts]
 * @param {() => Array<ReturnType<typeof describeAffordances>[number]>} [opts.describe]
 *        Contract-catalogue seam (defaults to {@link describeAffordances}).
 * @param {(name: string, input: object, context?: object) => Promise<*>|*} [opts.execute]
 * @param {() => object} [opts.contextFactory]
 * @returns {object[]} One `Tool` per registered affordance, in canonical order.
 */
export function buildAffordanceTools(opts = {}) {
  const { describe = describeAffordances, ...toolOpts } = opts;
  return describe().map((d) => affordanceToTool(d, toolOpts));
}
