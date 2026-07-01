/**
 * Loopback canvas server (A1, #190) — the CLI half of the frozen A/B seam.
 *
 * Replaces the old `canvas.js` stub with a real, per-instance loopback HTTP
 * server. Each canvas `instanceId` gets **one** `http.Server` bound to
 * `127.0.0.1:0`; the resulting `http://127.0.0.1:<port>` is the canvas `url`.
 * Servers are memoized per `instanceId` (re-opening rehydrates the same origin)
 * and torn down on close.
 *
 * Scope (A1): server lifecycle, `GET /` (serve whatever SPA build is available +
 * inject the `window.__KBX_CANVAS__` boot config), static assets, and teardown.
 * Data endpoints `GET /manifest` + `GET /manifest/slice` (A2, #191) and
 * `POST /search` (A3, #192) are implemented here behind injected seams
 * (`getManifest`, `runSearch`); the SSE / action endpoints (`/events`,
 * `/affordance/:name`) remain later issues (A4–A5) stubbed as `404 { error: 'not yet' }`.
 *
 * All I/O is behind injected seams (`createServer`, `existsSync`, `readFile`,
 * `resolveBuildDir`) so the registry is hermetically testable with a fake server
 * and no real ports. See {@link module:src/extension/canvas} for the wiring.
 *
 * @module src/extension/canvas-server
 */

import { createServer as nodeCreateServer } from 'node:http';
import { existsSync as fsExistsSync, readFileSync } from 'node:fs';
import { resolve, join, normalize, extname, sep } from 'node:path';
import { getAppRoot } from '../lib/detect-repo.js';
import { parseFrontmatter } from '../lib/frontmatter.js';

/**
 * Endpoints owned by later issues (A4/A5); stubbed as `404 not yet` until they
 * land. `/manifest` (A2) and `/search` (A3) are implemented in this module and
 * are therefore no longer listed here.
 */
const NOT_YET_ENDPOINTS = ['/events', '/affordance'];

/** How many search results the SPA (useSemanticSearch) asks for by default. */
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * The embeddable canvas entry the template's build (#406) emits, and the point
 * where A1 and template#406 meet: the CLI serves `canvas.html`, the template
 * produces `canvas.html`.
 */
export const CANVAS_ENTRY_FILE = 'canvas.html';

/**
 * Ordered entry-file preference served at `GET /`:
 *   1. `canvas.html` — the embeddable canvas entry (template#406). Once it lands
 *      in the build, A1 auto-serves it with no further change.
 *   2. `index.html` — best-effort fallback before #406 lands (the full-page App;
 *      not ideal, but better than the empty placeholder if a build exists).
 * If neither is present, the minimal built-in fallback page is served.
 */
export const CANVAS_ENTRY_CANDIDATES = ['canvas.html', 'index.html'];

