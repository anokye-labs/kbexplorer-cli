/**
 * Canvas declaration (PE3-F5 wiring; A1 server, #190; actions + emit bus, #212).
 *
 * The affordance `tools` ship in the **same** `joinSession({ canvases, tools })`
 * call as this canvas: "if the plugin provides a canvas, the action tools come
 * with it." This module supplies the canvas declaration, a real `open()`/`onClose()`
 * backed by a per-instance loopback HTTP server
 * (see {@link module:src/extension/canvas-server}), and — as of #212 — the
 * agent-invocable `actions[]` (`anchor`/`expand`/`trace`/`filter`) that close the
 * loop the loopback contract left open: the iframe renders the graph over HTTP,
 * and these actions are how the **agent** (via `invoke_canvas_action`) drives it.
 *
 * `open(ctx)` starts (or rehydrates) one `127.0.0.1:0` server per canvas
 * `instanceId`, serves the available SPA build with the injected
 * `window.__KBX_CANVAS__` boot config, and returns `{ url, title }`.
 * `onClose(ctx)` tears that server down. The frozen HTTP boundary is documented
 * in `docs/canvas-loopback-contract.md`.
 *
 * `anchor`/`expand`/`trace` delegate to {@link module:src/affordances}'
 * `executeAffordance` — so consent + provenance are inherited from the same
 * action core the extension-tool (#163) and MCP (#197) adapters use, and node
 * existence is validated before anything is emitted. `filter` is a pure VIEW
 * instruction — cluster/layer highlighting the panel applies client-side — and
 * emits directly with no affordance call.
 *
 * SSE wire contract (frozen, `docs/canvas-loopback-contract.md`, v2 per #212):
 * `anchor` still emits **exactly** `anchor { nodeId }`, unchanged since A4.
 * `expand`/`trace`/`filter` emit the single additive `view-action` envelope —
 * `{ action, params, requestId? }` — rather than three new event types or an
 * overloaded `anchor`/`graph-updated`. `graph-updated` itself is unchanged and
 * not emitted by any action here (reserved for future content/data mutations).
 * Every action pushes its event through `registry.emit` so the panel that
 * requested it (or any other panel subscribed to the same `instanceId`)
 * updates live over the existing `/events` stream.
 *
 * Mostly SDK-free: this returns a plain `CanvasOptions`-shaped object (action
 * handlers receive the SDK's `CanvasProviderInvokeActionRequest` shape but never
 * import the SDK); the wiring module passes it to the SDK's `createCanvas` at
 * runtime — see {@link module:src/extension/index}.
 *
 * @module src/extension/canvas
 */

import { createCanvasRegistry, SSE_EVENTS } from './canvas-server.js';
import {
  executeAffordance as defaultExecute,
  createAffordanceContext,
} from '../affordances/index.js';

/** Stable, provider-local id for the kbexplorer canvas. */
export const KBX_CANVAS_ID = 'kbexplorer';

/**
 * Pull a canvas `instanceId` out of the SDK's open/close/action context. The
 * SDK addresses each panel by a caller-chosen `instanceId`; we tolerate a
 * couple of shapes and fall back to the canvas id so a single default panel
 * still works.
 *
 * @param {object} [ctx]
 * @returns {string}
 */
function instanceIdOf(ctx = {}) {
  return ctx.instanceId || ctx.instance?.id || ctx.id || KBX_CANVAS_ID;
}

/**
 * Require a non-empty string field on an action's input, throwing a clear
 * `TypeError` (surfaced to the agent as the action's failure) otherwise.
 *
 * @param {*} value
 * @param {string} field
 * @param {string} actionName
 * @returns {string}
 */
function requireString(value, field, actionName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${actionName}: "${field}" is required`);
  }
  return value;
}

/**
 * Require at least one of two optional string fields to be a non-empty
 * string, throwing a clear `TypeError` when both are omitted/blank.
 *
 * @param {object} fields  Map of `{ [field]: value }` to check.
 * @param {string} actionName
 * @returns {void}
 */
function requireAtLeastOneOf(fields, actionName) {
  const hasAny = Object.values(fields).some((v) => typeof v === 'string' && v.trim() !== '');
  if (!hasAny) {
    const names = Object.keys(fields).join('`/`');
    throw new TypeError(`${actionName}: at least one of \`${names}\` is required`);
  }
}

/**
 * Emit the single, additive `view-action` SSE envelope (#212,
 * `docs/canvas-loopback-contract.md` v2): `{ action, params, requestId? }`.
 * Shared by `expand`/`trace`/`filter` so the envelope shape can't drift
 * between actions. `anchor` is exempt — it stays on its own frozen,
 * unchanged `anchor { nodeId }` event.
 *
 * @param {object} registry
 * @param {string} instanceId
 * @param {'expand'|'trace'|'filter'} action
 * @param {object} params
 * @param {string} [requestId]  Best-effort correlation id pass-through. The
 *        current Copilot canvas SDK action-invoke context does not guarantee
 *        a `requestId` field exists — this is forward-compatible plumbing,
 *        not a documented SDK contract. Omitted entirely (not `null`/`undefined`
 *        keyed) when absent.
 * @returns {boolean} Whether a subscriber received the frame (registry.emit's return).
 */
function emitViewAction(registry, instanceId, action, params, requestId) {
  const data = { action, params };
  if (requestId) data.requestId = requestId;
  return registry.emit(instanceId, SSE_EVENTS.VIEW_ACTION, data);
}

