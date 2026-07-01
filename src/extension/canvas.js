/**
 * Canvas declaration (PE3-F5 wiring; A1 server, #190).
 *
 * The affordance `tools` ship in the **same** `joinSession({ canvases, tools })`
 * call as this canvas: "if the plugin provides a canvas, the action tools come
 * with it." This module supplies the canvas declaration and — as of A1 — a real
 * `open()` backed by a per-instance loopback HTTP server
 * (see {@link module:src/extension/canvas-server}), replacing the old stub that
 * returned no `url`.
 *
 * `open(ctx)` starts (or rehydrates) one `127.0.0.1:0` server per canvas
 * `instanceId`, serves the available SPA build with the injected
 * `window.__KBX_CANVAS__` boot config, and returns `{ url, title }`.
 * `onClose(ctx)` tears that server down. The frozen HTTP boundary is documented
 * in `docs/canvas-loopback-contract.md`. The data / SSE / action endpoints are
 * later issues (A2–A5) and are stubbed `404` for now.
 *
 * Pure and SDK-free: this returns a plain `CanvasOptions`-shaped object; the
 * wiring module passes it to the SDK's `createCanvas` at runtime — see
 * {@link module:src/extension/index}.
 *
 * @module src/extension/canvas
 */

import { createCanvasRegistry } from './canvas-server.js';

/** Stable, provider-local id for the kbexplorer canvas. */
export const KBX_CANVAS_ID = 'kbexplorer';

/**
 * Pull a canvas `instanceId` out of the SDK's open/close context. The SDK
 * addresses each panel by a caller-chosen `instanceId`; we tolerate a couple of
 * shapes and fall back to the canvas id so a single default panel still works.
 *
 * @param {object} [ctx]
 * @returns {string}
 */
function instanceIdOf(ctx = {}) {
  return ctx.instanceId || ctx.instance?.id || ctx.id || KBX_CANVAS_ID;
}

/**
 * Build the canvas options object with a real, server-backed `open`/`onClose`.
 *
 * @param {object} [deps]
 * @param {object} [deps.registry]  A canvas-server registry (injected for tests).
 *        Defaults to a fresh {@link createCanvasRegistry}.
 * @returns {object} A `CanvasOptions`-shaped object for the SDK's `createCanvas`.
 */
export function buildCanvasOptions({ registry = createCanvasRegistry() } = {}) {
  return {
    id: KBX_CANVAS_ID,
    displayName: 'kbexplorer Knowledge Graph',
    description:
      'Interactive kbexplorer knowledge-graph canvas. Affordance tools (kbx_*) act on the graph it renders.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Optional node id to focus on open.' },
      },
      additionalProperties: false,
    },
    /**
     * Start (or rehydrate) the loopback server for this panel and return its
     * origin as the canvas `url`.
     * @param {object} [ctx]  SDK open context ({ instanceId, input }).
     */
    async open(ctx = {}) {
      const anchorNodeId = ctx.input?.nodeId ?? ctx.nodeId;
      return registry.open(instanceIdOf(ctx), { anchorNodeId });
    },
    /**
     * Tear down this panel's loopback server.
     * @param {object} [ctx]  SDK close context ({ instanceId }).
     */
    async onClose(ctx = {}) {
      await registry.close(instanceIdOf(ctx));
    },
  };
}
