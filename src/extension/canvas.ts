/**
 * Canvas declaration (PE3-F5 wiring; A1 server, #190; actions + emit bus, #194).
 *
 * The affordance `tools` ship in the **same** `joinSession({ canvases, tools })`
 * call as this canvas: "if the plugin provides a canvas, the action tools come
 * with it." This module supplies the canvas declaration, a real `open()`/`onClose()`
 * backed by a per-instance loopback HTTP server
 * (see {@link module:src/extension/canvas-server}), and — as of #194 — the
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
 * action core the extension-tool (#163) and MCP (#197) adapters use. `filter`'s
 * query mode instead calls `registry.search` (the same seam the loopback
 * `/search` endpoint uses, including its dependency-free text-index fallback)
 * rather than the raw `search` affordance, which hard-requires installed
 * search artifacts — this keeps `filter` usable in a stock checkout. Every
 * action then pushes the corresponding SSE event through `registry.emit` so
 * the panel that requested the action (or any other panel subscribed to the
 * same `instanceId`) updates live over the existing `/events` stream. Frozen
 * event names only: `anchor` and `graph-updated` (`docs/canvas-loopback-contract.md`).
 *
 * Mostly SDK-free: this returns a plain `CanvasOptions`-shaped object (action
 * handlers receive the SDK's `CanvasProviderInvokeActionRequest` shape but never
 * import the SDK); the wiring module passes it to the SDK's `createCanvas` at
 * runtime — see {@link module:src/extension/index}.
 *
 * @module src/extension/canvas
 */

import { createCanvasRegistry, SSE_EVENTS } from './canvas-server.ts';
import type { CanvasRegistry } from './canvas/registry.ts';
import {
  executeAffordance as defaultExecute,
  createAffordanceContext,
} from '../affordances/index.ts';

/** Stable, provider-local id for the kbexplorer canvas. */
export const KBX_CANVAS_ID = 'kbexplorer';

type ExecuteAffordance = (name: string, input: object, context?: object) => Promise<unknown>;
type ActionInput = Record<string, unknown>;

interface CanvasInvocationContext {
  instanceId?: string;
  instance?: { id?: string };
  id?: string;
  nodeId?: string;
  input?: ActionInput;
}

interface CanvasActionDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
  handler: (ctx?: CanvasInvocationContext) => Promise<unknown>;
}

interface CanvasOptions {
  id: string;
  displayName: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  actions: CanvasActionDefinition[];
  open: (ctx?: CanvasInvocationContext) => Promise<{ url: string; title: string }>;
  onClose: (ctx?: CanvasInvocationContext) => Promise<void>;
}

interface CanvasActionBuildOptions {
  execute?: ExecuteAffordance;
  contextFactory?: () => object;
}

interface BuildCanvasOptionsDeps extends CanvasActionBuildOptions {
  registry?: CanvasRegistry;
}

type QueryNodeResult = { title: string };
type GraphNeighborsResult = Record<string, unknown> & {
  neighbors: Array<{ id: string }>;
};
type TraceResult = Record<string, unknown> & {
  path: string[];
  connected: boolean;
};
type FilterResult = {
  results: Array<{ nodeId?: string; id?: string }>;
};

/**
 * Pull a canvas `instanceId` out of the SDK's open/close/action context. The
 * SDK addresses each panel by a caller-chosen `instanceId`; we tolerate a
 * couple of shapes and fall back to the canvas id so a single default panel
 * still works.
 *
 * @param {object} [ctx]
 * @returns {string}
 */
