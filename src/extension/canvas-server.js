/**
 * Loopback canvas server (A1, #190) — the CLI half of the frozen A/B seam.
 *
 * Replaces the old `canvas.js` stub with a real, per-instance loopback HTTP
 * server. Each canvas `instanceId` gets **one** `http.Server` bound to
 * `127.0.0.1:0`; the resulting `http://127.0.0.1:<port>` is the canvas `url`.
 * Servers are memoized per `instanceId` (re-opening rehydrates the same origin)
 * and torn down on close.
 *
 * Scope: server lifecycle, `GET /` (serve whatever SPA build is available +
 * inject the `window.__KBX_CANVAS__` boot config), static assets, and teardown.
 * All frozen-contract endpoints are implemented here behind injected seams:
 * `GET /manifest` + `GET /manifest/slice` (A2, #191) via `getManifest`;
 * `POST /search` (A3, #192) via `runSearch`; `GET /events` SSE (A4, #193) via
 * `subscribe` (a real per-instance {@link createEventBus} by default, so the
 * canvas actions declared in `src/extension/canvas.js` (#194) can push live
 * SSE frames through `registry.emit`); `POST /affordance/:name` (A5, #194)
 * via `executeAffordance` — the do-seam adapter that routes straight through
 * the affordance registry's fail-closed consent gate, the third delivery
 * surface after extension-tools (#163) and MCP (#197); and `POST /chat-intent`
 * (A6, #195) via `sendChatMessage` — turns an iframe click-intent into a real
 * new agent chat turn on the joined SDK session. By design EVERY intent (read
 * or write) routes through this seam; there is no direct-execute shortcut, so a
 * mutating intent can never bypass the agent's own consent gate.
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
import { parseFrontmatter } from '../lib/markdown.js';
import {
  executeAffordance as defaultExecuteAffordance,
  ERROR_CODES,
} from '../affordances/index.js';

/**
 * Endpoints owned by later issues; stubbed as `404 not yet` until they land.
 * All contract *routes* are now implemented (`/manifest` A2, `/search` A3,
 * `/events` A4, `/affordance/:name` A5), so no route remains stubbed. This is
 * about the HTTP surface only: `/events` (A4) is a live SSE endpoint, but the
 * *feature* behind it (real domain-event triggers + an SPA consumer) is a
 * separate, still-open follow-up — see {@link defaultSubscribe} and
 * `docs/canvas-loopback-contract.md`'s `/events` section. Do not read this
 * comment as "everything about /events is done."
 */
const NOT_YET_ENDPOINTS = [];

/** Default keep-alive cadence for the SSE `/events` stream (ms). */
const DEFAULT_HEARTBEAT_MS = 15000;

/**
 * The SSE event names the frozen loopback contract
 * (`docs/canvas-loopback-contract.md`) defines on `GET /events`. `graph-updated`
 * carries the mutated `{ nodes[] }`; `anchor` re-focuses the SPA on `{ nodeId }`.
 * `ready` is a transport-level "stream is live" signal emitted once on connect.
 * @enum {string}
 */
export const SSE_EVENTS = Object.freeze({
  READY: 'ready',
  GRAPH_UPDATED: 'graph-updated',
  ANCHOR: 'anchor',
});

/**
 * Default `/events` subscription seam — a no-op (heartbeat-only) emitter.
 * Kept exported so `createRequestHandler` callers can opt back into a truly
 * inert seam in hermetic tests. `createCanvasRegistry`'s real default is now
 * {@link createEventBus} (see below), not this no-op.
 *
 * @param {string} _instanceId  Canvas instance the subscription belongs to.
 * @param {(evt: { event: string, data: object }) => void} _onEvent  Frame sink.
 * @returns {() => void} Unsubscribe (no-op by default).
 */
export function defaultSubscribe(_instanceId, _onEvent) {
  return () => {};
}

/**
 * Create a real, per-canvas-instance domain-event bus: the emit side of the
 * `/events` (A4) SSE seam. This is what turns a canvas **action** (#194 —
 * anchor/expand/trace/filter) into a live SSE frame on that instance's
 * subscribed iframe, replacing the no-op {@link defaultSubscribe} the
 * registry used to default to.
 *
 * `subscribe(instanceId, onEvent)` is the shape `createRequestHandler`'s
 * `/events` route expects (see `serveEvents`); `emit(instanceId, event, data)`
 * is the new seam action handlers call. Listeners are scoped per
 * `instanceId` — an emit for one panel never reaches another panel's stream —
 * and a throwing listener never breaks its siblings or the emit call itself.
 *
 * @returns {{
 *   subscribe: (instanceId: string, onEvent: (evt: {event: string, data: object}) => void) => (() => void),
 *   emit: (instanceId: string, event: string, data?: object) => boolean,
 * }}
 */
