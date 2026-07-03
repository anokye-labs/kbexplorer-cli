import { readFileSync } from 'node:fs';

/** Coerce assorted persisted graph shapes into `{ nodes, edges }`. */
export function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object') return { nodes: [], edges: [] };
  const nodes = raw.nodes ?? raw['@graph'] ?? [];
  const edges = raw.edges ?? raw['@edges'] ?? [];
  return { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] };
}

/** Read + parse a graph JSON file into `{ nodes, edges }`. */
export function readGraphFile(path) {
  return normalizeGraph(JSON.parse(readFileSync(path, 'utf-8')));
}
