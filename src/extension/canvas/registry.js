import { createServer as nodeCreateServer } from 'node:http';
import { existsSync as fsExistsSync, readFileSync } from 'node:fs';
import { resolve, join, normalize, extname, sep } from 'node:path';
import { ERROR_CODES, executeAffordance as defaultExecuteAffordance } from '../../affordances/index.js';
import { createEventBus, defaultSubscribe, SSE_EVENTS } from './sse.js';
import { MIME, DEFAULT_HEARTBEAT_MS, CANVAS_ENTRY_CANDIDATES, defaultResolveBuildDir, defaultGetManifest, defaultRunSearch, injectBootConfig, sliceManifest, buildChatIntentPrompt, readBody, CHAT_INTENT_NODE_ID_RE } from './state.js';

function isNotYet() { return false; }

export function createRequestHandler({ buildDir, bootConfig, existsSync, readFile, getManifest, runSearch, sendChatMessage, subscribe = defaultSubscribe, executeAffordance = defaultExecuteAffordance, registerCleanup = () => {}, heartbeatMs = DEFAULT_HEARTBEAT_MS, setInterval: setIntervalSeam = globalThis.setInterval, clearInterval: clearIntervalSeam = globalThis.clearInterval, entryFiles = CANVAS_ENTRY_CANDIDATES }) {
  const serveIndex = (res) => {
    let html; const entry = buildDir ? entryFiles.map((f) => join(buildDir, f)).find((p) => existsSync(p)) : null;
    if (entry) html = String(readFile(entry));
    else html = ['<!doctype html>', '<html lang="en">', '<head><meta charset="utf-8"><title>kbexplorer canvas</title></head>', '<body><div id="root" data-kbx-fallback="true"></div></body>', '</html>', ''].join('\n');
    const body = injectBootConfig(html, bootConfig());
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(body);
  };
  const serveAsset = (res, pathname) => {
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const abs = resolve(buildDir, rel); const root = resolve(buildDir); const within = abs === root || abs.startsWith(root + sep);
    if (!within || !existsSync(abs)) { res.writeHead(404, { 'content-type': MIME['.json'] }); res.end(JSON.stringify({ error: 'not found', endpoint: pathname })); return; }
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); res.end(readFile(abs));
  };
  const sendJson = (res, status, obj) => { res.writeHead(status, { 'content-type': MIME['.json'] }); res.end(JSON.stringify(obj)); };
  const serveManifest = async (res) => {
    try { const manifest = await getManifest(); res.writeHead(200, { 'content-type': MIME['.json'] }); res.end(JSON.stringify(manifest)); }
    catch (err) { sendJson(res, 500, { error: 'manifest generation failed', message: String(err?.message || err) }); }
  };
  const serveManifestSlice = async (res, rawQuery) => {
    const params = new URLSearchParams(rawQuery || '');
    const ids = (params.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) { sendJson(res, 400, { error: 'ids required', endpoint: '/manifest/slice' }); return; }
    try { const manifest = await getManifest(); res.writeHead(200, { 'content-type': MIME['.json'] }); res.end(JSON.stringify(sliceManifest(manifest, ids))); }
    catch (err) { sendJson(res, 500, { error: 'manifest generation failed', message: String(err?.message || err) }); }
  };
  const serveSearch = async (req, res, method) => {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed', endpoint: '/search' }); return; }
    let payload; try { const raw = await readBody(req); payload = raw ? JSON.parse(raw) : {}; }
    catch { sendJson(res, 400, { error: 'invalid json body', endpoint: '/search' }); return; }
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query) { sendJson(res, 400, { error: 'query required', endpoint: '/search' }); return; }
    const limit = Number.isFinite(payload.limit) ? payload.limit : 10;
    try { const out = await runSearch({ query, limit, graphRanking: payload.graphRanking }); res.writeHead(200, { 'content-type': MIME['.json'] }); res.end(JSON.stringify(out)); }
    catch (err) { sendJson(res, 500, { error: 'search failed', message: String(err?.message || err) }); }
  };
  const serveEvents = (req, res, method) => {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed', endpoint: '/events' }); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk) => { try { res.write(chunk); } catch {} };
    write(': connected\n\n'); write('retry: 3000\n\n');
    const writeEvent = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    writeEvent(SSE_EVENTS.READY, { ok: true });
    const hb = setIntervalSeam(() => write(': heartbeat\n\n'), heartbeatMs); if (hb && typeof hb.unref === 'function') hb.unref();
    let unsubscribe = () => {};
    try { unsubscribe = subscribe((evt) => { if (evt && typeof evt.event === 'string') writeEvent(evt.event, evt.data); }) || (() => {}); } catch {}
    let done = false; const cleanup = () => { if (done) return; done = true; clearIntervalSeam(hb); try { unsubscribe(); } catch {} try { res.end(); } catch {} };
    const tracked = registerCleanup(cleanup) || cleanup; if (req && typeof req.on === 'function') { req.on('close', tracked); req.on('error', tracked); }
  };
  const serveAffordance = async (req, res, method, pathname) => {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed', endpoint: pathname }); return; }
    const name = decodeURIComponent(pathname.slice('/affordance/'.length)).trim();
    if (!name) { sendJson(res, 404, { error: 'unknown affordance', endpoint: pathname }); return; }
    let payload; try { const raw = await readBody(req); payload = raw ? JSON.parse(raw) : {}; }
    catch { sendJson(res, 400, { error: 'invalid json body', endpoint: pathname }); return; }
    const input = payload && typeof payload === 'object' && !Array.isArray(payload) && 'input' in payload ? payload.input : payload;
    try { const result = await executeAffordance(name, input ?? {}); res.writeHead(200, { 'content-type': MIME['.json'] }); res.end(JSON.stringify({ ok: true, result })); }
    catch (err) { const code = err?.code; const status = code === ERROR_CODES.UNKNOWN_AFFORDANCE ? 404 : code === ERROR_CODES.NOT_FOUND ? 404 : code === ERROR_CODES.INVALID_INPUT ? 400 : code === ERROR_CODES.CONSENT_REQUIRED || code === ERROR_CODES.CONSENT_DENIED ? 403 : 500; const body = typeof err?.toJSON === 'function' ? err.toJSON() : { error: true, code: code || 'EXECUTION_FAILED', message: String(err?.message || err) }; sendJson(res, status, body); }
  };
  const serveChatIntent = async (req, res, method) => {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed', endpoint: '/chat-intent' }); return; }
    let payload; try { const raw = await readBody(req); payload = raw ? JSON.parse(raw) : {}; }
    catch { sendJson(res, 400, { error: 'invalid json body', endpoint: '/chat-intent' }); return; }
    const intent = typeof payload.intent === 'string' ? payload.intent.trim() : ''; const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : ''; const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
    if (!intent) { sendJson(res, 400, { error: 'intent required', endpoint: '/chat-intent' }); return; }
    if (!nodeId) { sendJson(res, 400, { error: 'nodeId required', endpoint: '/chat-intent' }); return; }
    if (!CHAT_INTENT_NODE_ID_RE.test(nodeId)) { sendJson(res, 400, { error: 'invalid nodeId', endpoint: '/chat-intent', message: 'nodeId must be a kebab-case identifier (lowercase letters, digits, hyphens)' }); return; }
    const chatPrompt = buildChatIntentPrompt({ intent, nodeId, prompt });
    if (!chatPrompt) { sendJson(res, 400, { error: 'prompt required for custom intent', endpoint: '/chat-intent', message: `intent "${intent}" has no built-in phrasing; supply "prompt" explicitly` }); return; }
    if (typeof sendChatMessage !== 'function') { sendJson(res, 503, { error: 'chat seam unavailable', endpoint: '/chat-intent', message: 'no SDK session is joined; click-to-chat intents cannot be posted right now' }); return; }
    try { const messageId = await sendChatMessage(chatPrompt); sendJson(res, 200, { ok: true, messageId: messageId ?? null }); }
    catch (err) { sendJson(res, 500, { error: 'chat-intent failed', message: String(err?.message || err) }); }
  };
  return (req, res) => {
    const method = (req.method || 'GET').toUpperCase(); const [pathname, rawQuery = ''] = (req.url || '/').split('?');
    if (pathname === '/' || pathname === '/index.html') { serveIndex(res); return; }
    if (pathname === '/manifest') { void serveManifest(res); return; }
    if (pathname === '/manifest/slice') { void serveManifestSlice(res, rawQuery); return; }
    if (pathname === '/search') { void serveSearch(req, res, method); return; }
    if (pathname === '/events') { serveEvents(req, res, method); return; }
    if (pathname === '/chat-intent') { void serveChatIntent(req, res, method); return; }
    if (pathname === '/affordance' || pathname === '/affordance/') { sendJson(res, 404, { error: 'unknown affordance', endpoint: pathname }); return; }
    if (pathname.startsWith('/affordance/')) { void serveAffordance(req, res, method, pathname); return; }
    if (isNotYet(pathname)) { res.writeHead(404, { 'content-type': MIME['.json'] }); res.end(JSON.stringify({ error: 'not yet', endpoint: pathname })); return; }
    if (buildDir) { serveAsset(res, pathname); return; }
    res.writeHead(404, { 'content-type': MIME['.json'] }); res.end(JSON.stringify({ error: 'not found', endpoint: pathname }));
  };
}

