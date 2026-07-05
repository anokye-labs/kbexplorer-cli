/**
 * Affordance: `graph_neighbors` — breadth-first neighbours of a node.
 *
 * Graph-native, read-only, protocol-neutral. Salvaged from the `kb_neighbors`
 * logic on `feat/mcp-server`, decoupled from the MCP tool wiring.
 *
 * @module src/affordances/operations/graph-neighbors
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.ts';
import { neighbors } from '../../lib/engine-graph.ts';

export default defineAffordance({
  name: 'graph_neighbors',
  title: 'Graph neighbours',
  summary: 'Breadth-first neighbours of a node up to a given depth (max 4).',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Node id.' },
    depth: { type: 'number', default: 1, min: 1, max: 4, description: 'Traversal depth (1..4).' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    depth: { type: 'number' },
    neighbors: { type: 'array' },
  }),
  async execute(context, input) {
    const graph = await context.loadGraph();
    if (!graph.nodes.has(input.id)) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `Unknown node id: ${input.id}`, {
        id: input.id,
      });
    }
    const depth = input.depth ?? 1;
    return { id: input.id, depth, neighbors: neighbors(graph, input.id, depth) };
  },
});
