/**
 * Extension-tool adapter wiring (PE3-F5) — the `joinSession` boundary.
 *
 * This module assembles the affordance `tools` (see {@link module:src/extension/tools})
 * and the placeholder canvas (see {@link module:src/extension/canvas}) and binds
 * them into a single Copilot CLI `joinSession({ canvases, tools })` call — the
 * one process in which "agent clicks node → calls affordance → mutates graph →
 * canvas updates" happens with **no MCP round-trip**.
 *
 * The Copilot extension SDK is the only wire protocol involved, and it is touched
 * exactly here, behind injectable `joinSession` / `createCanvas` seams, so the
 * rest of the adapter (and its tests) need no SDK and `npm ci` stays unchanged.
 * {@link registerKbxExtension} is dependency-injected and unit-testable;
 * {@link main} resolves the real SDK via dynamic import for the runnable entry.
 *
 * @module src/extension/index
 */

import { buildAffordanceTools } from './tools.js';
import { buildCanvasOptions } from './canvas.js';

export { TOOL_PREFIX, toolNameFor, affordanceToTool, buildAffordanceTools } from './tools.js';
export { KBX_CANVAS_ID, buildCanvasOptions } from './canvas.js';
export {
  createCanvasRegistry,
  createRequestHandler,
  injectBootConfig,
  defaultResolveBuildDir,
  CANVAS_ENTRY_FILE,
  CANVAS_ENTRY_CANDIDATES,
} from './canvas-server.js';
export { descriptorToJsonSchema, fieldToJsonSchema } from './json-schema.js';
export { successResult, errorResult } from './tool-result.js';

/**
 * Assemble the affordance `tools` and the canvas options for `joinSession`.
 * Pure (no SDK): returns the tools array and the raw canvas options so a caller
 * can decide how to construct the SDK `Canvas`.
 *
 * @param {object} [opts]  Forwarded to {@link buildAffordanceTools}
 *        (`describe` / `execute` / `contextFactory` seams).
 * @returns {{ tools: object[], canvasOptions: object }}
 */
export function createKbxExtensionConfig(opts = {}) {
  return {
    tools: buildAffordanceTools(opts),
    canvasOptions: buildCanvasOptions(),
  };
}

/**
 * Register the kbexplorer extension on the current session: build the affordance
 * tools + canvas and hand them to `joinSession` in one call.
 *
 * @param {object} deps
 * @param {(config: object) => Promise<*>|*} deps.joinSession
 *        The SDK's `joinSession` (injected for testability).
 * @param {(options: object) => *} deps.createCanvas
 *        The SDK's `createCanvas` (injected for testability).
 * @param {object} [deps.toolOptions]  Forwarded to {@link buildAffordanceTools}.
 * @param {object} [deps.joinConfig]   Extra `joinSession` config (e.g. hooks) to merge.
 * @returns {Promise<*>} Whatever `joinSession` resolves to (the joined session).
 */
export async function registerKbxExtension({
  joinSession,
  createCanvas,
  toolOptions = {},
  joinConfig = {},
}) {
  if (typeof joinSession !== 'function') {
    throw new TypeError('registerKbxExtension: "joinSession" must be a function');
  }
  if (typeof createCanvas !== 'function') {
    throw new TypeError('registerKbxExtension: "createCanvas" must be a function');
  }

  const { tools, canvasOptions } = createKbxExtensionConfig(toolOptions);
  const canvas = createCanvas(canvasOptions);

  return joinSession({
    ...joinConfig,
    tools: [...(joinConfig.tools ?? []), ...tools],
    canvases: [...(joinConfig.canvases ?? []), canvas],
  });
}

/**
 * Runnable entry: resolve the real Copilot extension SDK and register.
 *
 * The SDK is only available inside a live extension host, so it is loaded lazily
 * via dynamic import — keeping it out of the static module graph (and out of
 * `npm ci` / the test runner).
 *
 * @param {object} [opts]  Forwarded to {@link registerKbxExtension} as `toolOptions`.
 * @returns {Promise<*>}
 */
export async function main(opts = {}) {
  const { joinSession, createCanvas } = await import('@github/copilot-sdk/extension');
  return registerKbxExtension({ joinSession, createCanvas, toolOptions: opts });
}