export function createCanvasRegistry({ createServer = nodeCreateServer, resolveBuildDir = () => defaultResolveBuildDir({ entryFiles }), existsSync = fsExistsSync, readFile = readFileSync, title = 'kbexplorer Knowledge Graph', cwd = process.cwd(), getManifest, runSearch, loadSearchModule, eventBus = createEventBus(), subscribe = eventBus.subscribe, sendChatMessage, executeAffordance = defaultExecuteAffordance, heartbeatMs = DEFAULT_HEARTBEAT_MS, entryFiles = CANVAS_ENTRY_CANDIDATES } = {}) {
  const instances = new Map(); const getManifestSeam = getManifest || (() => defaultGetManifest({ cwd, existsSync, readFile })); const runSearchSeam = runSearch || ((params) => defaultRunSearch(params, { cwd, getManifest: getManifestSeam, loadSearchModule }));
  async function open(instanceId, options = {}) {
    if (!instanceId || typeof instanceId !== 'string') throw new TypeError('canvas registry.open: "instanceId" must be a non-empty string');
    const existing = instances.get(instanceId); if (existing) return { url: existing.url, title: existing.title };
    const buildDir = resolveBuildDir(); let origin = ''; const bootConfig = () => ({ local: true, visualMode: 'inherit-host', searchServiceUrl: `${origin}/search`, ...(options.anchorNodeId ? { anchorNodeId: options.anchorNodeId } : {}) });
    const sseCleanups = new Set();
    const registerCleanup = (fn) => { const wrapped = () => { sseCleanups.delete(wrapped); fn(); }; sseCleanups.add(wrapped); return wrapped; };
    const handler = createRequestHandler({ buildDir, bootConfig, existsSync, readFile, getManifest: getManifestSeam, runSearch: runSearchSeam, sendChatMessage, subscribe: (onEvent) => subscribe(instanceId, onEvent), executeAffordance, registerCleanup, heartbeatMs, entryFiles });
    const server = createServer(handler);
    const port = await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => { const addr = server.address(); res(typeof addr === 'object' && addr ? addr.port : addr); }); });
    origin = `http://127.0.0.1:${port}`; const record = { url: origin, title, server, sseCleanups }; instances.set(instanceId, record); return { url: origin, title };
  }
  async function close(instanceId) { const record = instances.get(instanceId); if (!record) return; instances.delete(instanceId); for (const cleanup of [...record.sseCleanups]) { try { cleanup(); } catch {} } await new Promise((res) => { if (typeof record.server.close === 'function') record.server.close(() => res()); else res(); }); }
  return { open, close, get: (instanceId) => instances.get(instanceId), size: () => instances.size, emit: (instanceId, event, data) => eventBus.emit(instanceId, event, data), search: (params) => runSearchSeam(params) };
}

