import { readFileSync } from 'node:fs';

/** Coerce assorted persisted graph shapes into `{ nodes, edges }`. */
export function normalizeGraph(raw: unknown): { nodes: unknown[]; edges: unknown[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { nodes: [], edges: [] };
  const graph = raw as Record<string, unknown>;
  const nodes = graph.nodes ?? graph['@graph'] ?? [];
  const edges = graph.edges ?? graph['@edges'] ?? [];
  return { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] };
}

/** Read + parse a graph JSON file into `{ nodes, edges }`. */
export function readGraphFile(path: string): { nodes: unknown[]; edges: unknown[] } {
  return normalizeGraph(JSON.parse(readFileSync(path, 'utf-8')));
}
