/**
 * kbexplorer links — Graph health analysis.
 *
 * Analyzes the knowledge graph and reports:
 * - Orphan nodes (zero connections)
 * - Broken references (connections to non-existent nodes)
 * - Weak clusters (no cross-cluster edges)
 * - Missing cross-references (content mentions without edges)
 * - Coverage gaps (source files with no content node)
 * - Connection suggestions
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { getAppRoot } from '../lib/detect-repo.js';
import { generateManifest } from '../lib/manifest.js';

// ── Frontmatter Parsing ────────────────────────────────────

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result = { connections: [] };
  let inConnections = false;
  let currentConn = null;

  for (const line of lines) {
    if (line.match(/^connections:/)) { inConnections = true; continue; }
    if (inConnections) {
      const toMatch = line.match(/^\s+-\s+to:\s*"?([^"\n]+)"?/);
      const descMatch = line.match(/^\s+description:\s*"?([^"\n]+)"?/);
      if (toMatch) {
        if (currentConn) result.connections.push(currentConn);
        currentConn = { to: toMatch[1].trim(), description: '' };
      } else if (descMatch && currentConn) {
        currentConn.description = descMatch[1].trim();
      } else if (!line.match(/^\s/) && line.trim()) {
        if (currentConn) result.connections.push(currentConn);
        currentConn = null;
        inConnections = false;
      }
    }
    if (!inConnections) {
      const kv = line.match(/^(\w+):\s*"?([^"\n]+)"?/);
      if (kv) result[kv[1].trim()] = kv[2].trim();
    }
  }
  if (currentConn) result.connections.push(currentConn);
  return result;
}

// ── Analysis ───────────────────────────────────────────────

function analyzeGraph(manifest, cwd) {
  const report = {
    stats: { authored: 0, issues: 0, prs: 0, commits: 0, treeFiles: 0, totalEdges: 0 },
    orphans: [],
    brokenRefs: [],
    weakClusters: [],
    unlinkified: [],          // mentions that should be inline links
    redundantFrontmatter: [], // frontmatter duplicating inline links
    coverageGaps: [],
  };

  // Parse all authored content nodes
  const authoredNodes = new Map();
  for (const [path, raw] of Object.entries(manifest.authoredContent || {})) {
    const fm = parseFrontmatter(raw);
    if (fm.id) {
      authoredNodes.set(fm.id, { ...fm, path, raw });
    }
  }
  report.stats.authored = authoredNodes.size;

  // Build full node ID set (authored + issues + PRs + tree)
  const allNodeIds = new Set(authoredNodes.keys());

  const issues = manifest.issues || [];
  for (const issue of issues) {
    allNodeIds.add(`issue-${issue.number}`);
  }
  report.stats.issues = issues.length;

  const prs = manifest.pullRequests || [];
  for (const pr of prs) {
    allNodeIds.add(`pr-${pr.number}`);
  }
  report.stats.prs = prs.length;

  const commits = manifest.commits || [];
  report.stats.commits = commits.length;

  // Tree items — directories and key files
  const treeFiles = (manifest.tree || []).filter(t => t.type === 'blob');
  report.stats.treeFiles = treeFiles.length;

  // Add tree-derived node IDs (directories and key files)
  const topDirs = new Set();
  for (const item of manifest.tree || []) {
    const parts = item.path.split('/');
    if (parts.length > 1 && !parts[0].startsWith('.')) {
      topDirs.add(parts[0]);
    }
  }
  for (const dir of topDirs) {
    allNodeIds.add(`dir-${dir}`);
  }
  allNodeIds.add('repo-root');
  if (manifest.readme) allNodeIds.add('readme');

  // Build adjacency and edge tracking
  const adj = new Map();
  for (const id of allNodeIds) adj.set(id, new Set());

  let totalEdges = 0;

  // Edges from authored connections
  for (const [id, node] of authoredNodes) {
    for (const conn of node.connections || []) {
      if (allNodeIds.has(conn.to)) {
        adj.get(id)?.add(conn.to);
        adj.get(conn.to)?.add(id);
        totalEdges++;
      }
    }
  }

  // Edges from issue cross-references
  for (const issue of issues) {
    const nodeId = `issue-${issue.number}`;
    const refs = (issue.body || '').matchAll(/#(\d+)/g);
    for (const m of refs) {
      const refId = `issue-${m[1]}`;
      if (allNodeIds.has(refId)) {
        adj.get(nodeId)?.add(refId);
        adj.get(refId)?.add(nodeId);
        totalEdges++;
      }
    }
  }

  report.stats.totalEdges = totalEdges;

  // ── 1. Orphan nodes ──────────────────────────────────────

  for (const [id, neighbors] of adj) {
    if (neighbors.size === 0) {
      const node = authoredNodes.get(id);
      report.orphans.push({
        id,
        type: node ? 'authored' : id.startsWith('issue-') ? 'issue' : id.startsWith('pr-') ? 'pr' : 'tree',
        title: node?.title || id,
      });
    }
  }

  // ── 2. Broken references ─────────────────────────────────

  for (const [id, node] of authoredNodes) {
    for (const conn of node.connections || []) {
      if (!allNodeIds.has(conn.to)) {
        report.brokenRefs.push({
          from: id,
          to: conn.to,
          description: conn.description,
        });
      }
    }
  }

  // ── 3. Weak clusters ─────────────────────────────────────

  const clusterNodes = new Map(); // cluster → Set<id>
  for (const [id, node] of authoredNodes) {
    const cluster = node.cluster || 'unknown';
    if (!clusterNodes.has(cluster)) clusterNodes.set(cluster, new Set());
    clusterNodes.get(cluster).add(id);
  }

  for (const [cluster, nodeIds] of clusterNodes) {
    let crossClusterEdges = 0;
    for (const id of nodeIds) {
      for (const neighbor of adj.get(id) || []) {
        const neighborNode = authoredNodes.get(neighbor);
        if (neighborNode && neighborNode.cluster !== cluster) {
          crossClusterEdges++;
        }
      }
    }
    if (crossClusterEdges === 0 && nodeIds.size > 1) {
      report.weakClusters.push({
        cluster,
        nodeCount: nodeIds.size,
        nodes: [...nodeIds].slice(0, 5),
      });
    }
  }

  // ── 4. Inline link extraction — find existing inline links ─

  // Scan body for [text](target) markdown links that resolve to node IDs
  // These are edges that exist in content but aren't in frontmatter
  const inlineEdges = new Map(); // nodeId → Set<targetId>
  for (const [id, node] of authoredNodes) {
    const body = node.raw || '';
    const inlineTargets = new Set();

    // Markdown links: [text](target)
    for (const m of body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      const target = m[2].trim();
      if (allNodeIds.has(target)) inlineTargets.add(target);
    }

    inlineEdges.set(id, inlineTargets);
  }

  // ── 5. Redundant frontmatter — frontmatter duplicating inline links ─

  report.redundantFrontmatter = [];
  for (const [id, node] of authoredNodes) {
    const inline = inlineEdges.get(id) || new Set();
    for (const conn of node.connections || []) {
      if (inline.has(conn.to)) {
        report.redundantFrontmatter.push({
          node: id,
          to: conn.to,
          reason: `frontmatter connection duplicates inline link`,
        });
      }
    }
  }

  // ── 6. Unlinkified mentions — text mentions that should be inline links ─

  report.unlinkified = [];
  for (const [id, node] of authoredNodes) {
    const body = node.raw || '';
    const bodyLower = body.toLowerCase();
    const connectedTo = new Set((node.connections || []).map(c => c.to));
    const inlineTo = inlineEdges.get(id) || new Set();
    const alreadySuggested = new Set();

    // Check for title mentions that aren't inline links or frontmatter connections
    for (const [otherId, otherNode] of authoredNodes) {
      if (otherId === id) continue;
      if (connectedTo.has(otherId) || inlineTo.has(otherId)) continue;
      if (alreadySuggested.has(otherId)) continue;
      const otherTitle = (otherNode.title || '').toLowerCase();
      const words = otherTitle.split(/\s+/).filter(w => w.length > 3);
      if (words.length >= 2) {
        const matchCount = words.filter(w => bodyLower.includes(w)).length;
        if (matchCount >= Math.ceil(words.length * 0.7)) {
          report.unlinkified.push({
            from: id,
            to: otherId,
            suggestion: `change "${otherNode.title}" to [${otherNode.title}](${otherId})`,
          });
          alreadySuggested.add(otherId);
        }
      }
    }

    // Check for issue references #N not linked
    const issueRefNums = new Set();
    for (const m of body.matchAll(/(?<!\w)#(\d+)(?!\d)/g)) {
      const num = parseInt(m[1], 10);
      const idx = m.index || 0;
      const context = body.substring(Math.max(0, idx - 20), idx);
      if (context.includes('#L') || context.includes('line') || context.includes('blob/')) continue;
      if (num > 0 && num < 10000) issueRefNums.add(num);
    }
    for (const num of issueRefNums) {
      const ref = `issue-${num}`;
      if (!connectedTo.has(ref) && !inlineTo.has(ref) && allNodeIds.has(ref)) {
        report.unlinkified.push({
          from: id,
          to: ref,
          suggestion: `convert #${num} to inline link [#${num}](${ref})`,
        });
      }
    }
  }

  // ── 5. Coverage gaps ─────────────────────────────────────

  // Key source files that have no corresponding content node
  const keyExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const skipFiles = new Set(['index.ts', 'index.js', 'vite-env.d.ts']);
  const coveredPaths = new Set();

  // Gather paths mentioned in authored content
  for (const [, node] of authoredNodes) {
    const body = node.raw || '';
    const pathMatches = body.matchAll(/(?:src|scripts|content)\/[\w/./-]+\.\w+/g);
    for (const m of pathMatches) coveredPaths.add(m[0]);
  }

  for (const item of treeFiles) {
    const ext = '.' + item.path.split('.').pop();
    if (!keyExtensions.has(ext)) continue;
    const filename = item.path.split('/').pop();
    if (skipFiles.has(filename)) continue;
    if (item.path.includes('__tests__')) continue;
    if (item.path.includes('node_modules')) continue;

    // Check if any authored node mentions this file
    const mentioned = coveredPaths.has(item.path) ||
      [...authoredNodes.values()].some(n => (n.raw || '').includes(item.path));

    if (!mentioned) {
      report.coverageGaps.push({ file: item.path });
    }
  }

  return report;
}

// ── Output ─────────────────────────────────────────────────

function printReport(report) {
  const { stats } = report;

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Graph Health Report                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Nodes: ${stats.authored} authored, ${stats.issues} issues, ${stats.prs} PRs, ${stats.commits} commits, ${stats.treeFiles} files`);
  console.log(`  Edges: ${stats.totalEdges}`);
  console.log('');

  // Broken refs (errors)
  if (report.brokenRefs.length > 0) {
    console.log(`✗ Broken references (${report.brokenRefs.length}):`);
    for (const ref of report.brokenRefs) {
      console.log(`  ${ref.from} → ${ref.to} (${ref.description || 'no description'})`);
    }
    console.log('');
  }

  // Orphans
  if (report.orphans.length > 0) {
    console.log(`⚠ Orphan nodes (${report.orphans.length}):`);
    for (const o of report.orphans.slice(0, 15)) {
      console.log(`  ${o.id} [${o.type}]`);
    }
    if (report.orphans.length > 15) {
      console.log(`  ... and ${report.orphans.length - 15} more`);
    }
    console.log('');
  }

  // Weak clusters
  if (report.weakClusters.length > 0) {
    console.log(`⚠ Weak clusters — no cross-cluster edges (${report.weakClusters.length}):`);
    for (const c of report.weakClusters) {
      console.log(`  "${c.cluster}" (${c.nodeCount} nodes): ${c.nodes.join(', ')}`);
    }
    console.log('');
  }

  // Redundant frontmatter
  if (report.redundantFrontmatter.length > 0) {
    console.log(`⚠ Redundant frontmatter — duplicates inline links (${report.redundantFrontmatter.length}):`);
    for (const r of report.redundantFrontmatter.slice(0, 10)) {
      console.log(`  ${r.node} → ${r.to}: remove from frontmatter (inline link exists)`);
    }
    if (report.redundantFrontmatter.length > 10) {
      console.log(`  ... and ${report.redundantFrontmatter.length - 10} more`);
    }
    console.log('');
  }

  // Unlinkified mentions
  if (report.unlinkified.length > 0) {
    console.log(`⚠ Unlinkified mentions — convert to inline links (${report.unlinkified.length}):`);
    for (const ref of report.unlinkified.slice(0, 15)) {
      console.log(`  ${ref.from}: ${ref.suggestion}`);
    }
    if (report.unlinkified.length > 15) {
      console.log(`  ... and ${report.unlinkified.length - 15} more`);
    }
    console.log('');
  }

  // Coverage gaps
  if (report.coverageGaps.length > 0) {
    console.log(`⚠ Coverage gaps — source files without content (${report.coverageGaps.length}):`);
    for (const g of report.coverageGaps.slice(0, 15)) {
      console.log(`  ${g.file}`);
    }
    if (report.coverageGaps.length > 15) {
      console.log(`  ... and ${report.coverageGaps.length - 15} more`);
    }
    console.log('');
  }

  // Summary
  const issues = report.brokenRefs.length + report.orphans.length +
    report.weakClusters.length + report.unlinkified.length +
    report.redundantFrontmatter.length + report.coverageGaps.length;
  if (issues === 0) {
    console.log('✅ Graph is healthy — no issues found.');
  } else {
    console.log(`───────────────────────────────────────────`);
    console.log(`  ${report.brokenRefs.length} broken, ${report.orphans.length} orphans, ${report.weakClusters.length} weak clusters`);
    console.log(`  ${report.unlinkified.length} unlinkified mentions, ${report.redundantFrontmatter.length} redundant frontmatter, ${report.coverageGaps.length} coverage gaps`);
  }
  console.log('');
}

// ── Command ────────────────────────────────────────────────

export default async function links(args) {
  const cwd = process.cwd();

  // Generate or find manifest
  let manifest;
  const appRoot = getAppRoot(cwd);
  const manifestPath = appRoot
    ? resolve(appRoot, 'src', 'generated', 'repo-manifest.json')
    : resolve(cwd, 'src', 'generated', 'repo-manifest.json');

  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } else {
    console.log('📋 Generating manifest for analysis...');
    manifest = generateManifest(cwd);
  }

  const report = analyzeGraph(manifest, cwd);
  printReport(report);

  // JSON output
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
}