/**
 * Build the `actions[]` the canvas declares for `invoke_canvas_action`:
 * `anchor`, `expand`, `trace`, `filter`. `anchor`/`expand`/`trace` delegate to
 * `executeAffordance` — so consent, provenance, and node-existence validation
 * are inherited from the same action core the extension-tool (#163) and MCP
 * (#197) adapters use. `filter` is a pure VIEW instruction (cluster/layer
 * highlighting the panel applies client-side) and never calls an affordance
 * or `registry.search`. On success, every action pushes its event through
 * `registry.emit` so the subscribed `/events` SSE stream(s) for that
 * `instanceId` update live: `anchor` emits the frozen `anchor { nodeId }`
 * event unchanged; `expand`/`trace`/`filter` emit the single additive
 * `view-action { action, params, requestId? }` envelope (#212).
 *
 * @param {object} registry  A canvas-server registry (see {@link createCanvasRegistry}).
 *        Must expose `emit(instanceId, event, data)`.
 * @param {object} [opts]
 * @param {(name: string, input: object, context?: object) => Promise<*>} [opts.execute]
 *        Registry executor seam (defaults to {@link executeAffordance}).
 * @param {() => object} [opts.contextFactory]
 *        Builds the affordance execution context per call (defaults to a fresh
 *        {@link createAffordanceContext} over `process.cwd()`).
 * @returns {import('@github/copilot-sdk/extension').CanvasAction[]}
 */
export function buildCanvasActions(registry, opts = {}) {
  const { execute = defaultExecute, contextFactory = createAffordanceContext } = opts;
  return [
    {
      name: 'anchor',
      description:
        'Focus the canvas on a specific node. Validates the node exists, then emits an `anchor` SSE event so the panel re-centers on it.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node id to focus the canvas on.' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      async handler(ctx = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const nodeId = requireString(input.nodeId, 'nodeId', 'anchor');
        const node = await execute('query_node', { id: nodeId }, contextFactory());
        const delivered = registry.emit(instanceId, SSE_EVENTS.ANCHOR, { nodeId });
        return { ok: true, nodeId, title: node.title, delivered };
      },
    },
    {
      name: 'expand',
      description:
        "Expand a node's neighbourhood on the canvas up to a given depth. Validates the node via the `graph_neighbors` affordance, then emits a `view-action` SSE event (`{ action: 'expand', params: { nodeId, depth? } }`) for the panel to react to.",
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node id to expand from.' },
          depth: { type: 'number', description: 'Traversal depth, 1-4 (default 1).' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      async handler(ctx = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const nodeId = requireString(input.nodeId, 'nodeId', 'expand');
        const result = await execute(
          'graph_neighbors',
          { id: nodeId, depth: input.depth },
          contextFactory()
        );
        const params =
          typeof input.depth === 'number' ? { nodeId, depth: input.depth } : { nodeId };
        const delivered = emitViewAction(registry, instanceId, 'expand', params, ctx.requestId);
        return { ...result, delivered };
      },
    },
    {
      name: 'trace',
      description:
        "Trace the shortest connection between two nodes (fromId/toId), or the immediate connections of one node (nodeId). Computes the path via the `trace` affordance, then emits a `view-action` SSE event (`{ action: 'trace', params: { path } }`) with just the traced path.",
      inputSchema: {
        type: 'object',
        properties: {
          fromId: { type: 'string', description: 'Start node id.' },
          toId: { type: 'string', description: 'End node id; traces a path to it when given.' },
          nodeId: { type: 'string', description: 'Alias for fromId when toId is omitted.' },
        },
        additionalProperties: false,
      },
      async handler(ctx = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const fromId = input.fromId || input.nodeId;
        requireString(fromId, 'fromId (or nodeId)', 'trace');
        const result = await execute('trace', { fromId, toId: input.toId }, contextFactory());
        const delivered = emitViewAction(
          registry,
          instanceId,
          'trace',
          { path: result.path },
          ctx.requestId
        );
        return { ...result, delivered };
      },
    },
    {
      name: 'filter',
      description:
        "Filter/highlight the visible node set by cluster and/or layer — a pure VIEW instruction; no data lookup is performed here, the panel applies the highlight client-side. At least one of `cluster`/`layer` is required. Emits a `view-action` SSE event (`{ action: 'filter', params: { cluster?, layer? } }`).",
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Restrict the view to a cluster id.' },
          layer: { type: 'string', description: 'Restrict the view to a layer id.' },
        },
        additionalProperties: false,
      },
      async handler(ctx = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const cluster = typeof input.cluster === 'string' ? input.cluster.trim() : '';
        const layer = typeof input.layer === 'string' ? input.layer.trim() : '';
        requireAtLeastOneOf({ cluster: input.cluster, layer: input.layer }, 'filter');

        const params = {};
        if (cluster) params.cluster = cluster;
        if (layer) params.layer = layer;

        const delivered = emitViewAction(registry, instanceId, 'filter', params, ctx.requestId);
        return { ...params, delivered };
      },
    },
  ];
}

/**
 * Build the canvas options object with a real, server-backed `open`/`onClose`
 * and the agent-invocable `actions[]`.
 *
 * @param {object} [deps]
 * @param {object} [deps.registry]  A canvas-server registry (injected for tests).
 *        Defaults to a fresh {@link createCanvasRegistry}.
 * @param {(name: string, input: object, context?: object) => Promise<*>} [deps.execute]
 *        Affordance executor seam for the actions (defaults to {@link executeAffordance}).
 * @param {() => object} [deps.contextFactory]
 *        Affordance context factory seam for the actions (defaults to
 *        {@link createAffordanceContext}).
 * @returns {object} A `CanvasOptions`-shaped object for the SDK's `createCanvas`.
 */
export function buildCanvasOptions({
  registry = createCanvasRegistry(),
  execute,
  contextFactory,
} = {}) {
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
    actions: buildCanvasActions(registry, { execute, contextFactory }),
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
