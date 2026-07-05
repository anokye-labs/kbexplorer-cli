import { resolve, relative, sep, isAbsolute } from 'node:path';
import { buildEngineGraph } from './engine-graph-builder.js';

function toPosix(value) {
  return String(value).split(sep).join('/');
}

function deriveRelPath(node, cwd) {
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

function normalizeNode(node, cwd) {
  const normalized = {
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

export async function loadGraph({ roots, cwd = process.cwd(), content } = {}) {
  const absCwd = resolve(cwd);
  const effectiveRoots = (Array.isArray(roots) && roots.length > 0 ? roots : [absCwd]).map((root) => resolve(root));
  const sourceRoot = effectiveRoots[0] ?? absCwd;
  const graph = await buildEngineGraph(absCwd, { contentOverride: content, sourceRoot });
  const nodeMap = new Map();
  for (const node of graph.nodes ?? []) {
    nodeMap.set(node.id, normalizeNode(node, absCwd));
  }

  const adjacency = new Map();
  for (const id of nodeMap.keys()) adjacency.set(id, new Set());
  for (const node of nodeMap.values()) {
    for (const conn of node.connections ?? []) {
      if (nodeMap.has(conn.to)) {
        adjacency.get(node.id).add(conn.to);
        adjacency.get(conn.to).add(node.id);
      }
    }
    if (node.parent && nodeMap.has(node.parent)) {
      adjacency.get(node.id).add(node.parent);
      adjacency.get(node.parent).add(node.id);
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

export function neighbors(graph, id, depth = 1) {
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
        out.push({ id: nb, title: node.title, cluster: node.cluster, distance: d });
        next.push(nb);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

export function shortestPath(graph, fromId, toId) {
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
            step = parent.get(step);
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

export function graphStats(graph) {
  const clusterCounts = new Map();
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

export function snippet(body, maxChars = 600) {
  const cleaned = (body || '').replace(/\r/g, '').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …';
}
