import { existsSync as fsExistsSync, readFileSync } from 'node:fs';
import { resolve, join, normalize, extname, sep } from 'node:path';

import { getAppRoot } from '../../lib/detect-repo.ts';
import { parseFrontmatter } from '../../lib/markdown.ts';

export const DEFAULT_HEARTBEAT_MS = 15000;
export const DEFAULT_SEARCH_LIMIT = 10;
export const CANVAS_ENTRY_FILE = 'canvas.html';
export const CANVAS_ENTRY_CANDIDATES = ['canvas.html', 'index.html'];
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const CHAT_INTENT_NODE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHAT_INTENT_PROMPTS = Object.freeze({
  pin: (nodeId) => `Pin "${nodeId}" as the canvas anchor.`,
  derives: (nodeId) => `What derives from "${nodeId}" in the knowledge graph?`,
  affected: (nodeId) => `What would be affected by changes to "${nodeId}"?`,
});

export function defaultResolveBuildDir({ existsSync = fsExistsSync, cwd = process.cwd(), entryFiles = CANVAS_ENTRY_CANDIDATES } = {}) {
  const hasEntry = (dir) => entryFiles.some((f) => existsSync(join(dir, f)));
  const override = process.env.KBX_CANVAS_BUILD_DIR;
  if (override && hasEntry(override)) return override;

  const appRoot = getAppRoot(cwd);
  if (appRoot) {
    const templateDist = resolve(appRoot, 'dist');
    if (hasEntry(templateDist)) return templateDist;
  }
  const hostDist = resolve(cwd, 'dist', 'kb');
  if (hasEntry(hostDist)) return hostDist;
  return null;
}

function fallbackIndexHtml() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>kbexplorer canvas</title></head>',
    '<body><div id="root" data-kbx-fallback="true"></div></body>',
    '</html>',
    '',
  ].join('\n');
}

