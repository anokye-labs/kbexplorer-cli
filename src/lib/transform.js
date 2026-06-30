/**
 * Transform a kb-architect JSON catalogue into kbx content files.
 *
 * Input:  JSON catalogue (from kb-architect agent or stdin)
 * Output: content/config.yaml + content/{slug}.md skeleton files
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { readSourceRecord } from './source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Allowed presentation values, shared with the init wizard (#150). */
export const VISUAL_MODES = ['emoji', 'sprites', 'heroes', 'none'];
export const THEMES = ['dark', 'light', 'sepia'];

// ── Emoji Defaults ─────────────────────────────────────────

export const TOPIC_ICON_MAP = {
  architecture: 'Building',
  overview: 'Building',
  system: 'Organization',
  data: 'Database',
  database: 'Database',
  state: 'Storage',
  storage: 'Storage',
  api: 'PlugConnected',
  network: 'Globe',
  http: 'PlugConnected',
  server: 'Server',
  ui: 'Window',
  component: 'PuzzlePiece',
  view: 'Window',
  frontend: 'Desktop',
  auth: 'LockClosed',
  security: 'Shield',
  config: 'Settings',
  build: 'Engine',
  deploy: 'Rocket',
  infra: 'Settings',
  test: 'Beaker',
  testing: 'Beaker',
  engine: 'Flash',
  core: 'Flash',
  logic: 'Flash',
  docs: 'Book',
  guide: 'Book',
  documentation: 'Book',
  wiki: 'Notebook',
  cli: 'Code',
  tool: 'Wrench',
  script: 'Script',
  graph: 'Flow',
  visual: 'PaintBrush',
  theme: 'Color',
  style: 'PaintBrush',
  cache: 'Storage',
  performance: 'Flash',
  navigation: 'Navigation',
  keyboard: 'Keyboard',
  layout: 'Grid',
  loader: 'Database',
  manifest: 'Clipboard',
  type: 'Code',
  error: 'Alert',
  loading: 'Clock',
  history: 'History',
  branch: 'Branch',
  merge: 'Merge',
  issue: 'Flag',
  task: 'Clipboard',
  bug: 'Bug',
  feature: 'Sparkle',
  epic: 'Flag',
  enhancement: 'Lightbulb',
  home: 'Home',
  search: 'Search',
  filter: 'Filter',
  hub: 'Organization',
  design: 'PaintBrush',
  diagram: 'Diagram',
  layer: 'Layer',
  stack: 'Stack',
  link: 'Link',
  image: 'Image',
  map: 'Map',
  target: 'Target',
  star: 'Star',
  people: 'People',
  comment: 'Comment',
  tag: 'Tag',
  table: 'Table',
  chart: 'ChartMultiple',
};

export function inferIcon(title, cluster) {
  const lower = `${title} ${cluster}`.toLowerCase();
  for (const [keyword, icon] of Object.entries(TOPIC_ICON_MAP)) {
    if (lower.includes(keyword)) return icon;
  }
  return 'Document';
}

// ── Colour Palette ─────────────────────────────────────────

const CLUSTER_COLORS = [
  '#4A9CC8', '#8CB050', '#E8A838', '#C07840',
  '#D4A050', '#5A98A8', '#9A8A78', '#C04040',
  '#A86FDF', '#39FF14', '#FF6B6B', '#4ECDC4',
];

// ── Import existing content ────────────────────────────────

/**
 * Find an existing content file by node ID and extract its body (everything after frontmatter).
 * Searches the outputDir (content/) and outputDir/wiki/ sub-directories.
 *
 * @param {string} nodeId - Node ID / file stem
 * @param {string} outputDir - Absolute path to the content output directory
 */
function findExistingBody(nodeId, outputDir) {
  const searchPaths = [
    resolve(outputDir, `${nodeId}.md`),
    resolve(outputDir, 'wiki', `${nodeId}.md`),
    // Also check with wiki- prefix stripped (wiki-overview → content/wiki/overview.md)
    ...(nodeId.startsWith('wiki-')
      ? [resolve(outputDir, 'wiki', `${nodeId.replace(/^wiki-/, '')}.md`)]
      : []),
  ];

  for (const p of searchPaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        // Strip existing frontmatter — we'll apply new frontmatter from the catalogue
        const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
        if (match) return match[1];
        return raw; // no frontmatter, use entire content
      } catch { /* continue */ }
    }
  }
  return null;
}

