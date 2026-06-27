/**
 * kbexplorer mcp — knowledge-graph MCP server (sampling + roots).
 *
 * Runs a stdio Model Context Protocol *server* that exposes the kbexplorer
 * knowledge graph to an MCP host. Two host capabilities make it powerful
 * without ever embedding model credentials in kbexplorer:
 *
 *   - **roots** — the host tells the server which workspace folders it may read.
 *     Everything the server loads and shares is confined to those roots
 *     (supplemented by any `--root` flags). No roots advertised → fall back to
 *     the current working directory.
 *   - **sampling** — `kb_ask` assembles a grounded context bundle from the
 *     caller-supplied node ids, then asks the host's own model (via
 *     `sampling/createMessage`) to answer. No sampling advertised (or
 *     `--no-sampling`) → `kb_ask` returns the grounded context bundle +
 *     citations for the host to reason over itself.
 *
 * Tools: kb_ask, kb_get_node, kb_neighbors, kb_graph_stats.
 *
 * The protocol layer is the official Model Context Protocol SDK
 * (`@modelcontextprotocol/sdk`): a high-level `McpServer` over a
 * `StdioServerTransport`. Tool input is validated with zod.
 *
 * See docs/mcp-server.md (issue #5) for the full design.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseMcpArgs } from '../lib/args.js';
import {
  loadGraph,
  neighbors,
  graphStats,
  snippet,
} from '../lib/graph.js';

const SERVER_VERSION = '0.1.0';

const GROUNDING_SYSTEM_PROMPT = [
  'You are kbexplorer, answering questions strictly from a repository knowledge',
  'graph. Use ONLY the provided context nodes. Cite the node ids you relied on',
  'in square brackets, e.g. [node-id]. If the context is insufficient, say so',
  'plainly rather than guessing. Be concise and concrete.',
].join(' ');

const HELP = `
  kbexplorer mcp — knowledge-graph MCP server (sampling + roots)

  Runs a stdio MCP server exposing the KB graph. Intended to be launched by an
  MCP host (Copilot, Claude Desktop, etc.), not run interactively.

  Usage: kbexplorer mcp [options]

  Options:
    --root <dir>     Add an explicit root directory (repeatable). Supplements the
                     host's roots; used as the sole scope if the host advertises none.
    --no-sampling    Never call sampling/createMessage; kb_ask returns the grounded
                     context bundle + citations for the host to reason over.
    --name <name>    Override the advertised server name (default 'kbexplorer').
    --help, -h       Show this help.

  Tools:
    kb_ask           Ground a question in explicit node ids and answer via host sampling.
    kb_get_node      Fetch a single node (frontmatter + body) by id.
    kb_neighbors     BFS neighbours of a node up to a depth.
    kb_graph_stats   Node/edge/cluster counts and orphans for the scoped graph.

  Example (host config):
    { "command": "npx", "args": ["kbexplorer", "mcp"] }
`;

/** Convert a roots/list response into absolute directory paths. */
function rootsToDirs(rootsResult) {
  const out = [];
  for (const r of rootsResult?.roots ?? []) {
    if (typeof r?.uri !== 'string') continue;
    if (r.uri.startsWith('file://')) {
      try {
        out.push(fileURLToPath(r.uri));
      } catch {
        /* skip malformed uri */
      }
    } else {
      out.push(resolve(r.uri));
    }
  }
  return out;
}

/**
 * Shape a tool handler's return value into an MCP `CallToolResult`.
 *
 * Handlers may return either a ready-made tool result (an object with a
 * `content` array — e.g. the `{ isError, content }` error shape) or a plain
 * JSON payload, which is serialized into a single text content block. This
 * mirrors the contract the tools were written against.
 */
function shapeToolResult(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) return raw;
  return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
}

