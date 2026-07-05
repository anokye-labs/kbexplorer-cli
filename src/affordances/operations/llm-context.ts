/**
 * Affordance: `llm_context` — assemble a grounded context bundle for an LLM.
 *
 * Given explicit node ids (and an optional question), assembles a citation list
 * and a grounded context bundle the caller can feed to a model. This is the
 * protocol-neutral *grounding* half of the old `kb_ask` tool — **the contract
 * never calls a model itself**. The actual sampling / model invocation belongs
 * to a delivery adapter (the MCP sampling bridge, PE3-F4) or the job layer; that
 * separation is exactly why the MCP wiring was decoupled from this contract.
 *
 * Classified `sample` for the consent layer (PE3-F3): it produces material
 * intended to be sent to a model.
 *
 * @module src/affordances/operations/llm-context
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.ts';
import { snippet, type LoadedGraph } from '../../lib/engine-graph.ts';
import type { AffordanceContext } from '../context.ts';

type GraphNode = LoadedGraph['nodes'] extends Map<string, infer Node> ? Node : never;

interface LlmContextInput extends Record<string, unknown> {
  nodeIds: string[];
  question?: string;
}

export default defineAffordance({
  name: 'llm_context',
  title: 'LLM context bundle',
  summary:
    'Assemble a grounded context bundle and citations from explicit node ids for a model to reason over. Does not call a model.',
  actionClass: ACTION_CLASSES.SAMPLE,
  input: defineSchema({
    nodeIds: {
      type: 'array',
      item: { type: 'string' },
      required: true,
      minItems: 1,
      description: 'Node ids to ground the context in (from query_node / graph_neighbors).',
    },
    question: { type: 'string', description: 'Optional question the context is meant to answer.' },
  }),
  output: defineSchema({
    question: { type: 'string' },
    citations: { type: 'array' },
    contextBundle: { type: 'string' },
    nodeIds: { type: 'array' },
    roots: { type: 'array' },
  }),
  async execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as LlmContextInput;
    const nodeIds = args.nodeIds.map(String).filter(Boolean);
    if (nodeIds.length === 0) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        'llm_context requires at least one non-empty node id.'
      );
    }

    const graph = await context.loadGraph();
    const missing = nodeIds.filter((id) => !graph.nodes.has(id));
    if (missing.length) {
      throw new AffordanceError(
        ERROR_CODES.NOT_FOUND,
        `Unknown node ids: ${missing.join(', ')}. Use graph_neighbors or query_node to discover valid ids.`,
        { missing }
      );
    }

    const nodes: GraphNode[] = nodeIds
      .map((id) => graph.nodes.get(id))
      .filter((node): node is GraphNode => Boolean(node));
    const citations = nodes.map((node) => ({
      id: node.id,
      title: node.title,
      cluster: node.cluster,
      relPath: node.relPath,
    }));
    const contextBundle = nodes
      .map(
        (node) => `### [${node.id}] ${node.title} (cluster: ${node.cluster})\n${snippet(node.body)}`
      )
      .join('\n\n');

    return {
      question: typeof args.question === 'string' ? args.question.trim() : '',
      citations,
      contextBundle,
      nodeIds,
      roots: graph.roots,
    };
  },
});
