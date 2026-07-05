/**
 * Affordance: `query_node` — fetch a single knowledge-graph node by id.
 *
 * Graph-native, read-only, protocol-neutral. Salvaged from the `kb_get_node`
 * logic on `feat/mcp-server`, decoupled from the MCP tool wiring.
 *
 * @module src/affordances/operations/query-node
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';

export default defineAffordance({
  name: 'query_node',
  title: 'Query node',
  summary: 'Fetch a single knowledge-graph node (frontmatter + full body) by id.',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Node id.' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    title: { type: 'string' },
    cluster: { type: 'string' },
    parent: { type: 'string' },
    emoji: { type: 'string' },
    connections: { type: 'array' },
    relPath: { type: 'string' },
    body: { type: 'string' },
  }),
  async execute(context, input) {
    const graph = await context.loadGraph();
    const node = graph.nodes.get(input.id);
    if (!node) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `Unknown node id: ${input.id}`, {
        id: input.id,
      });
    }
    return {
      id: node.id,
      title: node.title,
      cluster: node.cluster,
      parent: node.parent ?? null,
      emoji: node.emoji ?? null,
      connections: node.connections,
      relPath: node.relPath,
      body: node.body,
    };
  },
});