/**
 * Build the kbexplorer MCP server on the official MCP SDK.
 *
 * Exported for tests so an in-memory (or subprocess) SDK `Client` can drive it.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.flagRoots]   Roots from `--root` flags.
 * @param {boolean}  [opts.noSampling]  Disable sampling regardless of capability.
 * @param {string}   [opts.name]        Advertised server name.
 * @param {string}   [opts.cwd]         Working directory fallback.
 * @returns {{ server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, _state: object, _ensureRoots: Function, _getGraph: Function, _ctx: object }}
 */
export function createKbMcpServer({ flagRoots = [], noSampling = false, name = 'kbexplorer', cwd = process.cwd() } = {}) {
  const server = new McpServer({ name, version: SERVER_VERSION });
  /** The low-level protocol server — used for client requests & capabilities. */
  const low = server.server;

  const log = (msg) => process.stderr.write(`[kbexplorer mcp] ${msg}\n`);

  /**
   * Adapter bridging the tool handlers (written against a small `ctx`) to the
   * SDK's low-level server: capability inspection + server→client requests.
   */
  const ctx = {
    clientCapabilities: () => low.getClientCapabilities() ?? {},
    log,
    async request(method, params) {
      if (method === 'roots/list') return low.listRoots(params);
      if (method === 'sampling/createMessage') return low.createMessage(params);
      throw new Error(`unsupported server→client request: ${method}`);
    },
  };

  /** Lazily-resolved state, refreshed when roots change. */
  const state = {
    /** Monotonic token bumped on every roots invalidation. */
    generation: 0,
    rootsFetched: false,
    /** @type {Promise<string[]>|null} */
    rootsInFlight: null,
    /** @type {string[]} */
    roots: [],
    /** @type {import('../lib/graph.js').Graph|null} */
    graph: null,
  };
  const explicitFlagRoots = [...new Set(flagRoots.map((r) => resolve(r)))];

  function clientSupports(c, capability) {
    const caps = c.clientCapabilities() ?? {};
    return Boolean(caps[capability]);
  }

  /** Resolve the effective roots (host roots ∪ flag roots, else [cwd]). */
  async function ensureRoots(c) {
    if (state.rootsFetched) return state.roots;
    // Memoize the in-flight resolution so onInitialized and a concurrent first
    // tool call don't both issue roots/list.
    if (state.rootsInFlight) return state.rootsInFlight;
    const generation = state.generation;
    state.rootsInFlight = (async () => {
      let resolvedRoots = [];
      let rootsListError = null;
      const rootsCapable = clientSupports(c, 'roots');
      let hostRoots = [];
      if (rootsCapable) {
        try {
          const result = await c.request('roots/list', {});
          hostRoots = rootsToDirs(result);
        } catch (err) {
          rootsListError = err;
          c.log(`roots/list failed: ${String(err?.message ?? err)}`);
        }
      }
      if (rootsCapable) {
        const combined = [...new Set([...hostRoots, ...explicitFlagRoots])];
        if (combined.length) {
          resolvedRoots = combined;
        } else {
          // Host claimed roots capability but gave no usable roots (or listing failed).
          // Fail closed unless explicit --root flags were provided.
          resolvedRoots = [];
          const reason = rootsListError
            ? 'roots/list failed and no --root flags were provided'
            : 'roots/list returned no roots and no --root flags were provided';
          c.log(`${reason}; refusing cwd fallback (fail-closed).`);
        }
      } else {
        resolvedRoots = explicitFlagRoots.length ? explicitFlagRoots : [resolve(cwd)];
      }
      if (generation === state.generation) {
        state.roots = resolvedRoots;
        state.rootsFetched = true;
      }
      return resolvedRoots;
    })().finally(() => {
      if (generation === state.generation) {
        state.rootsInFlight = null;
      }
    });
    return state.rootsInFlight;
  }

  /** Load (and cache) the graph scoped to the effective roots. */
  async function getGraph(c) {
    if (state.graph) return state.graph;
    const generation = state.generation;
    const roots = await ensureRoots(c);
    if (generation !== state.generation) {
      // Roots changed while a prior resolution was in-flight; retry on current generation.
      return getGraph(c);
    }
    if (!state.graph) state.graph = loadGraph({ roots, cwd });
    return state.graph;
  }

  /** Invalidate caches when the host signals its roots changed. */
  function invalidate() {
    state.generation++;
    state.rootsFetched = false;
    state.rootsInFlight = null;
    state.roots = [];
    state.graph = null;
  }

  // --- Tools -----------------------------------------------------------------

  server.registerTool(
    'kb_ask',
    {
      description:
        'Answer a question grounded in specific knowledge-graph nodes supplied by the caller. ' +
        'Explore the graph first (kb_graph_stats → kb_neighbors → kb_get_node) to identify ' +
        'relevant node ids, then call kb_ask with those ids and your question. ' +
        'Uses the host model via MCP sampling when available; otherwise returns the grounded ' +
        'context bundle and citations.',
      inputSchema: {
        nodeIds: z
          .array(z.string().min(1))
          .min(1)
          .describe('Node ids to ground the answer in (from kb_get_node / kb_neighbors / kb_graph_stats).'),
        question: z.string().describe('The question to answer, grounded in the specified nodes.'),
      },
    },
    async (args) => {
      const rawIds = args?.nodeIds;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return { isError: true, content: [{ type: 'text', text: 'kb_ask requires a non-empty "nodeIds" array.' }] };
      }
      const nodeIds = rawIds.map(String).filter(Boolean);
      if (nodeIds.length === 0) {
        return { isError: true, content: [{ type: 'text', text: 'kb_ask requires at least one non-empty node id.' }] };
      }
      const question = String(args?.question ?? '').trim();
      if (!question) {
        return { isError: true, content: [{ type: 'text', text: 'kb_ask requires a non-empty "question".' }] };
      }

      const graph = await getGraph(ctx);

      const missing = nodeIds.filter((id) => !graph.nodes.has(id));
      if (missing.length) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown node ids: ${missing.join(', ')}. Use kb_graph_stats or kb_neighbors to discover valid ids.`,
            },
          ],
        };
      }

      const nodes = nodeIds.map((id) => graph.nodes.get(id));

      const citations = nodes.map((node) => ({
        id: node.id,
        title: node.title,
        cluster: node.cluster,
        relPath: node.relPath,
      }));

      const bundle = nodes
        .map((node) => `### [${node.id}] ${node.title} (cluster: ${node.cluster})\n${snippet(node.body)}`)
        .join('\n\n');

      const samplingAvailable = !noSampling && clientSupports(ctx, 'sampling');

      if (!samplingAvailable) {
        return shapeToolResult({
          usedSampling: false,
          reason: noSampling ? 'sampling disabled via --no-sampling' : 'host did not advertise sampling capability',
          question,
          citations,
          contextBundle: bundle,
          roots: graph.roots,
        });
      }

      const userText = `Question: ${question}\n\nContext nodes:\n\n${bundle}`;
      let result;
      try {
        result = await ctx.request('sampling/createMessage', {
          messages: [{ role: 'user', content: { type: 'text', text: userText } }],
          systemPrompt: GROUNDING_SYSTEM_PROMPT,
          includeContext: 'none',
          maxTokens: 1024,
          modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.4 },
        });
      } catch (err) {
        return shapeToolResult({
          usedSampling: false,
          reason: `sampling/createMessage failed: ${String(err?.message ?? err)}`,
          question,
          citations,
          contextBundle: bundle,
          roots: graph.roots,
        });
      }

      const answerText =
        typeof result?.content?.text === 'string'
          ? result.content.text
          : Array.isArray(result?.content)
            ? result.content
                .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                .filter(Boolean)
                .join('\n')
            : '';
      const normalizedAnswer = answerText.trim();

      if (!normalizedAnswer) {
        return shapeToolResult({
          usedSampling: false,
          reason: 'sampling returned no usable text; falling back to grounded context bundle',
          question,
          citations,
          contextBundle: bundle,
          roots: graph.roots,
        });
      }

      return shapeToolResult({
        usedSampling: true,
        model: result?.model ?? null,
        stopReason: result?.stopReason ?? null,
        answer: normalizedAnswer,
        citations,
        roots: graph.roots,
      });
    },
  );

  server.registerTool(
    'kb_get_node',
    {
      description: 'Fetch a single knowledge-graph node (frontmatter + full body) by id.',
      inputSchema: {
        id: z.string().describe('Node id.'),
      },
    },
    async (args) => {
      const id = String(args?.id ?? '').trim();
      const graph = await getGraph(ctx);
      const node = graph.nodes.get(id);
      if (!node) {
        return { isError: true, content: [{ type: 'text', text: `Unknown node id: ${id}` }] };
      }
      return shapeToolResult({
        id: node.id,
        title: node.title,
        cluster: node.cluster,
        parent: node.parent ?? null,
        emoji: node.emoji ?? null,
        connections: node.connections,
        relPath: node.relPath,
        body: node.body,
      });
    },
  );

  server.registerTool(
    'kb_neighbors',
    {
      description: 'Breadth-first neighbours of a node up to a given depth.',
      inputSchema: {
        id: z.string().describe('Node id.'),
        depth: z.number().optional().describe('Traversal depth (default 1, max 4).'),
      },
    },
    async (args) => {
      const id = String(args?.id ?? '').trim();
      const graph = await getGraph(ctx);
      if (!graph.nodes.has(id)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown node id: ${id}` }] };
      }
      const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(4, args.depth)) : 1;
      return shapeToolResult({ id, depth, neighbors: neighbors(graph, id, depth) });
    },
  );

  server.registerTool(
    'kb_graph_stats',
    {
      description: 'Summary statistics for the scoped knowledge graph: node/edge/cluster counts and orphans.',
      inputSchema: {},
    },
    async () => {
      const graph = await getGraph(ctx);
      return shapeToolResult(graphStats(graph));
    },
  );

  // --- Lifecycle wiring -------------------------------------------------------

  // Invalidate caches when the host signals its roots changed.
  low.setNotificationHandler(RootsListChangedNotificationSchema, () => invalidate());

  // Eagerly resolve roots after the handshake so the first tool call is warm
  // and any roots/list error surfaces in the server log, not mid-tool.
  const priorOnInitialized = low.oninitialized;
  low.oninitialized = () => {
    try {
      priorOnInitialized?.();
    } finally {
      ensureRoots(ctx).catch((err) => log(`initial roots resolution failed: ${String(err?.message ?? err)}`));
    }
  };

  return {
    server,
    // Test seams: expose internals for unit assertions.
    _state: state,
    _ensureRoots: ensureRoots,
    _getGraph: getGraph,
    _ctx: ctx,
  };
}

export default async function mcp(args = []) {
  const opts = parseMcpArgs(args);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.unknown.length) {
    process.stderr.write(`kbexplorer mcp: ignoring unknown args: ${opts.unknown.join(' ')}\n`);
  }

  const { server } = createKbMcpServer({
    flagRoots: opts.roots,
    noSampling: opts.noSampling,
    name: opts.name ?? 'kbexplorer',
    cwd: process.cwd(),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stay alive until the host ends the stdio stream (or signals us). The SDK's
  // StdioServerTransport only emits onclose on an explicit close(), so we also
  // watch stdin EOF directly — that lets the top-level await settle and the
  // process exit cleanly when a host simply closes the pipe.
  await new Promise((resolveDone) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    const low = server.server;
    const prevOnClose = low.onclose;
    low.onclose = () => {
      try {
        prevOnClose?.();
      } finally {
        settle();
      }
    };
    process.stdin.once('end', settle);
    process.stdin.once('close', settle);
    process.once('SIGINT', settle);
    process.once('SIGTERM', settle);
  });
}
