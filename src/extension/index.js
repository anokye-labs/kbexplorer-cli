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
import { createCanvasRegistry } from './canvas-server.js';

export { TOOL_PREFIX, toolNameFor, affordanceToTool, buildAffordanceTools } from './tools.js';
export { KBX_CANVAS_ID, buildCanvasOptions } from './canvas.js';
export {
  createCanvasRegistry,
  createRequestHandler,
  injectBootConfig,
  defaultResolveBuildDir,
  createEventBus,
  defaultSubscribe,
  SSE_EVENTS,
  CANVAS_ENTRY_FILE,
  CANVAS_ENTRY_CANDIDATES,
} from './canvas-server.js';
export { descriptorToJsonSchema, fieldToJsonSchema } from './json-schema.js';
export { successResult, errorResult } from './tool-result.js';

/**
 * Build a `sendChatMessage` seam for the canvas registry's `/chat-intent`
 * endpoint (A6, #195): a closure that reads a `session` reference lazily, so
 * it can be constructed *before* `joinSession()` resolves and still reach the
 * real session once {@link bindSession} is called on it after `joinSession()`
 * settles. Throws (fails closed) if invoked before a session is bound, rather
 * than silently no-op-succeeding.
 *
 * @returns {{ sendChatMessage: (prompt: string) => Promise<string>, bindSession: (session: object) => void }}
 */
function createSessionSendSeam() {
  let session;
  return {
    sendChatMessage: (prompt) => {
      if (!session || typeof session.send !== 'function') {
        throw new Error(
          'createKbxExtensionConfig: SDK session not yet available for /chat-intent (join in progress or joinSession failed)'
        );
      }
      return session.send(prompt);
    },
    bindSession: (s) => {
      session = s;
    },
  };
}

/**
 * Assemble the affordance `tools` and the canvas options for `joinSession`.
 * Pure (no SDK): returns the tools array and the raw canvas options so a caller
 * can decide how to construct the SDK `Canvas`.
 *
 * Builds its own {@link createCanvasRegistry} (unless one is supplied via
 * `opts.registry`) so `buildCanvasOptions` and the registry's `/chat-intent`
 * seam share the same instance. Callers that don't pass `registry` get a
 * registry with no `sendChatMessage` wired — `/chat-intent` fails closed
 * (503) rather than pretending to post a message, which is exactly what a
 * standalone `createKbxExtensionConfig()` (e.g. in tests) should do.
 *
 * @param {object} [opts]  Forwarded to {@link buildAffordanceTools}
 *        (`describe` / `execute` / `contextFactory` seams).
 * @param {object} [opts.registry]  A pre-built canvas registry (e.g. from
 *        {@link registerKbxExtension}'s session-aware wiring) to reuse instead
 *        of creating a fresh one.
 * @returns {{ tools: object[], canvasOptions: object }}
 */
export function createKbxExtensionConfig(opts = {}) {
  const { registry = createCanvasRegistry(), ...toolOpts } = opts;
  return {
    tools: buildAffordanceTools(toolOpts),
    canvasOptions: buildCanvasOptions({ registry }),
  };
}

/**
 * Register the kbexplorer extension on the current session: build the affordance
 * tools + canvas and hand them to `joinSession` in one call.
 *
 * Also wires the canvas registry's `/chat-intent` seam (A6, #195) to the real
 * joined session's `Session.send`, once `joinSession()` resolves — so a
 * click-intent posted from the iframe becomes a genuine new agent chat turn
 * in the SAME session the canvas is embedded in.
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

  const { sendChatMessage, bindSession } = createSessionSendSeam();
  const registry = createCanvasRegistry({ sendChatMessage });
  const { tools, canvasOptions } = createKbxExtensionConfig({ ...toolOptions, registry });
  const canvas = createCanvas(canvasOptions);

  const session = await joinSession({
    ...joinConfig,
    tools: [...(joinConfig.tools ?? []), ...tools],
    canvases: [...(joinConfig.canvases ?? []), canvas],
  });
  bindSession(session);
  return session;
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
