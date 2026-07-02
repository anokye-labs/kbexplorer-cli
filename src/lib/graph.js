/**
 * Knowledge-graph loader and graph-native utilities.
 *
 * Builds an in-memory graph from authored `content/*.md` nodes (id / title /
 * cluster / parent / emoji / connections), optionally confined to a set of
 * granted root directories. Callers that operate under a sandbox (e.g. a host
 * that advertises which folders may be read) pass `roots`; everything loaded is
 * then confined to those roots, with symlink-escape guarded by canonical-path
 * comparison.
 *
 * This module is PROTOCOL-NEUTRAL: it knows nothing about MCP, JSON-RPC, or any
 * transport. It powers the graph-native affordances (query_node, graph_neighbors,
 * llm_context) in {@link module:src/affordances}, and any delivery adapter binds
 * to those affordances rather than to this loader directly. Graph navigation is
 * explicit and graph-native — no lexical keyword scoring is performed here.
 *
 * @module src/lib/graph
 */

import { resolve, relative, sep, isAbsolute } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { parseFrontmatter } from './frontmatter.js';
import { resolveContentDir } from './frontmatter.js';

/** Recursively list `.md` files under a directory (absolute paths). */
function listMarkdownFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Canonical absolute real path, tolerant of missing files. */
function canonical(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/**
 * Is `absPath` contained within one of the granted `roots`?
 * Guards against symlink escapes by comparing canonical paths.
 *
 * @param {string} absPath
 * @param {string[]} roots  Absolute root directories.
 * @returns {boolean}
 */
export function isWithinRoots(absPath, roots) {
  if (!roots || roots.length === 0) return true;
  const target = canonical(absPath);
  const targetCmp = process.platform === 'win32' ? target.toLowerCase() : target;
  for (const root of roots) {
    const base = canonical(root);
    const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base;
    if (targetCmp === baseCmp) return true;
    const rel = relative(base, target);
    if (!rel) return true;
    // On Windows, cross-drive paths produce an absolute relative value (e.g. D:\...).
    if (isAbsolute(rel)) continue;
    if (!rel.startsWith('..') && !rel.startsWith(sep) && !/^\.\.[\\/]/.test(rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the content directories to scan for a set of root directories.
 * For each root we look for a `content/` subdir (or honour VITE_KB_PATH); if
 * the root itself directly contains `.md` files we also scan it.
 *
 * @param {string[]} roots  Absolute root directories.
 * @returns {string[]} Absolute content directories that exist.
 */
export function resolveScanDirs(roots) {
  const dirs = new Set();
  for (const root of roots) {
    const abs = resolve(root);
    if (!existsSync(abs)) continue;
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const { contentDir } = resolveContentDir(abs);
    const hasContentDir = existsSync(contentDir);
    if (hasContentDir) {
      dirs.add(canonical(contentDir));
    }
    // Only include the root itself when there is no dedicated content dir.
    // Otherwise we'd recursively scan the entire repo root.
    if (hasContentDir) continue;
    try {
      const hasMd = readdirSync(abs, { withFileTypes: true }).some(
        (e) => e.isFile() && e.name.endsWith('.md')
      );
      if (hasMd) dirs.add(canonical(abs));
    } catch {
      /* ignore */
    }
  }
  return [...dirs];
}

/**
 * Load the knowledge graph confined to the given roots.
 *
 * @param {object} opts
 * @param {string[]} [opts.roots]  Absolute root directories (default [cwd]).
 * @param {string}  [opts.cwd]     Fallback root when `roots` is empty.
 * @returns {Graph}
 *
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {string} title
 * @property {string} cluster
 * @property {string|undefined} parent
 * @property {string|undefined} emoji
 * @property {string|undefined} identity  kg:// identity URN, carried through when present.
 * @property {string|undefined} access    Access label, carried through when present. Only a
 *   flat scalar survives today — {@link module:src/lib/frontmatter}'s parser is flat and
 *   throws on a nested `access:` block (issue #179 tracks nested-object frontmatter support).
 * @property {Array<{to: string, description: string}>} connections
 * @property {string} body
 * @property {string} path     Absolute file path.
 * @property {string} relPath  Path relative to the first root.
 *
 * @typedef {object} Graph
 * @property {Map<string, GraphNode>} nodes
 * @property {Map<string, Set<string>>} adjacency  Undirected neighbour sets by id.
 * @property {string[]} roots
 * @property {string[]} scanDirs
 * @property {string[]} skipped   Files skipped (parse error or out of roots).
 */
export function loadGraph({ roots, cwd = process.cwd() } = {}) {
  const hasExplicitRoots = Array.isArray(roots);
  const effectiveRoots = (hasExplicitRoots ? roots : [cwd]).map((r) => resolve(r));
  const scanDirs = resolveScanDirs(effectiveRoots);

  /** @type {Map<string, GraphNode>} */
  const nodes = new Map();
  const skipped = [];

  for (const dir of scanDirs) {
    for (const file of listMarkdownFiles(dir)) {
      if (!isWithinRoots(file, effectiveRoots)) {
        skipped.push(file);
        continue;
      }
      let raw;
      try {
        raw = readFileSync(file, 'utf-8');
      } catch {
        skipped.push(file);
        continue;
      }
      const parsed = parseFrontmatter(raw);
      if (!parsed.ok || !parsed.frontmatter?.id) {
        skipped.push(file);
        continue;
      }
      const fm = parsed.frontmatter;
      // First node wins on duplicate id (audit flags duplicates separately).
      if (nodes.has(fm.id)) continue;
      nodes.set(fm.id, {
        id: fm.id,
        title: fm.title ?? fm.id,
        cluster: fm.cluster ?? 'unknown',
        parent: fm.parent || undefined,
        emoji: fm.emoji || undefined,
        // Carry-through only, no new semantics: whatever the frontmatter parser
        // handed back for these keys rides onto the node as-is (see #179 above).
        identity: fm.identity || undefined,
        access: fm.access || undefined,
        connections: Array.isArray(fm.connections) ? fm.connections : [],
        body: parsed.body ?? '',
        path: file,
        relPath: relative(effectiveRoots[0] ?? resolve(cwd), file)
          .split(sep)
          .join('/'),
      });
    }
  }

  // Build undirected adjacency from connections + parent edges.
  const adjacency = new Map();
  for (const id of nodes.keys()) adjacency.set(id, new Set());
  for (const [id, node] of nodes) {
    for (const conn of node.connections) {
      if (nodes.has(conn.to)) {
        adjacency.get(id).add(conn.to);
        adjacency.get(conn.to).add(id);
      }
    }
    if (node.parent && nodes.has(node.parent)) {
      adjacency.get(id).add(node.parent);
      adjacency.get(node.parent).add(id);
    }
  }

  return { nodes, adjacency, roots: effectiveRoots, scanDirs, skipped };
}

/**
 * Breadth-first neighbours of a node up to `depth`.
 *
 * @param {Graph} graph
 * @param {string} id
 * @param {number} [depth=1]
 * @returns {Array<{id: string, title: string, cluster: string, distance: number}>}
 */
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

/**
 * Summary statistics over the loaded graph.
 *
 * @param {Graph} graph
 * @returns {{ nodeCount: number, edgeCount: number, clusters: Array<{cluster: string, count: number}>, orphans: string[], roots: string[] }}
 */
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

/** Trim a node body to a short snippet for context bundles. */
export function snippet(body, maxChars = 600) {
  const cleaned = (body || '').replace(/\r/g, '').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …';
}