const MIME = {
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

/**
 * Resolve the directory that holds the embeddable canvas build to serve. Order:
 *   1. `KBX_CANVAS_BUILD_DIR` (explicit override / the embeddable build once
 *      template#406 lands).
 *   2. `<appRoot>/dist` — the template build (`kbx build` in the template repo).
 *   3. `<cwd>/dist/kb` — the host build (`kbx build` in a host repo).
 * A directory only qualifies if it contains at least one entry candidate
 * ({@link CANVAS_ENTRY_CANDIDATES} — `canvas.html` preferred, else `index.html`).
 * Returns `null` when no build with a servable entry exists yet; the server then
 * serves a minimal fallback page so `open()` still yields a working url + config.
 *
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsSync]
 * @param {string} [deps.cwd]
 * @param {string[]} [deps.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {string|null}
 */
export function defaultResolveBuildDir({
  existsSync = fsExistsSync,
  cwd = process.cwd(),
  entryFiles = CANVAS_ENTRY_CANDIDATES,
} = {}) {
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

/** Minimal HTML served when no SPA build is present yet (pre-template#406). */
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

/**
 * Serialize the boot config safely for inline `<script>` injection. Escapes `<`
 * so a `</script>` inside any value cannot break out of the tag.
 *
 * @param {object} config
 * @returns {string}
 */
function bootConfigScript(config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script>window.__KBX_CANVAS__=${json};</script>`;
}

/**
 * Inject the boot-config script into an HTML document, before `</head>` when
 * present, else before `</body>`, else prepended.
 *
 * @param {string} html
 * @param {object} config
 * @returns {string}
 */
export function injectBootConfig(html, config) {
  const script = bootConfigScript(config);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return script + html;
}

/**
 * Whether a request path belongs to a not-yet-implemented endpoint (A2–A5).
 * @param {string} pathname
 * @returns {boolean}
 */
function isNotYet(pathname) {
  return NOT_YET_ENDPOINTS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}

// ---------------------------------------------------------------------------
// A2/A3 data path — manifest + search, behind injectable seams.
// ---------------------------------------------------------------------------

/**
 * Candidate paths for a bundled/prebuilt `repo-manifest.json`, used only as a
 * fallback when live generation fails.
 * @param {string} cwd
 * @returns {string[]}
 */
function bundledManifestCandidates(cwd) {
  const candidates = [];
  const appRoot = getAppRoot(cwd);
  if (appRoot) candidates.push(resolve(appRoot, 'src', 'generated', 'repo-manifest.json'));
  candidates.push(resolve(cwd, 'dist', 'kb', 'repo-manifest.json'));
  candidates.push(resolve(cwd, 'repo-manifest.json'));
  return candidates;
}

/**
 * Default manifest seam: live-generate the host manifest, falling back to a
 * bundled `repo-manifest.json` only when generation throws. Live generation is
 * what makes SSE refresh (A4) rebuild-free.
 *
 * @param {object} [deps]
 * @param {string} [deps.cwd]
 * @param {(p: string) => boolean} [deps.existsSync]
 * @param {(p: string) => Buffer|string} [deps.readFile]
 * @param {() => Promise<object>} [deps.generate]  Injected generator (tests).
 * @returns {Promise<object>}
 */
export async function defaultGetManifest({
  cwd = process.cwd(),
  existsSync = fsExistsSync,
  readFile = readFileSync,
  generate,
} = {}) {
  try {
    const gen = generate || (async () => {
      const { generateManifest } = await import('../lib/manifest.js');
      return generateManifest(cwd);
    });
    return await gen();
  } catch (err) {
    for (const candidate of bundledManifestCandidates(cwd)) {
      if (existsSync(candidate)) {
        try {
          return JSON.parse(String(readFile(candidate)));
        } catch {
          /* try next candidate */
        }
      }
    }
    throw err;
  }
}

/**
 * Produce a manifest-shaped slice: the same manifest with `authoredContent`
 * filtered to pages whose frontmatter `id` is in `ids`, plus a `{ slice: { ids } }`
 * marker. Directly consumable by the SPA's existing manifest loader/merge path.
 *
 * @param {object} manifest
 * @param {string[]} ids
 * @returns {object}
 */
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

/**
 * Map a kbexplorer-search engine result to the SPA's `SemanticResult` shape
 * (`useSemanticSearch.ts`): exact field names/casing — `nodeId`, `cluster`,
 * numeric `score` (0..1), `chunkIndex`, `connections: string[]`.
 *
 * @param {object} r
 * @returns {object}
 */
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

/**
 * Deterministic, dependency-free text index over the manifest's authored
 * content — the fallback when `.search/*` artifacts are absent/unusable.
 * Scores by query-term frequency across title + body; normalizes to 0..1.
 *
 * @param {object} manifest
 * @param {string} query
 * @param {number} limit
 * @returns {object[]}  SemanticResult-shaped rows.
 */
export function textIndexSearch(manifest, query, limit = DEFAULT_SEARCH_LIMIT) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  if (terms.length === 0) return [];
  const authored = manifest?.authoredContent || {};
  const scored = [];
  for (const [path, raw] of Object.entries(authored)) {
    const parsed = parseFrontmatter(String(raw));
    const fm = parsed.ok ? parsed.frontmatter || {} : {};
    const body = (parsed.ok ? parsed.body : String(raw)) || '';
    const title = fm.title || path;
    const hayTitle = String(title).toLowerCase();
    const hayBody = body.toLowerCase();
    let hits = 0;
    for (const t of terms) {
      // Title matches weigh more than body matches.
      hits += hayTitle.includes(t) ? 3 : 0;
      const bodyMatches = hayBody.split(t).length - 1;
      hits += bodyMatches;
    }
    if (hits <= 0) continue;
    const snippetSource = body.replace(/\s+/g, ' ').trim();
    scored.push({
      nodeId: fm.id ?? path,
      title,
      cluster: fm.cluster ?? '',
      _hits: hits,
      snippet: snippetSource.slice(0, 200),
      chunkIndex: 0,
      path,
      parentId: fm.parent ?? undefined,
      entityType: fm.entityType ?? fm.type ?? undefined,
      connections: Array.isArray(fm.connections)
        ? fm.connections.map((c) => (typeof c === 'string' ? c : c?.to)).filter(Boolean)
        : [],
    });
  }
  scored.sort((a, b) => b._hits - a._hits);
  const top = scored.slice(0, limit);
  const max = top.length ? top[0]._hits : 1;
  return top.map(({ _hits, ...r }) => toSemanticResult({ ...r, score: max ? _hits / max : 0 }));
}

/**
 * Default search seam. Prefers the `@anokye-labs/kbexplorer-search` engine over
 * checked-in `.search/*` artifacts (same path `kbx_search` uses); on any failure
 * (module missing, artifacts absent, embedding/network error) falls back to the
 * client text index over the live manifest and attaches a `drift` warning.
 *
 * @param {{ query: string, limit?: number, graphRanking?: boolean }} params
 * @param {object} deps
 * @param {string} deps.cwd
 * @param {() => Promise<object>} deps.getManifest
 * @param {() => Promise<object>} [deps.loadSearchModule]  Injected engine (tests).
 * @param {(msg: string) => void} [deps.warn]
 * @returns {Promise<{ results: object[], suggestions: object[], drift?: object }>}
 */
export async function defaultRunSearch(
  { query, limit = DEFAULT_SEARCH_LIMIT, graphRanking } = {},
  { cwd = process.cwd(), getManifest, loadSearchModule, warn = console.warn } = {},
) {
  void graphRanking; // honored implicitly by the engine's ranking; SPA only needs results.
  let driftReason = null;
  try {
    const mod = loadSearchModule
      ? await loadSearchModule()
      : await import('@anokye-labs/kbexplorer-search');
    const { readArtifacts, createSearchEngine, getProvider } = mod;
    const artifactDir = resolve(cwd, '.search');
    const artifact = readArtifacts(artifactDir);
    if (!artifact) {
      driftReason = 'search artifacts absent (.search/); using client text-index fallback';
    } else {
      const provider = getProvider('openai', {
        model: artifact.meta?.model,
        dimensions: artifact.meta?.dimensions,
      });
      const engine = createSearchEngine(artifact, provider);
      const results = await engine.search(query, { limit });
      return { results: results.map(toSemanticResult), suggestions: [] };
    }
  } catch (err) {
    driftReason = `search engine unavailable (${err?.message || err}); using client text-index fallback`;
  }

  if (driftReason) warn(`⚠ ${driftReason}`);
  const manifest = await getManifest();
  const results = textIndexSearch(manifest, query, limit);
  return {
    results,
    suggestions: [],
    drift: { stale: true, reason: driftReason || 'text-index fallback' },
  };
}

/**
 * Read a request body as a string. Tolerates an injected `req.body` (tests) and
 * a real streaming `IncomingMessage`.
 * @param {object} req
 * @returns {Promise<string>}
 */
function readBody(req) {
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

/**
 * Build the request handler for one canvas instance. Closes over the origin's
 * build dir + boot config so `GET /` can inject an origin-correct config.
 *
 * @param {object} opts
 * @param {string|null} opts.buildDir
 * @param {() => object} opts.bootConfig  Lazily produced so `<origin>` (which
 *        needs the bound port) is only read after `listen`.
 * @param {(p: string) => boolean} opts.existsSync
 * @param {(p: string) => Buffer|string} opts.readFile
 * @param {() => Promise<object>} [opts.getManifest]  A2 manifest seam.
 * @param {(params: object) => Promise<object>} [opts.runSearch]  A3 search seam.
 * @param {string[]} [opts.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {(req, res) => void}
 */
export function createRequestHandler({
  buildDir,
  bootConfig,
  existsSync,
  readFile,
  getManifest,
  runSearch,
  entryFiles = CANVAS_ENTRY_CANDIDATES,
}) {
  const serveIndex = (res) => {
    let html;
    const entry = buildDir
      ? entryFiles.map((f) => join(buildDir, f)).find((p) => existsSync(p))
      : null;
    if (entry) {
      html = String(readFile(entry));
    } else {
      html = fallbackIndexHtml();
    }
    const body = injectBootConfig(html, bootConfig());
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(body);
  };

  const serveAsset = (res, pathname) => {
    // Normalize + confine to buildDir (no path traversal).
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const abs = resolve(buildDir, rel);
    const root = resolve(buildDir);
    const within = abs === root || abs.startsWith(root + sep);
    if (!within || !existsSync(abs)) {
      res.writeHead(404, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify({ error: 'not found', endpoint: pathname }));
      return;
    }
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(readFile(abs));
  };

  const sendJson = (res, status, obj) => {
    res.writeHead(status, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify(obj));
  };

  const serveManifest = async (res) => {
    try {
      const manifest = await getManifest();
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(manifest));
    } catch (err) {
      sendJson(res, 500, { error: 'manifest generation failed', message: String(err?.message || err) });
    }
  };

  const serveManifestSlice = async (res, rawQuery) => {
    const params = new URLSearchParams(rawQuery || '');
    const ids = (params.get('ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      sendJson(res, 400, { error: 'ids required', endpoint: '/manifest/slice' });
      return;
    }
    try {
      const manifest = await getManifest();
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(sliceManifest(manifest, ids)));
    } catch (err) {
      sendJson(res, 500, { error: 'manifest generation failed', message: String(err?.message || err) });
    }
  };

  const serveSearch = async (req, res, method) => {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', endpoint: '/search' });
      return;
    }
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body', endpoint: '/search' });
      return;
    }
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query) {
      sendJson(res, 400, { error: 'query required', endpoint: '/search' });
      return;
    }
    const limit = Number.isFinite(payload.limit) ? payload.limit : DEFAULT_SEARCH_LIMIT;
    try {
      const out = await runSearch({ query, limit, graphRanking: payload.graphRanking });
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(out));
    } catch (err) {
      sendJson(res, 500, { error: 'search failed', message: String(err?.message || err) });
    }
  };

  return (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const [pathname, rawQuery = ''] = (req.url || '/').split('?');

    if (pathname === '/' || pathname === '/index.html') {
      serveIndex(res);
      return;
    }
    if (pathname === '/manifest') {
      void serveManifest(res);
      return;
    }
    if (pathname === '/manifest/slice') {
      void serveManifestSlice(res, rawQuery);
      return;
    }
    if (pathname === '/search') {
      void serveSearch(req, res, method);
      return;
    }
    if (isNotYet(pathname)) {
      res.writeHead(404, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify({ error: 'not yet', endpoint: pathname }));
      return;
    }
    if (buildDir) {
      serveAsset(res, pathname);
      return;
    }
    res.writeHead(404, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'not found', endpoint: pathname }));
  };
}

