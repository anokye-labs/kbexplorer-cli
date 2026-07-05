/**
 * Affordance: `trace` — connect two nodes, or surface one node's immediate
 * connections.
 *
 * Graph-native, read-only, protocol-neutral. Backs the canvas `trace` action
 * (#194): given `fromId`/`toId` it returns the shortest (fewest-hops) path
 * between them over the same undirected adjacency `graph_neighbors` walks;
 * given only `nodeId` (or `fromId` alone) it returns that node's immediate
 * (depth-1) connections, mirroring a 1-hop `graph_neighbors` call framed as a
 * "trace from here."
 *
 * @module src/affordances/operations/trace
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';
import { shortestPath, neighbors } from '../../lib/engine-graph.js';

export default defineAffordance({
  name: 'trace',
  title: 'Trace connection',
  summary:
    'Shortest path between two nodes (fromId/toId), or the immediate connections of one node.',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    fromId: { type: 'string', description: 'Start node id.' },
    toId: { type: 'string', description: 'End node id; traces a path to it when given.' },
    nodeId: {
      type: 'string',
      description: 'Single node id — alias for fromId when toId is omitted.',
    },
  }),
  output: defineSchema({
    fromId: { type: 'string' },
    toId: { type: 'string' },
    connected: { type: 'boolean' },
    path: { type: 'array' },
    nodes: { type: 'array' },
  }),
  async execute(context, input) {
    const fromId = input.fromId || input.nodeId;
    const toId = input.toId;
    if (!fromId) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        'trace requires "fromId" (or "nodeId"), optionally with "toId".'
      );
    }

    const graph = await context.loadGraph();
    if (!graph.nodes.has(fromId)) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `Unknown node id: ${fromId}`, {
        id: fromId,
      });
    }

    if (toId) {
      if (!graph.nodes.has(toId)) {
        throw new AffordanceError(ERROR_CODES.NOT_FOUND, `Unknown node id: ${toId}`, { id: toId });
      }
      const path = shortestPath(graph, fromId, toId);
      const ids = path ?? [];
      return {
        fromId,
        toId,
        connected: path != null,
        path: ids,
        nodes: ids.map((id) => {
          const node = graph.nodes.get(id);
          return { id, title: node.title, cluster: node.cluster };
        }),
      };
    }

    // No toId: trace the immediate (depth-1) neighbourhood of a single node.
    // `neighbors()` returns { id, title, cluster, distance }, but the two-node
    // path branch above only ever returns { id, title, cluster } — strip
    // `distance` here so `nodes` has one uniform shape across both trace
    // modes regardless of which branch produced it.
    const nb = neighbors(graph, fromId, 1);
    const path = [fromId, ...nb.map((n) => n.id)];
    return {
      fromId,
      toId: null,
      connected: nb.length > 0,
      path,
      nodes: [
        {
          id: fromId,
          title: graph.nodes.get(fromId).title,
          cluster: graph.nodes.get(fromId).cluster,
        },
        ...nb.map(({ id, title, cluster }) => ({ id, title, cluster })),
      ],
    };
  },
});
