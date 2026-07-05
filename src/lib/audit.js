/**
 * Schema and structural integrity audit for kbx content.
 *
 * Complements the soft "graph health" analysis in `links.js` with hard
 * structural errors that break the explorer at runtime:
 *
 *   - missing required frontmatter (id, title, cluster)
 *   - duplicate node ids across files
 *   - undeclared cluster (frontmatter cluster not in config.yaml)
 *   - broken parent reference (parent: id that does not exist)
 *   - parent cycle (a → b → ... → a)
 *   - dead connection target (connections.to → unknown id)
 *   - malformed YAML frontmatter
 *   - file/id mismatch (filename slug differs from id)
 *
 * Reported severities:
 *   - error: blocks the explorer or silently corrupts the graph
 *   - warning: indicates likely author intent issue
 *
 * Exits non-zero when at least one `error` finding is present.
 */

import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { readContentFile } from './markdown.js';
import { readConfig } from './repo-manifest.js';
import { listMarkdownFiles } from './fs-utils.js';

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

function parseClusterKeys(configRaw) {
  if (!configRaw) return new Set();
  const keys = new Set();
  const lines = configRaw.split(/\r?\n/);
  let inClusters = false;
  for (const line of lines) {
    if (/^clusters\s*:/.test(line)) {
      inClusters = true;
      continue;
    }
    if (inClusters) {
      // Exit when we hit a new top-level key
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) {
        inClusters = false;
        continue;
      }
      const m = line.match(/^ {2}([A-Za-z0-9_-]+)\s*:\s*$/);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

function detectParentCycle(nodes) {
  const cycles = [];
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let cursor = node.parent;
    const trail = [node.id];
    while (cursor) {
      trail.push(cursor);
      if (seen.has(cursor)) {
        cycles.push({ id: node.id, cycle: trail });
        break;
      }
      seen.add(cursor);
      const parent = nodes.find((n) => n.id === cursor);
      cursor = parent?.parent;
    }
  }
  return cycles;
}

/**
 * Run the audit over a content directory.
 *
 * @param {object} options
 * @param {string} options.contentDir - Absolute path to the content directory.
 * @param {string} [options.cwd]      - Project root (for reading config.yaml).
 * @param {string} [options.contentPath='content'] - Content path used to find config.
 * @returns {{ findings: Array, summary: object }}
 */
export function audit({ contentDir, cwd, contentPath = 'content' }) {
  const findings = [];
  const files = listMarkdownFiles(contentDir);

  const parsed = [];
  for (const file of files) {
    let result;
    try {
      result = readContentFile(file);
    } catch (err) {
      findings.push({
        severity: SEVERITY.ERROR,
        rule: 'read-error',
        file,
        message: `cannot read file: ${err.message}`,
      });
      continue;
    }

    if (!result.ok) {
      findings.push({
        severity: SEVERITY.ERROR,
        rule: 'malformed-frontmatter',
        file,
        message: result.error,
      });
      continue;
    }

    parsed.push({ file, frontmatter: result.frontmatter });
  }

  // ── Required fields ──────────────────────────────────────
  for (const { file, frontmatter } of parsed) {
    for (const field of ['id', 'title', 'cluster']) {
      if (!frontmatter[field]) {
        findings.push({
          severity: SEVERITY.ERROR,
          rule: 'missing-required-field',
          file,
          field,
          message: `frontmatter missing required field "${field}"`,
        });
      }
    }
  }

  // ── Filename / id slug mismatch ──────────────────────────
  for (const { file, frontmatter } of parsed) {
    if (!frontmatter.id) continue;
    const slug = basename(file, '.md');
    if (slug !== frontmatter.id) {
      findings.push({
        severity: SEVERITY.WARNING,
        rule: 'filename-id-mismatch',
        file,
        message: `filename slug "${slug}" does not match id "${frontmatter.id}"`,
      });
    }
  }

  // ── Duplicate ids ────────────────────────────────────────
  const byId = new Map();
  for (const node of parsed) {
    const id = node.frontmatter.id;
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(node.file);
  }
  for (const [id, paths] of byId) {
    if (paths.length > 1) {
      findings.push({
        severity: SEVERITY.ERROR,
        rule: 'duplicate-id',
        id,
        files: paths,
        message: `id "${id}" declared in ${paths.length} files`,
      });
    }
  }

  // ── Undeclared cluster ───────────────────────────────────
  let declaredClusters = new Set();
  let configFound = false;
  if (cwd) {
    const configRaw = readConfig(cwd, contentPath);
    if (configRaw !== null) {
      configFound = true;
      declaredClusters = parseClusterKeys(configRaw);
    }
  }
  const hasAnyCluster = parsed.some(({ frontmatter }) => frontmatter.cluster);
  if (cwd && !configFound && hasAnyCluster) {
    findings.push({
      severity: SEVERITY.ERROR,
      rule: 'missing-config',
      message: 'content files declare clusters but config.yaml is missing or unreadable',
    });
  } else if (configFound && declaredClusters.size === 0 && hasAnyCluster) {
    findings.push({
      severity: SEVERITY.ERROR,
      rule: 'missing-clusters',
      message: 'content files declare clusters but config.yaml has no `clusters:` block',
    });
  } else if (declaredClusters.size > 0) {
    for (const { file, frontmatter } of parsed) {
      const cluster = frontmatter.cluster;
      if (cluster && !declaredClusters.has(cluster)) {
        findings.push({
          severity: SEVERITY.ERROR,
          rule: 'undeclared-cluster',
          file,
          cluster,
          message: `cluster "${cluster}" not declared in config.yaml`,
        });
      }
    }
  }

  // ── Broken parent reference ──────────────────────────────
  const nodes = parsed
    .filter((p) => p.frontmatter.id)
    .map((p) => ({
      id: p.frontmatter.id,
      parent: p.frontmatter.parent || null,
      file: p.file,
      connections: p.frontmatter.connections || [],
    }));

  const idSet = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.parent && !idSet.has(node.parent)) {
      findings.push({
        severity: SEVERITY.ERROR,
        rule: 'broken-parent',
        file: node.file,
        id: node.id,
        parent: node.parent,
        message: `parent "${node.parent}" does not exist`,
      });
    }
  }

  // ── Parent cycles ────────────────────────────────────────
  for (const c of detectParentCycle(nodes)) {
    findings.push({
      severity: SEVERITY.ERROR,
      rule: 'parent-cycle',
      id: c.id,
      cycle: c.cycle,
      message: `parent chain forms a cycle: ${c.cycle.join(' → ')}`,
    });
  }

  // ── Dead connection target ───────────────────────────────
  for (const node of nodes) {
    for (const conn of node.connections) {
      const target = conn.to;
      if (!target) continue;
      // Built-in node types accepted as targets: issue-N, pr-N, dir-X, readme, repo-root
      const isBuiltin =
        /^issue-\d+$/.test(target) ||
        /^pr-\d+$/.test(target) ||
        /^dir-/.test(target) ||
        target === 'readme' ||
        target === 'repo-root';
      if (!idSet.has(target) && !isBuiltin) {
        findings.push({
          severity: SEVERITY.ERROR,
          rule: 'dead-connection',
          file: node.file,
          from: node.id,
          to: target,
          message: `connection to unknown node "${target}"`,
        });
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────
  const summary = {
    files: files.length,
    nodes: nodes.length,
    errors: findings.filter((f) => f.severity === SEVERITY.ERROR).length,
    warnings: findings.filter((f) => f.severity === SEVERITY.WARNING).length,
    byRule: findings.reduce((acc, f) => {
      acc[f.rule] = (acc[f.rule] || 0) + 1;
      return acc;
    }, {}),
  };

  return { findings, summary };
}

export const _internal = { parseClusterKeys, detectParentCycle, listMarkdownFiles };

