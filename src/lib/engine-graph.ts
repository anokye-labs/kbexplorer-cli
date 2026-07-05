import { resolve, relative, sep, isAbsolute } from 'node:path';
import { buildEngineGraph } from './engine-graph-builder.ts';

interface SourceLocation {
  path?: string;
  file?: string;
  uri?: string;
  sourcePath?: string;
}

interface GraphConnection {
  to: string;
}

interface EngineNode {
  id: string;
  title?: string;
  cluster?: string;
  parent?: string;
  emoji?: string;
  rawContent?: string;
  content?: string;
  source?: SourceLocation;
  connections?: GraphConnection[];
  access?: unknown;
  identity?: unknown;
}

interface NormalizedNode extends EngineNode {
  title: string;
  cluster: string;
  body: string;
  relPath: string;
  connections: GraphConnection[];
}

export interface LoadedGraph {
  nodes: Map<string, NormalizedNode>;
  adjacency: Map<string, Set<string>>;
  roots: string[];
  scanDirs: string[];
  skipped: unknown[];
  clusters: unknown[];
  edges: unknown[];
}

function toPosix(value: unknown): string {
  return String(value).split(sep).join('/');
}

function deriveRelPath(node: EngineNode, cwd: string): string {
  const source = node?.source;
  const candidate = source?.path ?? source?.file ?? source?.uri ?? source?.sourcePath;
  if (typeof candidate !== 'string' || candidate.length === 0) return node?.id ?? '';
  if (!isAbsolute(candidate)) return toPosix(candidate);
  try {
    return toPosix(relative(cwd, candidate));
  } catch {
    return toPosix(candidate);
  }
}

function normalizeNode(node: EngineNode, cwd: string): NormalizedNode {
  const normalized: NormalizedNode = {
    ...node,
    title: node.title ?? node.id,
    cluster: node.cluster ?? 'unknown',
    parent: node.parent || undefined,
    emoji: node.emoji || undefined,
    body: node.rawContent ?? node.content ?? '',
    relPath: deriveRelPath(node, cwd),
    connections: Array.isArray(node.connections) ? node.connections : [],
    access: node.access,
    identity: node.identity,
  };
  return normalized;
}

export async function loadGraph({
  roots,
  cwd = process.cwd(),
  content,
}: {
  roots?: string[];
  cwd?: string;
  content?: string;
} = {}): Promise<LoadedGraph> {
  const absCwd = resolve(cwd);
  const effectiveRoots = (Array.isArray(roots) && roots.length > 0 ? roots : [absCwd]).map((root) => resolve(root));
  const sourceRoot = effectiveRoots[0] ?? absCwd;
  const graph = await buildEngineGraph(absCwd, { contentOverride: content, sourceRoot });
  const nodeMap = new Map<string, NormalizedNode>();
  for (const node of ((graph.nodes ?? []) as EngineNode[])) {
    nodeMap.set(node.id, normalizeNode(node, absCwd));
  }

  const adjacency = new Map<string, Set<string>>();
  for (const id of nodeMap.keys()) adjacency.set(id, new Set());
  for (const node of nodeMap.values()) {
    for (const conn of node.connections ?? []) {
      if (nodeMap.has(conn.to)) {
        adjacency.get(node.id)?.add(conn.to);
        adjacency.get(conn.to)?.add(node.id);
      }
    }
    if (node.parent && nodeMap.has(node.parent)) {
      adjacency.get(node.id)?.add(node.parent);
      adjacency.get(node.parent)?.add(node.id);
    }
  }

  return {
    nodes: nodeMap,
    adjacency,
    roots: effectiveRoots,
    scanDirs: effectiveRoots,
    skipped: [],
    clusters: graph.clusters ?? [],
    edges: graph.edges ?? [],
  };
}

export function neighbors(graph: LoadedGraph, id: string, depth = 1) {
  if (!graph.nodes.has(id)) return [];
  const seen = new Set([id]);
  const out = [];
  let frontier = [id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of graph.adjacency.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        const node = graph.nodes.get(nb);
        if (!node) continue;
        out.push({ id: nb, title: node.title, cluster: node.cluster, distance: d });
        next.push(nb);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

export function shortestPath(graph: LoadedGraph, fromId: string, toId: string): string[] | null {
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) return null;
  if (fromId === toId) return [fromId];

  const visited = new Set([fromId]);
  const parent = new Map();
  let frontier = [fromId];
  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of graph.adjacency.get(cur) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        parent.set(nb, cur);
        if (nb === toId) {
          const path = [toId];
          let step = toId;
          while (step !== fromId) {
            const nextStep = parent.get(step);
            if (!nextStep) return null;
            step = nextStep;
            path.push(step);
          }
          return path.reverse();
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

export function graphStats(graph: LoadedGraph) {
  const clusterCounts = new Map<string, number>();
  let edgeCount = 0;
  const counted = new Set();
  const orphans = [];

  for (const [id, node] of graph.nodes) {
    clusterCounts.set(node.cluster, (clusterCounts.get(node.cluster) ?? 0) + 1);
    const deg = graph.adjacency.get(id)?.size ?? 0;
    if (deg === 0) orphans.push(id);
    for (const nb of graph.adjacency.get(id) ?? []) {
      const key = id < nb ? `${id}\u0000${nb}` : `${nb}\u0000${id}`;
      if (!counted.has(key)) {
        counted.add(key);
        edgeCount++;
      }
    }
  }

  return {
    nodeCount: graph.nodes.size,
    edgeCount,
    clusters: [...clusterCounts.entries()]
      .map(([cluster, count]) => ({ cluster, count }))
      .sort((a, b) => b.count - a.count),
    orphans,
    roots: graph.roots,
  };
}

export function snippet(body: string, maxChars = 600): string {
  const cleaned = (body || '').replace(/\r/g, '').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …';
}