function bootConfigScript(config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script>window.__KBX_CANVAS__=${json};</script>`;
}

export function injectBootConfig(html, config) {
  const script = bootConfigScript(config);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return script + html;
}

function bundledManifestCandidates(cwd) {
  const candidates = [];
  const appRoot = getAppRoot(cwd);
  if (appRoot) candidates.push(resolve(appRoot, 'src', 'generated', 'repo-manifest.json'));
  candidates.push(resolve(cwd, 'dist', 'kb', 'repo-manifest.json'));
  candidates.push(resolve(cwd, 'repo-manifest.json'));
  return candidates;
}

export async function defaultGetManifest({ cwd = process.cwd(), existsSync = fsExistsSync, readFile = readFileSync, generate, warn = console.warn } = {}) {
  try {
    const gen = generate || (async () => {
      const { generateManifest } = await import('../../lib/repo-manifest.ts');
      return generateManifest(cwd);
    });
    return await gen();
  } catch (err) {
    for (const candidate of bundledManifestCandidates(cwd)) {
      if (existsSync(candidate)) {
        try {
          const bundled = JSON.parse(String(readFile(candidate)));
          warn(`⚠⚠ [kbx canvas] DEGRADED: live manifest generation failed (${err?.message || err}). Serving a bundled manifest from ${candidate}, which may be stale relative to the current repo. Fix the underlying generation error to leave degraded mode.`);
          return { ...bundled, degraded: true };
        } catch {
          // try next candidate
        }
      }
    }
    throw err;
  }
}

export function sliceManifest(manifest, ids) {
  const idSet = new Set(ids);
  const authored = manifest?.authoredContent || {};
  const authoredContent = {};
  for (const [path, raw] of Object.entries(authored)) {
    const parsed = parseFrontmatter(String(raw));
    const id = parsed.ok ? parsed.frontmatter?.id : undefined;
    if (id != null && idSet.has(id)) authoredContent[path] = raw;
  }
  return { ...manifest, authoredContent, slice: { ids } };
}

export function toSemanticResult(r = {}) {
  const out = {
    nodeId: r.nodeId ?? r.id ?? r.slug ?? '',
    title: r.title ?? '',
    cluster: r.cluster ?? r.clusterId ?? '',
    score: typeof r.score === 'number' ? r.score : 0,
    snippet: r.snippet ?? '',
    chunkIndex: typeof r.chunkIndex === 'number' ? r.chunkIndex : 0,
    connections: Array.isArray(r.connections) ? r.connections : [],
  };
  if (r.path != null) out.path = r.path;
  if (r.parentId != null) out.parentId = r.parentId;
  if (r.entityType != null) out.entityType = r.entityType;
  return out;
}

export function textIndexSearch(manifest, query, limit = DEFAULT_SEARCH_LIMIT, filters = {}) {
  const { cluster, entityType } = filters;
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (terms.length === 0) return [];
  const authored = manifest?.authoredContent || {};
  const scored = [];
  for (const [path, raw] of Object.entries(authored)) {
    const parsed = parseFrontmatter(String(raw));
    const fm = parsed.ok ? parsed.frontmatter || {} : {};
    const body = (parsed.ok ? parsed.body : String(raw)) || '';
    const rowCluster = fm.cluster ?? '';
    const rowEntityType = fm.entityType ?? fm.type ?? undefined;
    if (cluster && rowCluster !== cluster) continue;
    if (entityType && rowEntityType !== entityType) continue;
    const title = fm.title || path;
    const hayTitle = String(title).toLowerCase();
    const hayBody = body.toLowerCase();
    let hits = 0;
    for (const t of terms) {
      hits += hayTitle.includes(t) ? 3 : 0;
      const bodyMatches = hayBody.split(t).length - 1;
      hits += bodyMatches;
    }
    if (hits <= 0) continue;
    const snippetSource = body.replace(/\s+/g, ' ').trim();
    scored.push({
      nodeId: fm.id ?? path,
      title,
      cluster: rowCluster,
      _hits: hits,
      snippet: snippetSource.slice(0, 200),
      chunkIndex: 0,
      path,
      parentId: fm.parent ?? undefined,
      entityType: rowEntityType,
      connections: Array.isArray(fm.connections) ? fm.connections.map((c) => (typeof c === 'string' ? c : c?.to)).filter(Boolean) : [],
    });
  }
  scored.sort((a, b) => b._hits - a._hits);
  const top = scored.slice(0, limit);
  const max = top.length ? top[0]._hits : 1;
  return top.map(({ _hits, ...r }) => toSemanticResult({ ...r, score: max ? _hits / max : 0 }));
}

export async function defaultRunSearch({ query, limit = DEFAULT_SEARCH_LIMIT, graphRanking, cluster, entityType } = {}, { cwd = process.cwd(), getManifest, loadSearchModule, warn = console.warn } = {}) {
  void graphRanking;
  let driftReason = null;
  try {
    const mod = loadSearchModule ? await loadSearchModule() : await import('@anokye-labs/kbexplorer-search');
    const { readArtifacts, createSearchEngine, getProvider } = mod;
    const artifactDir = resolve(cwd, '.search');
    const artifact = readArtifacts(artifactDir);
    if (!artifact) {
      driftReason = 'search artifacts absent (.search/); using client text-index fallback';
    } else {
      const provider = getProvider('openai', { model: artifact.meta?.model, dimensions: artifact.meta?.dimensions });
      const engine = createSearchEngine(artifact, provider);
      const results = await engine.search(query, { limit, cluster, entityType });
      return { results: results.map(toSemanticResult), suggestions: [] };
    }
  } catch (err) {
    driftReason = `search engine unavailable (${err?.message || err}); using client text-index fallback`;
  }

  if (driftReason) {
    warn(`⚠⚠ [kbx canvas] DEGRADED search: ${driftReason}. Results come from a basic client-side text index over the manifest, not the configured search engine — rebuild .search/ (kbx search-index) to leave degraded mode.`);
  }
  const manifest = await getManifest();
  const results = textIndexSearch(manifest, query, limit, { cluster, entityType });
  return { results, suggestions: [], degraded: true, drift: { stale: true, reason: driftReason || 'text-index fallback' } };
}

export function buildChatIntentPrompt({ intent, nodeId, prompt }) {
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();
  const template = CHAT_INTENT_PROMPTS[intent];
  return template ? template(nodeId) : null;
}

export function readBody(req) {
  if (req && req.body != null) {
    return Promise.resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  return new Promise((res, rej) => {
    if (!req || typeof req.on !== 'function') {
      res('');
      return;
    }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => res(data));
    req.on('error', rej);
  });
}

export { CHAT_INTENT_NODE_ID_RE, CHAT_INTENT_PROMPTS };
export { fallbackIndexHtml, bootConfigScript };
export { bundledManifestCandidates };
