/**
 * Build a KBGraph from local content/ directory.
 *
 * Reads markdown files with kbexplorer frontmatter, parses config.yaml for
 * cluster definitions, and produces a KBGraph compatible with the
 * @anokye-labs/kbexplorer-search module's extraction pipeline.
 *
 * This is a lightweight graph builder for CLI use — the full graph is built
 * by the template's engine in the browser. This builder captures enough
 * structure (nodes, edges, clusters, hierarchy) for search indexing.
 */

import { resolve, relative, extname } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readContentFile, resolveContentDir } from './frontmatter.js';
import { readConfig } from './manifest.js';

/**
 * List all .md files recursively under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
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
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Parse clusters from config.yaml raw content.
 * @param {string|null} configRaw
 * @returns {Array<{id: string, name: string, color: string}>}
 */
function parseClusters(configRaw) {
  if (!configRaw) return [];
  const clusters = [];
  const lines = configRaw.split(/\r?\n/);
  let inClusters = false;
  let currentId = null;
  let currentCluster = {};
  for (const line of lines) {
    if (/^clusters\s*:/.test(line)) {
      inClusters = true;
      continue;
    }
    if (inClusters) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line) && !line.startsWith(' ')) {
        if (currentId) clusters.push({ id: currentId, ...currentCluster });
        inClusters = false;
        continue;
      }
      const idMatch = line.match(/^ {2}([A-Za-z0-9_-]+)\s*:\s*$/);
      if (idMatch) {
        if (currentId) clusters.push({ id: currentId, ...currentCluster });
        currentId = idMatch[1];
        currentCluster = { name: idMatch[1], color: '#ccc' };
        continue;
      }
      const nameMatch = line.match(/^ {4}name:\s*"?(.+?)"?\s*$/);
      if (nameMatch) currentCluster.name = nameMatch[1];
      const colorMatch = line.match(/^ {4}color:\s*"?(.+?)"?\s*$/);
      if (colorMatch) currentCluster.color = colorMatch[1];
    }
  }
  if (currentId) clusters.push({ id: currentId, ...currentCluster });
  return clusters;
}

/**
 * Build a KBGraph from the content directory.
 *
 * @param {string} cwd — repository root
 * @param {object} [options]
 * @param {string} [options.contentOverride] — override content directory path
 * @returns {{ nodes: object[], edges: object[], clusters: object[], related: object }}
 */
export function buildGraph(cwd, options = {}) {
  const { contentDir, contentPath } = resolveContentDir(cwd, options.contentOverride);
  const configRaw = readConfig(cwd, contentPath);
  const clusters = parseClusters(configRaw);
  const files = listMarkdownFiles(contentDir);

  const nodes = [];
  const edges = [];
  const nodeIds = new Set();

  for (const file of files) {
    const parsed = readContentFile(file);
    if (!parsed.ok || !parsed.frontmatter?.id) continue;

    const fm = parsed.frontmatter;
    const relPath = relative(cwd, file);
    const nodeId = fm.id;

    if (nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);

    const node = {
      id: nodeId,
      title: fm.title || nodeId,
      cluster: fm.cluster || 'default',
      content: '',
      rawContent: parsed.body || '',
      emoji: fm.emoji,
      parent: fm.parent || undefined,
      connections: (fm.connections || []).map((c) => ({
        to: c.to,
        type: c.type || 'references',
        description: c.description || '',
        source: 'frontmatter',
        weight: c.weight || 1,
      })),
      source: { type: 'authored', file: relPath },
      entityType: fm.entityType || fm.entity_type,
      identity: fm.identity,
    };

    nodes.push(node);

    // Create edges from connections
    for (const conn of node.connections) {
      edges.push({
        from: nodeId,
        to: conn.to,
        type: conn.type || 'references',
        description: conn.description || '',
        source: 'frontmatter',
        weight: conn.weight || 1,
      });
    }
  }

  // Add parent-child edges
  for (const node of nodes) {
    if (node.parent && nodeIds.has(node.parent)) {
      edges.push({
        from: node.parent,
        to: node.id,
        type: 'contains',
        description: `${node.parent} contains ${node.id}`,
        source: 'frontmatter',
        weight: 3,
      });
    }
  }

  return {
    nodes,
    edges,
    clusters,
    related: {},
  };
}