/**
 * Create a canvas-server registry: memoizes one loopback server per
 * `instanceId`, exposes `open` / `close` / `get`.
 *
 * @param {object} [deps]
 * @param {typeof nodeCreateServer} [deps.createServer]  http.createServer seam.
 * @param {() => (string|null)} [deps.resolveBuildDir]   SPA-build-dir resolver.
 * @param {(p: string) => boolean} [deps.existsSync]
 * @param {(p: string) => Buffer|string} [deps.readFile]
 * @param {string} [deps.title]  Canvas title returned from `open`.
 * @param {string} [deps.cwd]  Host repo root (default `process.cwd()`).
 * @param {() => Promise<object>} [deps.getManifest]  A2 manifest seam (hermetic tests).
 * @param {(params: object, ctx: object) => Promise<object>} [deps.runSearch]  A3 search seam.
 * @param {() => Promise<object>} [deps.loadSearchModule]  Search-engine module seam.
 * @param {string[]} [deps.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {{ open: Function, close: Function, get: Function, size: () => number }}
 */
export function createCanvasRegistry({
  createServer = nodeCreateServer,
  resolveBuildDir = () => defaultResolveBuildDir({ entryFiles }),
  existsSync = fsExistsSync,
  readFile = readFileSync,
  title = 'kbexplorer Knowledge Graph',
  cwd = process.cwd(),
  getManifest,
  runSearch,
  loadSearchModule,
  entryFiles = CANVAS_ENTRY_CANDIDATES,
} = {}) {
  /** @type {Map<string, { url: string, title: string, server: object }>} */
  const instances = new Map();

  // Default data-path seams: live manifest generation + engine-backed search,
  // both overridable for hermetic tests.
  const getManifestSeam = getManifest || (() => defaultGetManifest({ cwd, existsSync, readFile }));
  const runSearchSeam =
    runSearch ||
    ((params) => defaultRunSearch(params, { cwd, getManifest: getManifestSeam, loadSearchModule }));

  /**
   * Start (or rehydrate) the loopback server for `instanceId`.
   * @param {string} instanceId
   * @param {object} [options]
   * @param {string} [options.anchorNodeId]
   * @returns {Promise<{ url: string, title: string }>}
   */
  async function open(instanceId, options = {}) {
    if (!instanceId || typeof instanceId !== 'string') {
      throw new TypeError('canvas registry.open: "instanceId" must be a non-empty string');
    }
    const existing = instances.get(instanceId);
    if (existing) return { url: existing.url, title: existing.title };

    const buildDir = resolveBuildDir();
    // Placeholder captured after listen resolves the real port.
    let origin = '';
    const bootConfig = () => ({
      local: true,
      visualMode: 'inherit-host',
      searchServiceUrl: `${origin}/search`,
      ...(options.anchorNodeId ? { anchorNodeId: options.anchorNodeId } : {}),
    });

    const handler = createRequestHandler({
      buildDir,
      bootConfig,
      existsSync,
      readFile,
      getManifest: getManifestSeam,
      runSearch: runSearchSeam,
      entryFiles,
    });
    const server = createServer(handler);

    const port = await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        res(typeof addr === 'object' && addr ? addr.port : addr);
      });
    });

    origin = `http://127.0.0.1:${port}`;
    const record = { url: origin, title, server };
    instances.set(instanceId, record);
    return { url: origin, title };
  }

  /**
   * Tear down the server for `instanceId`. Unknown ids are a no-op.
   * @param {string} instanceId
   * @returns {Promise<void>}
   */
  async function close(instanceId) {
    const record = instances.get(instanceId);
    if (!record) return;
    instances.delete(instanceId);
    await new Promise((res) => {
      if (typeof record.server.close === 'function') record.server.close(() => res());
      else res();
    });
  }

  return {
    open,
    close,
    get: (instanceId) => instances.get(instanceId),
    size: () => instances.size,
  };
}