export function createEventBus() {
  /** @type {Map<string, Set<(evt: {event: string, data: object}) => void>>} */
  const listeners = new Map();

  function subscribe(instanceId, onEvent) {
    let set = listeners.get(instanceId);
    if (!set) {
      set = new Set();
      listeners.set(instanceId, set);
    }
    set.add(onEvent);
    return () => {
      set.delete(onEvent);
      if (set.size === 0) listeners.delete(instanceId);
    };
  }

  /**
   * Push a domain event to every listener currently subscribed for
   * `instanceId` (i.e. every open `/events` SSE stream for that panel).
   * @returns {boolean} Whether any listener received the event.
   */
  function emit(instanceId, event, data) {
    const set = listeners.get(instanceId);
    if (!set || set.size === 0) return false;
    let delivered = false;
    for (const onEvent of [...set]) {
      try {
        onEvent({ event, data });
        delivered = true;
      } catch {
        /* a failing listener must not break its siblings or the emit call */
      }
    }
    return delivered;
  }

  return { subscribe, emit };
}

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
  return NOT_YET_ENDPOINTS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
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
 * The bundled-file fallback is a **degraded** mode (#208): the served manifest
 * can be stale relative to the actual repo. It is never silent — a prominent
 * operator warning is logged, and the returned manifest carries `degraded:
 * true` so `/manifest` and `/manifest/slice` responses surface it visibly.
 *
 * @param {object} [deps]
 * @param {string} [deps.cwd]
 * @param {(p: string) => boolean} [deps.existsSync]
 * @param {(p: string) => Buffer|string} [deps.readFile]
 * @param {() => Promise<object>} [deps.generate]  Injected generator (tests).
 * @param {(msg: string) => void} [deps.warn]
 * @returns {Promise<object>}
 */
export async function defaultGetManifest({
  cwd = process.cwd(),
  existsSync = fsExistsSync,
  readFile = readFileSync,
  generate,
  warn = console.warn,
} = {}) {
  try {
    const gen =
      generate ||
      (async () => {
        const { generateManifest } = await import('../lib/manifest.js');
        return generateManifest(cwd);
      });
    return await gen();
  } catch (err) {
    for (const candidate of bundledManifestCandidates(cwd)) {
      if (existsSync(candidate)) {
        try {
          const bundled = JSON.parse(String(readFile(candidate)));
          warn(
            `⚠⚠ [kbx canvas] DEGRADED: live manifest generation failed (${err?.message || err}). ` +
              `Serving a bundled manifest from ${candidate}, which may be stale relative to the ` +
              'current repo. Fix the underlying generation error to leave degraded mode.',
          );
          return { ...bundled, degraded: true };
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
 * `cluster`/`entityType` are applied as exact-match post-filters so this
 * fallback stays at parity with the engine-backed path for the canvas
 * `filter` action (#194) — the frozen `/search` HTTP endpoint (#192) does not
 * forward these fields today and is unaffected by this addition.
 *
 * @param {object} manifest
 * @param {string} query
 * @param {number} limit
 * @param {{ cluster?: string, entityType?: string }} [filters]
 * @returns {object[]}  SemanticResult-shaped rows.
 */
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
      cluster: rowCluster,
      _hits: hits,
      snippet: snippetSource.slice(0, 200),
      chunkIndex: 0,
      path,
      parentId: fm.parent ?? undefined,
      entityType: rowEntityType,
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
 * client text index over the live manifest.
 *
 * The text-index fallback is a **degraded** mode (#208), not silent: a
 * prominent operator warning is logged, and the response carries both
 * `degraded: true` and the existing `drift` detail so callers/UIs can surface
 * it without parsing free-text.
 *
 * `cluster`/`entityType` are honored on both paths (engine query + text-index
 * fallback) so callers — notably the canvas `filter` action (#194) via
 * {@link createCanvasRegistry}'s `registry.search` — get identical filtering
 * whether or not search artifacts are installed. The frozen `/search` HTTP
 * endpoint (#192) does not forward these fields today; this is additive.
 *
 * @param {{ query: string, limit?: number, graphRanking?: boolean, cluster?: string, entityType?: string }} params
 * @param {object} deps
 * @param {string} deps.cwd
 * @param {() => Promise<object>} deps.getManifest
 * @param {() => Promise<object>} [deps.loadSearchModule]  Injected engine (tests).
 * @param {(msg: string) => void} [deps.warn]
 * @returns {Promise<{ results: object[], suggestions: object[], degraded?: boolean, drift?: object }>}
 */
export async function defaultRunSearch(
  { query, limit = DEFAULT_SEARCH_LIMIT, graphRanking, cluster, entityType } = {},
  { cwd = process.cwd(), getManifest, loadSearchModule, warn = console.warn } = {}
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
      const results = await engine.search(query, { limit, cluster, entityType });
      return { results: results.map(toSemanticResult), suggestions: [] };
    }
  } catch (err) {
    driftReason = `search engine unavailable (${err?.message || err}); using client text-index fallback`;
  }

  if (driftReason) {
    warn(
      `⚠⚠ [kbx canvas] DEGRADED search: ${driftReason}. Results come from a basic ` +
        'client-side text index over the manifest, not the configured search engine — ' +
        'rebuild .search/ (kbx search-index) to leave degraded mode.',
    );
  }
  const manifest = await getManifest();
  const results = textIndexSearch(manifest, query, limit, { cluster, entityType });
  return {
    results,
    suggestions: [],
    degraded: true,
    drift: { stale: true, reason: driftReason || 'text-index fallback' },
  };
}

/**
 * Canonical shape of a manifest node id (kebab-case: lowercase letters,
 * digits, hyphens — see `docs/canvas-loopback-contract.md` and
 * `src/commands/scaffold.js`'s `SLUG_RE`). `/chat-intent` enforces this
 * BEFORE splicing `nodeId` into a canned prompt template, so a crafted
 * `nodeId` (quotes, newlines, prompt-injection text) can never ride along
 * into the literal text handed to `sendChatMessage` (#195 rubber-duck review).
 * @type {RegExp}
 */
const CHAT_INTENT_NODE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Canned chat phrasing for the click-intents the template panel is known to
 * emit (#195 / A6). Used only when the caller doesn't supply an explicit
 * `prompt` — the iframe is free to send its own caller-authored text instead.
 * @type {Record<string, (nodeId: string) => string>}
 */
const CHAT_INTENT_PROMPTS = Object.freeze({
  pin: (nodeId) => `Pin "${nodeId}" as the canvas anchor.`,
  derives: (nodeId) => `What derives from "${nodeId}" in the knowledge graph?`,
  affected: (nodeId) => `What would be affected by changes to "${nodeId}"?`,
});

/**
 * Resolve the literal chat-turn text for a `/chat-intent` request: an explicit
 * `prompt` always wins; otherwise fall back to a canned phrasing for known
 * intents. Unknown intents with no `prompt` return `null` — we refuse to
 * synthesize text for an intent we don't understand.
 * @param {{ intent: string, nodeId: string, prompt?: string }} params
 * @returns {string|null}
 */
function buildChatIntentPrompt({ intent, nodeId, prompt }) {
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();
  const template = CHAT_INTENT_PROMPTS[intent];
  return template ? template(nodeId) : null;
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
 * @param {(prompt: string) => Promise<string>} [opts.sendChatMessage]
 *        A6 (#195) click->chat seam: posts `prompt` as a real new user turn on
 *        the joined SDK session (mirrors `Session.send`, returning a message
 *        id). Undefined means no SDK session is joined yet — `/chat-intent`
 *        fails closed (503) rather than silently no-op-succeeding.
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
  sendChatMessage,
  subscribe = defaultSubscribe,
  executeAffordance = defaultExecuteAffordance,
  registerCleanup = () => {},
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  setInterval: setIntervalSeam = globalThis.setInterval,
  clearInterval: clearIntervalSeam = globalThis.clearInterval,
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
      sendJson(res, 500, {
        error: 'manifest generation failed',
        message: String(err?.message || err),
      });
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
      sendJson(res, 500, {
        error: 'manifest generation failed',
        message: String(err?.message || err),
      });
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

  const serveEvents = (req, res, method) => {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', endpoint: '/events' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (chunk) => {
      try {
        res.write(chunk);
      } catch {
        /* connection went away between events */
      }
    };
    // Open the stream: a comment to flush headers, a client retry advisory, and
    // an initial `ready` so consumers know the stream is live.
    write(': connected\n\n');
    write('retry: 3000\n\n');
    const writeEvent = (event, data) =>
      write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    writeEvent(SSE_EVENTS.READY, { ok: true });

    const hb = setIntervalSeam(() => write(': heartbeat\n\n'), heartbeatMs);
    // A keep-alive heartbeat must never hold the CLI's event loop open on its
    // own; unref the real timer so process exit is governed by real work.
    if (hb && typeof hb.unref === 'function') hb.unref();
    // Domain events (graph-updated / anchor) arrive via the injected subscribe
    // seam; default is a no-op so the endpoint is live + hermetic today.
    let unsubscribe = () => {};
    try {
      unsubscribe =
        subscribe((evt) => {
          if (evt && typeof evt.event === 'string') writeEvent(evt.event, evt.data);
        }) || (() => {});
    } catch {
      /* a failing subscribe must not break the heartbeat stream */
    }

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearIntervalSeam(hb);
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    const tracked = registerCleanup(cleanup) || cleanup;
    if (req && typeof req.on === 'function') {
      req.on('close', tracked);
      req.on('error', tracked);
    }
  };

  const serveAffordance = async (req, res, method, pathname) => {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', endpoint: pathname });
      return;
    }
    const name = decodeURIComponent(pathname.slice('/affordance/'.length)).trim();
    if (!name) {
      sendJson(res, 404, { error: 'unknown affordance', endpoint: pathname });
      return;
    }
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body', endpoint: pathname });
      return;
    }
    // Body is the affordance input; also accept a `{ input }` envelope (the
    // contract-doc shape). The registry — not this transport — owns validation
    // and the fail-closed consent gate; we only route through executeAffordance.
    const input =
      payload && typeof payload === 'object' && !Array.isArray(payload) && 'input' in payload
        ? payload.input
        : payload;
    try {
      const result = await executeAffordance(name, input ?? {});
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      const code = err?.code;
      const status =
        code === ERROR_CODES.UNKNOWN_AFFORDANCE
          ? 404
          : code === ERROR_CODES.NOT_FOUND
            ? 404
            : code === ERROR_CODES.INVALID_INPUT
              ? 400
              : code === ERROR_CODES.CONSENT_REQUIRED || code === ERROR_CODES.CONSENT_DENIED
                ? 403
                : 500;
      const body =
        typeof err?.toJSON === 'function'
          ? err.toJSON()
          : { error: true, code: code || 'EXECUTION_FAILED', message: String(err?.message || err) };
      sendJson(res, status, body);
    }
  };

  const serveChatIntent = async (req, res, method) => {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', endpoint: '/chat-intent' });
      return;
    }
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body', endpoint: '/chat-intent' });
      return;
    }
    const intent = typeof payload.intent === 'string' ? payload.intent.trim() : '';
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
    if (!intent) {
      sendJson(res, 400, { error: 'intent required', endpoint: '/chat-intent' });
      return;
    }
    if (!nodeId) {
      sendJson(res, 400, { error: 'nodeId required', endpoint: '/chat-intent' });
      return;
    }
    if (!CHAT_INTENT_NODE_ID_RE.test(nodeId)) {
      // Reject BEFORE templating: nodeId gets spliced verbatim into canned
      // prompt text below, so a malformed/adversarial nodeId (quotes,
      // newlines, prompt-injection attempts) must never reach that path.
      sendJson(res, 400, {
        error: 'invalid nodeId',
        endpoint: '/chat-intent',
        message: 'nodeId must be a kebab-case identifier (lowercase letters, digits, hyphens)',
      });
      return;
    }
    const chatPrompt = buildChatIntentPrompt({ intent, nodeId, prompt });
    if (!chatPrompt) {
      sendJson(res, 400, {
        error: 'prompt required for custom intent',
        endpoint: '/chat-intent',
        message: `intent "${intent}" has no built-in phrasing; supply "prompt" explicitly`,
      });
      return;
    }
    // Fail-closed by construction: EVERY intent — read-only or mutating —
    // routes through a real agent chat turn. There is no direct-execute path
    // here, so a mutating click-intent can never bypass the agent's own
    // consent gate by reaching this endpoint (see docs/canvas-loopback-contract.md).
    if (typeof sendChatMessage !== 'function') {
      sendJson(res, 503, {
        error: 'chat seam unavailable',
        endpoint: '/chat-intent',
        message: 'no SDK session is joined; click-to-chat intents cannot be posted right now',
      });
      return;
    }
    try {
      const messageId = await sendChatMessage(chatPrompt);
      sendJson(res, 200, { ok: true, messageId: messageId ?? null });
    } catch (err) {
      sendJson(res, 500, { error: 'chat-intent failed', message: String(err?.message || err) });
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
    if (pathname === '/events') {
      serveEvents(req, res, method);
      return;
    }
    if (pathname === '/chat-intent') {
      void serveChatIntent(req, res, method);
      return;
    }
    if (pathname === '/affordance' || pathname === '/affordance/') {
      sendJson(res, 404, { error: 'unknown affordance', endpoint: pathname });
      return;
    }
    if (pathname.startsWith('/affordance/')) {
      void serveAffordance(req, res, method, pathname);
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
 * @param {(instanceId: string, onEvent: Function) => (() => void)} [deps.subscribe]
 *        A4 `/events` domain-event seam. Defaults to a real {@link createEventBus}
 *        (per-instance, not a no-op) so canvas actions (#194) can push live SSE
 *        frames via the registry's `emit`. Inject a custom seam (or
 *        {@link defaultSubscribe}) to keep a test hermetic.
 * @param {(name: string, input: object, ctx?: object) => Promise<*>} [deps.executeAffordance]
 *        A5 `/affordance/:name` do-seam entry (default the real registry executor).
 * @param {(prompt: string) => Promise<string>} [deps.sendChatMessage]
 *        A6 (#195) `/chat-intent` click->chat seam: posts `prompt` as a new
 *        real user turn on the joined SDK session (mirrors `Session.send`,
 *        resolving to a message id). Left undefined by default — production
 *        wiring binds it once `joinSession()` resolves (see
 *        `src/extension/index.js`); undefined means `/chat-intent` fails
 *        closed (503) instead of pretending to have posted a message.
 * @param {number} [deps.heartbeatMs]  SSE keep-alive cadence (default 15000).
 * @param {string[]} [deps.entryFiles]  Ordered entry candidates (default canvas.html, index.html).
 * @returns {{ open: Function, close: Function, get: Function, size: () => number, emit: (instanceId: string, event: string, data?: object) => boolean, search: (params: object) => Promise<object> }}
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
  eventBus = createEventBus(),
  subscribe = eventBus.subscribe,
  sendChatMessage,
  executeAffordance = defaultExecuteAffordance,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  entryFiles = CANVAS_ENTRY_CANDIDATES,
} = {}) {
  /** @type {Map<string, { url: string, title: string, server: object, sseCleanups: Set<Function> }>} */
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

    // Track live SSE cleanups so close() can end keep-alive streams (otherwise
    // server.close() would hang on them). Each cleanup deregisters itself.
    const sseCleanups = new Set();
    const registerCleanup = (fn) => {
      const wrapped = () => {
        sseCleanups.delete(wrapped);
        fn();
      };
      sseCleanups.add(wrapped);
      return wrapped;
    };

    const handler = createRequestHandler({
      buildDir,
      bootConfig,
      existsSync,
      readFile,
      getManifest: getManifestSeam,
      runSearch: runSearchSeam,
      sendChatMessage,
      subscribe: (onEvent) => subscribe(instanceId, onEvent),
      executeAffordance,
      registerCleanup,
      heartbeatMs,
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
    const record = { url: origin, title, server, sseCleanups };
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
    // End any live SSE streams first so the underlying server can close cleanly.
    for (const cleanup of [...record.sseCleanups]) {
      try {
        cleanup();
      } catch {
        /* best-effort */
      }
    }
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
    /**
     * Push a domain event to instance `instanceId`'s subscribed `/events` SSE
     * stream(s). Drives the default {@link createEventBus}; a registry opened
     * with a custom `subscribe` seam that isn't the bus won't receive these
     * (documented seam-consistency caveat for hermetic tests).
     * @param {string} instanceId
     * @param {string} event
     * @param {object} [data]
     * @returns {boolean} Whether any live stream received the event.
     */
    emit: (instanceId, event, data) => eventBus.emit(instanceId, event, data),
    /**
     * The exact search seam the `/search` HTTP endpoint uses (A3, #192):
     * prefers `@anokye-labs/kbexplorer-search` over checked-in `.search/*`
     * artifacts, and — critically — falls back to the dependency-free
     * {@link textIndexSearch} over the live manifest when the engine/artifacts
     * are unavailable, so callers get the same graceful degradation the panel
     * gets from its own `/search` call. Exposed so the canvas `filter` action
     * (#194) has true parity instead of hard-requiring search artifacts via
     * the `search` affordance.
     * @param {{ query: string, limit?: number, cluster?: string, entityType?: string }} params
     * @returns {Promise<{ results: object[], suggestions: object[], drift?: object }>}
     */
    search: (params) => runSearchSeam(params),
  };
}