// ── Cluster guard (fix #41) ────────────────────────────────

/**
 * Scan the output directory for existing .md files and collect every cluster
 * ID they reference in their frontmatter.
 *
 * This is used to detect clusters that are already in use by existing content
 * so we can carry them forward when the new catalogue introduces different
 * cluster IDs (i.e. prevent `generate --refresh` from orphaning existing nodes).
 *
 * @param {string} outputDir - Absolute path to the content output directory
 * @returns {Map<string, {nodeId: string, filePath: string}>} clusterId → sample usage
 */
export function collectExistingClusters(outputDir) {
  const used = new Map(); // clusterId → { nodeId, filePath }
  if (!existsSync(outputDir)) return used;

  let entries;
  try {
    entries = readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return used;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = resolve(outputDir, entry.name);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      // Extract frontmatter cluster field
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      const clusterLine = fm[1].split(/\r?\n/).find((l) => /^cluster\s*:/.test(l));
      if (!clusterLine) continue;
      const clusterId = clusterLine.replace(/^cluster\s*:\s*/, '').replace(/["']/g, '').trim();
      if (clusterId && !used.has(clusterId)) {
        used.set(clusterId, { nodeId: entry.name.replace(/\.md$/, ''), filePath });
      }
    } catch { /* skip unreadable files */ }
  }

  return used;
}

// ── Transform ──────────────────────────────────────────────

/**
 * Transform a kb-architect JSON catalogue into kbx content files.
 *
 * Fixes applied:
 *   #40 — connections accepts both string IDs and {to, description} objects
 *   #41 — existing content clusters are preserved when the new catalogue uses
 *          different cluster IDs (orphaned clusters become "legacy" rather than
 *          being silently dropped)
 *   findExistingBody — uses outputDir, not the CLI source root
 *
 * @param {object} catalogue
 * @param {string} [outputDir]
 * @param {object} [opts]
 * @param {boolean} [opts.preserveOrphanedClusters=true]  Add a "legacy" bucket
 *   carrying any existing cluster IDs that are no longer in the new catalogue.
 *   Set to false to disable (only do so with --force-clusters intent).
 * @returns {{ configPath, filesWritten, filesImported, totalNodes, orphanedClusters }}
 */
export function transformCatalogue(catalogue, outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content'), opts = {}) {
  const { preserveOrphanedClusters = true } = opts;
  const { clusters = {}, nodes = [] } = catalogue;

  // Resolve the presentation (visual mode + theme) the user chose at init time.
  // Priority: explicit opts.presentation → the persisted .kbx.json record at the
  // host root (parent of content/) → app defaults. Threading it here is what
  // makes the wizard's choice survive a regenerate/build (#150).
  const persisted = opts.presentation
    ?? readSourceRecord(resolve(outputDir, '..'))?.presentation
    ?? {};
  const visualMode = VISUAL_MODES.includes(persisted.visual) ? persisted.visual : 'emoji';
  const themeDefault = THEMES.includes(persisted.theme) ? persisted.theme : 'dark';

  // ── Merge orphaned clusters (fix #41) ────────────────────────────────────
  // Collect cluster IDs already in use by existing .md files in the output dir.
  // Any that the new catalogue doesn't declare are carried forward so no
  // existing file ends up with an undeclared cluster.
  const existingClusters = collectExistingClusters(outputDir);
  const orphanedClusters = [];

  if (preserveOrphanedClusters) {
    for (const [id] of existingClusters) {
      if (!clusters[id]) {
        orphanedClusters.push(id);
        // Carry the cluster forward as a "legacy" entry so audit doesn't fail.
        clusters[id] = {
          name: id.charAt(0).toUpperCase() + id.slice(1) + ' (legacy)',
        };
      }
    }
    if (orphanedClusters.length > 0) {
      console.warn(
        `⚠ ${orphanedClusters.length} existing cluster(s) not in new catalogue — preserved as legacy: ${orphanedClusters.join(', ')}`,
      );
    }
  }

  // Assign colors to clusters if not present
  let colorIdx = 0;
  for (const [, cluster] of Object.entries(clusters)) {
    if (!cluster.color) {
      cluster.color = CLUSTER_COLORS[colorIdx % CLUSTER_COLORS.length];
      colorIdx++;
    }
  }

  // Generate config.yaml — content + presentation (visual mode + theme).
  // Visual/theme come from the user's init choice (persisted in .kbx.json) so
  // the wizard answer sticks across regenerate/build (#150).
  const clusterYaml = Object.entries(clusters)
    .map(([id, c]) => `  ${id}:\n    name: "${c.name}"\n    color: "${c.color}"`)
    .join('\n');

  const configYaml = `title: "${catalogue.title || 'Knowledge Base'}"
subtitle: "${catalogue.subtitle || 'Generated by kbx'}"

clusters:
${clusterYaml}

visuals:
  mode: ${visualMode}
  fallback: emoji

theme:
  default: ${themeDefault}
`;

  mkdirSync(outputDir, { recursive: true });
  const configPath = resolve(outputDir, 'config.yaml');
  writeFileSync(configPath, configYaml, 'utf-8');
  console.log(`✓ Written ${configPath}`);

  // Generate content .md files — flat in output dir, graph structure from frontmatter
  let filesWritten = 0;
  let filesImported = 0;
  for (const node of nodes) {
    const emoji = node.emoji || inferIcon(node.title, node.cluster);
    // Fix #40: accept both string IDs and {to, description} connection objects
    const connections = (node.connections || [])
      .map((c) => {
        const to = typeof c === 'string' ? c : c?.to;
        const description = typeof c === 'string' ? '' : c?.description ?? '';
        if (!to) return null;
        return `  - to: "${to}"\n    description: "${description}"`;
      })
      .filter(Boolean)
      .join('\n');

    const frontmatter = [
      '---',
      `id: "${node.id}"`,
      `title: "${node.title}"`,
      `emoji: "${emoji}"`,
      `cluster: ${node.cluster}`,
    ];
    if (node.parent) {
      frontmatter.push(`parent: "${node.parent}"`);
    }
    if (connections) {
      frontmatter.push(`connections:\n${connections}`);
    } else {
      frontmatter.push('connections: []');
    }
    frontmatter.push('---');

    // For existing nodes: import content body from the existing file, apply new frontmatter.
    // Fix: use outputDir (the content directory) — not the CLI source root.
    let body;
    if (node.existing) {
      const existingBody = findExistingBody(node.id, outputDir);
      if (existingBody) {
        body = '\n' + existingBody;
        filesImported++;
      } else {
        body = node.prompt
          ? `\n# ${node.title}\n\n<!-- kb-writer prompt: ${node.prompt} -->\n\n_Content to be generated by kb-writer agent._\n`
          : `\n# ${node.title}\n\n_Content to be generated by kb-writer agent._\n`;
      }
    } else {
      body = node.prompt
        ? `\n# ${node.title}\n\n<!-- kb-writer prompt: ${node.prompt} -->\n\n_Content to be generated by kb-writer agent._\n`
        : `\n# ${node.title}\n\n_Content to be generated by kb-writer agent._\n`;
    }

    const filePath = resolve(outputDir, `${node.id}.md`);

    // For existing nodes: always write (to apply enriched frontmatter/connections)
    // For new nodes: skip if file already exists (don't overwrite manual edits)
    if (node.existing || !existsSync(filePath)) {
      writeFileSync(filePath, frontmatter.join('\n') + '\n' + body, 'utf-8');
      filesWritten++;
    } else {
      console.log(`  ⏭ ${node.id}.md already exists — skipping`);
    }
  }

  console.log(`✓ Generated ${filesWritten} files (${filesImported} imported from existing content) in ${outputDir}`);
  return { configPath, filesWritten, filesImported, totalNodes: nodes.length, orphanedClusters };
}