function instanceIdOf(ctx: CanvasInvocationContext = {}) {
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
function requireString(value: unknown, field: string, actionName: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${actionName}: "${field}" is required`);
  }
  return value;
}

/**
 * Build the `actions[]` the canvas declares for `invoke_canvas_action`:
 * `anchor`, `expand`, `trace`, `filter`. `anchor`/`expand`/`trace` delegate to
 * `executeAffordance`; `filter`'s query mode delegates to `registry.search`
 * (see {@link createCanvasRegistry}) instead, for parity with `/search`'s
 * artifact-optional fallback. On success, every action pushes the resulting
 * domain event through `registry.emit` so the subscribed `/events` SSE
 * stream(s) for that `instanceId` update live.
 *
 * @param {object} registry  A canvas-server registry (see {@link createCanvasRegistry}).
 *        Must expose `emit(instanceId, event, data)` and `search(params)`.
 * @param {object} [opts]
 * @param {(name: string, input: object, context?: object) => Promise<*>} [opts.execute]
 *        Registry executor seam (defaults to {@link executeAffordance}).
 * @param {() => object} [opts.contextFactory]
 *        Builds the affordance execution context per call (defaults to a fresh
 *        {@link createAffordanceContext} over `process.cwd()`).
 * @returns {CanvasActionDefinition[]}
 */
export function buildCanvasActions(registry: CanvasRegistry, opts: CanvasActionBuildOptions = {}) {
  const executeFn: ExecuteAffordance = opts.execute ?? (defaultExecute as ExecuteAffordance);
  const contextFactoryFn: () => object =
    opts.contextFactory ?? (() => createAffordanceContext() as object);
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
      async handler(ctx: CanvasInvocationContext = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const nodeId = requireString(input.nodeId, 'nodeId', 'anchor');
        const node = await executeFn('query_node', { id: nodeId }, contextFactoryFn()) as QueryNodeResult;
        const delivered = registry.emit(instanceId, SSE_EVENTS.ANCHOR, { nodeId });
        return { ok: true, nodeId, title: node.title, delivered };
      },
    },
    {
      name: 'expand',
      description:
        "Expand a node's neighbourhood on the canvas up to a given depth. Emits a `graph-updated` SSE event with the expanded node set.",
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node id to expand from.' },
          depth: { type: 'number', description: 'Traversal depth, 1-4 (default 1).' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      async handler(ctx: CanvasInvocationContext = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const nodeId = requireString(input.nodeId, 'nodeId', 'expand');
        const result = await executeFn(
          'graph_neighbors',
          { id: nodeId, depth: input.depth },
          contextFactoryFn()
        ) as GraphNeighborsResult;
        const nodes = [nodeId, ...result.neighbors.map((n) => n.id)];
        const delivered = registry.emit(instanceId, SSE_EVENTS.GRAPH_UPDATED, {
          nodes,
          reason: 'expand',
          focus: nodeId,
        });
        return { ...result, delivered };
      },
    },
    {
      name: 'trace',
      description:
        'Trace the shortest connection between two nodes (fromId/toId), or the immediate connections of one node (nodeId). Emits a `graph-updated` SSE event with the traced path.',
      inputSchema: {
        type: 'object',
        properties: {
          fromId: { type: 'string', description: 'Start node id.' },
          toId: { type: 'string', description: 'End node id; traces a path to it when given.' },
          nodeId: { type: 'string', description: 'Alias for fromId when toId is omitted.' },
        },
        additionalProperties: false,
      },
      async handler(ctx: CanvasInvocationContext = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const fromId = input.fromId || input.nodeId;
        requireString(fromId, 'fromId (or nodeId)', 'trace');
        const result = await executeFn('trace', { fromId, toId: input.toId }, contextFactoryFn()) as TraceResult;
        const delivered = registry.emit(instanceId, SSE_EVENTS.GRAPH_UPDATED, {
          nodes: result.path,
          reason: 'trace',
          path: result.path,
          connected: result.connected,
        });
        return { ...result, delivered };
      },
    },
    {
      name: 'filter',
      description:
        'Filter/highlight the visible node set by a semantic query and/or cluster/entity type. When `query` is given, searches (with a dependency-free text-index fallback when no search artifacts are installed) and emits a `graph-updated` SSE event with the matching node ids; `cluster`/`nodeType` alone are returned for the panel to apply client-side.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search query.' },
          cluster: { type: 'string', description: 'Restrict results to a cluster id.' },
          nodeType: {
            type: 'string',
            description: 'Restrict results to an entity type (passed through as `entityType`).',
          },
        },
        additionalProperties: false,
      },
      async handler(ctx: CanvasInvocationContext = {}) {
        const instanceId = instanceIdOf(ctx);
        const input = ctx.input ?? {};
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        const cluster = (input.cluster ?? null) as string | null;
        const nodeType = (input.nodeType ?? null) as string | null;

        let nodes = null;
        if (query) {
          // Uses `registry.search` (the same seam `/search` uses, including its
          // dependency-free text-index fallback) rather than the raw `search`
          // affordance, which hard-throws `UNSUPPORTED`/`MISSING_ARTIFACT` when
          // no search engine/artifacts are installed. This keeps `filter`
          // working in a stock checkout instead of only in repos with a
          // `.search/` index built.
          const result = await registry.search({
            query,
            cluster: cluster ?? undefined,
            entityType: nodeType ?? undefined,
          }) as FilterResult;
          nodes = result.results.map((r) => r.nodeId ?? r.id);
        }

        const delivered = registry.emit(instanceId, SSE_EVENTS.GRAPH_UPDATED, {
          reason: 'filter',
          filter: { query: query || null, cluster, nodeType },
          nodes,
        });
        return { query: query || null, cluster, nodeType, nodes, delivered };
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
}: BuildCanvasOptionsDeps = {}): CanvasOptions {
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
    async open(ctx: CanvasInvocationContext = {}) {
      const anchorNodeId = (ctx.input?.nodeId ?? ctx.nodeId) as string | undefined;
      return registry.open(instanceIdOf(ctx), { anchorNodeId });
    },
    /**
     * Tear down this panel's loopback server.
     * @param {object} [ctx]  SDK close context ({ instanceId }).
     */
    async onClose(ctx: CanvasInvocationContext = {}) {
      await registry.close(instanceIdOf(ctx));
    },
  };
}
