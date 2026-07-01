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
 * The data / SSE / action endpoints (`/manifest`, `/search`, `/events`,
 * `/affordance/:name`) are later issues (A2–A5) and are stubbed here as a stable
 * `404 { error: 'not yet' }`.
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

/** Endpoints owned by later issues; stubbed as `404 not yet` until they land. */
const NOT_YET_ENDPOINTS = ['/manifest', '/search', '/events', '/affordance'];

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
 * @param {string[]} [opts.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {(req, res) => void}
 */
export function createRequestHandler({
  buildDir,
  bootConfig,
  existsSync,
  readFile,
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

  return (req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/' || pathname === '/index.html') {
      serveIndex(res);
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
 * @param {string[]} [deps.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {{ open: Function, close: Function, get: Function, size: () => number }}
 */
export function createCanvasRegistry({
  createServer = nodeCreateServer,
  resolveBuildDir = () => defaultResolveBuildDir({ entryFiles }),
  existsSync = fsExistsSync,
  readFile = readFileSync,
  title = 'kbexplorer Knowledge Graph',
  entryFiles = CANVAS_ENTRY_CANDIDATES,
} = {}) {
  /** @type {Map<string, { url: string, title: string, server: object }>} */
  const instances = new Map();

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

    const handler = createRequestHandler({ buildDir, bootConfig, existsSync, readFile, entryFiles });
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
