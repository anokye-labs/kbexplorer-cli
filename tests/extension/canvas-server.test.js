import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import {
  createCanvasRegistry,
  createRequestHandler,
  injectBootConfig,
  defaultResolveBuildDir,
  defaultGetManifest,
  defaultRunSearch,
  sliceManifest,
  toSemanticResult,
  textIndexSearch,
  CANVAS_ENTRY_FILE,
  CANVAS_ENTRY_CANDIDATES,
} from '../../src/extension/canvas-server.js';

/**
 * A fake `http.Server` that records the handler and simulates listen/close/
 * address without binding a real port.
 */
function makeFakeServer(port = 4321) {
  return {
    handler: null,
    listening: false,
    closed: false,
    _errHandlers: {},
    once(evt, cb) {
      this._errHandlers[evt] = cb;
      return this;
    },
    listen(_port, _host, cb) {
      this.listening = true;
      if (cb) cb();
      return this;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port };
    },
    close(cb) {
      this.closed = true;
      this.listening = false;
      if (cb) cb();
      return this;
    },
  };
}

/** Fake response capturing status/headers/body. */
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk != null) this.body += String(chunk);
    },
  };
}

describe('CANVAS_ENTRY_FILE (A1<->template#406 seam)', () => {
  it('defaults the preferred entry to canvas.html', () => {
    assert.equal(CANVAS_ENTRY_FILE, 'canvas.html');
  });

  it('prefers canvas.html then index.html', () => {
    assert.deepEqual(CANVAS_ENTRY_CANDIDATES, ['canvas.html', 'index.html']);
  });

  it('honors a custom entryFiles list in createRequestHandler', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig: () => ({ local: true }),
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('/build/embed.html'),
      readFile: () => '<head></head><body>EMBED</body>',
      entryFiles: ['embed.html'],
    });
    const res = makeRes();
    handler({ url: '/' }, res);
    assert.match(res.body, /EMBED/);
    assert.match(res.body, /__KBX_CANVAS__/);
  });
});

describe('injectBootConfig', () => {
  it('injects the boot script before </head>', () => {
    const out = injectBootConfig('<html><head><title>x</title></head><body></body></html>', {
      local: true,
    });
    assert.match(out, /window\.__KBX_CANVAS__=\{"local":true\};<\/script><\/head>/);
  });

  it('falls back to before </body> when no head', () => {
    const out = injectBootConfig('<body>hi</body>', { a: 1 });
    assert.match(out, /<\/script><\/body>/);
  });

  it('escapes < so values cannot break out of the script tag', () => {
    const out = injectBootConfig('<head></head>', { anchorNodeId: '</script><script>evil' });
    assert.ok(!out.includes('</script><script>evil'));
    assert.match(out, /\\u003c\/script>/);
  });
});

describe('createRequestHandler', () => {
  const bootConfig = () => ({
    local: true,
    visualMode: 'inherit-host',
    searchServiceUrl: 'http://127.0.0.1:4321/search',
  });

  it('serves the fallback index + boot config when no build dir', () => {
    const handler = createRequestHandler({
      buildDir: null,
      bootConfig,
      existsSync: () => false,
      readFile: () => '',
    });
    const res = makeRes();
    handler({ url: '/' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /data-kbx-fallback="true"/);
    assert.match(res.body, /window\.__KBX_CANVAS__=/);
    assert.match(res.body, /inherit-host/);
  });

  it('serves canvas.html (the embeddable entry) from the build dir with injected boot config', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('/build/canvas.html'),
      readFile: () => '<html><head></head><body><div id="root"></div></body></html>',
    });
    const res = makeRes();
    handler({ url: '/index.html' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /id="root"/);
    assert.match(res.body, /searchServiceUrl/);
  });

  it('does NOT prefer index.html over canvas.html: serves canvas.html when both exist', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: (p) => /\/build\/(canvas|index)\.html$/.test(p.replace(/\\/g, '/')),
      readFile: (p) => (p.replace(/\\/g, '/').endsWith('canvas.html') ? 'EMBED' : 'FULLPAGE'),
    });
    const res = makeRes();
    handler({ url: '/' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /EMBED/);
    assert.doesNotMatch(res.body, /FULLPAGE/);
  });

  it('falls back to index.html when canvas.html is absent (pre-#406 best effort)', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('/build/index.html'),
      readFile: () => '<html><head></head><body>FULLPAGE</body></html>',
    });
    const res = makeRes();
    handler({ url: '/' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /FULLPAGE/);
    assert.match(res.body, /__KBX_CANVAS__/);
  });

  it('404 "not yet" for the still-unimplemented A4/A5 endpoints', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: () => true,
      readFile: () => 'x',
    });
    for (const path of ['/events', '/affordance/foo']) {
      const res = makeRes();
      handler({ url: `${path}?q=1` }, res);
      assert.equal(res.statusCode, 404, path);
      assert.deepEqual(JSON.parse(res.body), { error: 'not yet', endpoint: path });
    }
  });

  it('serves a static asset from the build dir', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: () => true,
      readFile: (p) => `/* ${p} */`,
    });
    const res = makeRes();
    handler({ url: '/assets/app.js' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.body, /app\.js/);
  });

  it('404s an unknown asset that does not exist', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('/build/index.html'),
      readFile: () => 'x',
    });
    const res = makeRes();
    handler({ url: '/nope.js' }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'not found');
  });

  it('confines resolved asset paths to the build dir (no traversal escape)', () => {
    let readPath = null;
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: () => true,
      readFile: (p) => {
        readPath = p;
        return 'x';
      },
    });
    const res = makeRes();
    handler({ url: '/../../etc/passwd' }, res);
    // Either refused (404) or served from strictly within the build root.
    if (res.statusCode === 200) {
      const norm = readPath.replace(/\\/g, '/');
      assert.ok(/\/build\//.test(norm) && !/\/build\/\.\.\//.test(norm), norm);
      assert.ok(!norm.includes('/etc/passwd') || norm.includes('/build/etc/passwd'));
    } else {
      assert.equal(res.statusCode, 404);
    }
  });
});

describe('createCanvasRegistry (fake server)', () => {
  it('opens one server per instanceId and returns a loopback url + title', async () => {
    const created = [];
    const registry = createCanvasRegistry({
      createServer: (h) => {
        const s = makeFakeServer(5555);
        s.handler = h;
        created.push(s);
        return s;
      },
      resolveBuildDir: () => null,
      title: 'KB',
    });

    const r = await registry.open('inst-1');
    assert.equal(r.url, 'http://127.0.0.1:5555');
    assert.equal(r.title, 'KB');
    assert.equal(registry.size(), 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].listening, true);
  });

  it('is idempotent: re-open with same instanceId reuses the server', async () => {
    let n = 0;
    const registry = createCanvasRegistry({
      createServer: () => makeFakeServer(6000 + n++),
      resolveBuildDir: () => null,
    });
    const a = await registry.open('same');
    const b = await registry.open('same');
    assert.equal(a.url, b.url);
    assert.equal(registry.size(), 1);
  });

  it('distinct instanceIds get distinct servers', async () => {
    let port = 7000;
    const registry = createCanvasRegistry({
      createServer: () => makeFakeServer(port++),
      resolveBuildDir: () => null,
    });
    const a = await registry.open('a');
    const b = await registry.open('b');
    assert.notEqual(a.url, b.url);
    assert.equal(registry.size(), 2);
  });

  it('close tears down the server and frees the slot', async () => {
    const servers = [];
    const registry = createCanvasRegistry({
      createServer: () => {
        const s = makeFakeServer(8080);
        servers.push(s);
        return s;
      },
      resolveBuildDir: () => null,
    });
    await registry.open('x');
    await registry.close('x');
    assert.equal(registry.size(), 0);
    assert.equal(servers[0].closed, true);
  });

  it('close on an unknown instanceId is a no-op', async () => {
    const registry = createCanvasRegistry({
      createServer: () => makeFakeServer(),
      resolveBuildDir: () => null,
    });
    await assert.doesNotReject(() => registry.close('ghost'));
    assert.equal(registry.size(), 0);
  });

  it('threads anchorNodeId into the served boot config', async () => {
    let handler;
    const registry = createCanvasRegistry({
      createServer: (h) => {
        handler = h;
        return makeFakeServer(9001);
      },
      resolveBuildDir: () => null,
    });
    await registry.open('anchored', { anchorNodeId: 'node-42' });
    const res = makeRes();
    handler({ url: '/' }, res);
    const cfg = JSON.parse(res.body.match(/__KBX_CANVAS__=(\{.*?\});<\/script>/)[1]);
    assert.equal(cfg.anchorNodeId, 'node-42');
    assert.equal(cfg.searchServiceUrl, 'http://127.0.0.1:9001/search');
  });

  it('rejects a non-string instanceId', async () => {
    const registry = createCanvasRegistry({ createServer: () => makeFakeServer() });
    await assert.rejects(() => registry.open(''), TypeError);
  });
});

describe('createCanvasRegistry (real loopback integration)', () => {
  const httpGet = (url) =>
    new Promise((res, rej) => {
      const req = request(url, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => res({ status: r.statusCode, body }));
      });
      req.on('error', rej);
      req.end();
    });

  it('binds a real 127.0.0.1 port, serves / with boot config, then tears down', async () => {
    const registry = createCanvasRegistry({ resolveBuildDir: () => null, title: 'Real KB' });
    const { url, title } = await registry.open('real');
    assert.equal(title, 'Real KB');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const root = await httpGet(`${url}/`);
    assert.equal(root.status, 200);
    assert.match(root.body, /window\.__KBX_CANVAS__=/);
    assert.match(root.body, /"local":true/);
    assert.match(root.body, new RegExp(`${url.replace(/[.]/g, '\\.')}/search`));

    const notYet = await httpGet(`${url}/events`);
    assert.equal(notYet.status, 404);
    assert.equal(JSON.parse(notYet.body).error, 'not yet');

    await registry.close('real');
    await assert.rejects(() => httpGet(`${url}/`));
  });
});

describe('defaultResolveBuildDir', () => {
  it('returns null when no build exists', () => {
    const prev = process.env.KBX_CANVAS_BUILD_DIR;
    delete process.env.KBX_CANVAS_BUILD_DIR;
    try {
      const dir = defaultResolveBuildDir({ existsSync: () => false, cwd: '/nowhere' });
      assert.equal(dir, null);
    } finally {
      if (prev !== undefined) process.env.KBX_CANVAS_BUILD_DIR = prev;
    }
  });

  it('honors KBX_CANVAS_BUILD_DIR when it has the embeddable canvas.html', () => {
    const prev = process.env.KBX_CANVAS_BUILD_DIR;
    process.env.KBX_CANVAS_BUILD_DIR = '/custom/build';
    try {
      const dir = defaultResolveBuildDir({
        existsSync: (p) => p.replace(/\\/g, '/') === '/custom/build/canvas.html',
        cwd: '/nowhere',
      });
      assert.equal(dir, '/custom/build');
    } finally {
      if (prev !== undefined) process.env.KBX_CANVAS_BUILD_DIR = prev;
      else delete process.env.KBX_CANVAS_BUILD_DIR;
    }
  });

  it('qualifies a build dir that has only index.html (best-effort until #406)', () => {
    const prev = process.env.KBX_CANVAS_BUILD_DIR;
    process.env.KBX_CANVAS_BUILD_DIR = '/custom/build';
    try {
      const dir = defaultResolveBuildDir({
        existsSync: (p) => p.replace(/\\/g, '/') === '/custom/build/index.html',
        cwd: '/nowhere',
      });
      assert.equal(dir, '/custom/build');
    } finally {
      if (prev !== undefined) process.env.KBX_CANVAS_BUILD_DIR = prev;
      else delete process.env.KBX_CANVAS_BUILD_DIR;
    }
  });
});

// ---------------------------------------------------------------------------
// A2/A3 data path — /manifest, /manifest/slice, /search.
// ---------------------------------------------------------------------------

/** A res that resolves `.done` once `end()` is called (for async endpoints). */
function makeAsyncRes() {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    done,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk != null) this.body += String(chunk);
      resolveDone(this);
    },
  };
  return res;
}

const page = (id, extra = {}) => {
  const fm = { id, title: `Title ${id}`, cluster: extra.cluster || 'core', ...extra };
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '', extra.body || `Body for ${id}.`);
  return lines.join('\n');
};

const FIXTURE_MANIFEST = {
  configRaw: 'title: X',
  authoredContent: {
    'content/a.md': page('node-a', { body: 'alpha audit validation logic' }),
    'content/b.md': page('node-b', { cluster: 'infra', body: 'beta deployment config' }),
    'content/c.md': page('node-c', { body: 'gamma unrelated words' }),
  },
  tree: [],
  readme: null,
};

const bootConfig = () => ({ local: true });

describe('GET /manifest (A2, #191)', () => {
  it('serves the full manifest bytes from the getManifest seam', async () => {
    const handler = createRequestHandler({
      buildDir: null,
      bootConfig,
      existsSync: () => false,
      readFile: () => '',
      getManifest: async () => FIXTURE_MANIFEST,
      runSearch: async () => ({ results: [], suggestions: [] }),
    });
    const res = makeAsyncRes();
    handler({ url: '/manifest', method: 'GET' }, res);
    await res.done;
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), FIXTURE_MANIFEST);
  });

  it('returns 500 when generation fails', async () => {
    const handler = createRequestHandler({
      buildDir: null,
      bootConfig,
      existsSync: () => false,
      readFile: () => '',
      getManifest: async () => {
        throw new Error('boom');
      },
      runSearch: async () => ({ results: [] }),
    });
    const res = makeAsyncRes();
    handler({ url: '/manifest', method: 'GET' }, res);
    await res.done;
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).message, /boom/);
  });
});

describe('GET /manifest/slice?ids= (A2, #191)', () => {
  const handler = () =>
    createRequestHandler({
      buildDir: null,
      bootConfig,
      existsSync: () => false,
      readFile: () => '',
      getManifest: async () => FIXTURE_MANIFEST,
      runSearch: async () => ({ results: [] }),
    });

  it('filters authoredContent to the requested frontmatter ids + slice marker', async () => {
    const res = makeAsyncRes();
    handler()({ url: '/manifest/slice?ids=node-a,node-c', method: 'GET' }, res);
    await res.done;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body.authoredContent).sort(), ['content/a.md', 'content/c.md']);
    assert.deepEqual(body.slice, { ids: ['node-a', 'node-c'] });
    // Non-authored keys are preserved (manifest-shaped).
    assert.equal(body.configRaw, 'title: X');
  });

  it('400s on empty/malformed ids', async () => {
    for (const url of ['/manifest/slice', '/manifest/slice?ids=', '/manifest/slice?ids=,%20,']) {
      const res = makeAsyncRes();
      handler()({ url, method: 'GET' }, res);
      await res.done;
      assert.equal(res.statusCode, 400, url);
      assert.equal(JSON.parse(res.body).error, 'ids required');
    }
  });
});

describe('sliceManifest', () => {
  it('drops pages whose frontmatter has no matching id', () => {
    const out = sliceManifest(FIXTURE_MANIFEST, ['node-b']);
    assert.deepEqual(Object.keys(out.authoredContent), ['content/b.md']);
    assert.deepEqual(out.slice, { ids: ['node-b'] });
  });
});

describe('POST /search (A3, #192)', () => {
  const handlerWith = (runSearch) =>
    createRequestHandler({
      buildDir: null,
      bootConfig,
      existsSync: () => false,
      readFile: () => '',
      getManifest: async () => FIXTURE_MANIFEST,
      runSearch,
    });

  it('returns the { results, suggestions } object from the runSearch seam', async () => {
    let received = null;
    const handler = handlerWith(async (params) => {
      received = params;
      return {
        results: [toSemanticResult({ nodeId: 'node-a', title: 'A', cluster: 'core', score: 0.9 })],
        suggestions: [],
      };
    });
    const res = makeAsyncRes();
    handler({ url: '/search', method: 'POST', body: { query: '  audit  ', limit: 10, graphRanking: true } }, res);
    await res.done;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].nodeId, 'node-a');
    assert.equal(body.results[0].chunkIndex, 0);
    assert.deepEqual(body.suggestions, []);
    // query is trimmed; limit + graphRanking forwarded.
    assert.deepEqual(received, { query: 'audit', limit: 10, graphRanking: true });
  });

  it('405 on non-POST', async () => {
    const res = makeAsyncRes();
    handlerWith(async () => ({ results: [] }))({ url: '/search', method: 'GET' }, res);
    await res.done;
    assert.equal(res.statusCode, 405);
  });

  it('400 on missing query', async () => {
    const res = makeAsyncRes();
    handlerWith(async () => ({ results: [] }))({ url: '/search', method: 'POST', body: { limit: 5 } }, res);
    await res.done;
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'query required');
  });

  it('400 on invalid JSON body', async () => {
    const res = makeAsyncRes();
    handlerWith(async () => ({ results: [] }))({ url: '/search', method: 'POST', body: '{not json' }, res);
    await res.done;
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid json body');
  });

  it('defaults limit to 10 when omitted', async () => {
    let received = null;
    const res = makeAsyncRes();
    handlerWith(async (p) => {
      received = p;
      return { results: [], suggestions: [] };
    })({ url: '/search', method: 'POST', body: { query: 'x' } }, res);
    await res.done;
    assert.equal(received.limit, 10);
  });
});

describe('toSemanticResult (SPA field mapping)', () => {
  it('maps engine output to exact SPA field names/casing', () => {
    const out = toSemanticResult({
      id: 'n1',
      title: 'T',
      clusterId: 'infra',
      score: 0.42,
      snippet: 's',
      path: 'content/x.md',
      connections: ['n2', 'n3'],
    });
    assert.deepEqual(out, {
      nodeId: 'n1',
      title: 'T',
      cluster: 'infra',
      score: 0.42,
      snippet: 's',
      chunkIndex: 0,
      connections: ['n2', 'n3'],
      path: 'content/x.md',
    });
  });

  it('coerces missing/invalid fields to safe defaults', () => {
    const out = toSemanticResult({});
    assert.equal(out.nodeId, '');
    assert.equal(out.score, 0);
    assert.equal(out.chunkIndex, 0);
    assert.deepEqual(out.connections, []);
  });
});

describe('textIndexSearch (fallback)', () => {
  it('ranks pages by query-term frequency and returns SemanticResult rows', () => {
    const rows = textIndexSearch(FIXTURE_MANIFEST, 'audit', 10);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].nodeId, 'node-a');
    assert.equal(rows[0].chunkIndex, 0);
    assert.ok(rows[0].score > 0 && rows[0].score <= 1);
  });

  it('returns [] for an empty query', () => {
    assert.deepEqual(textIndexSearch(FIXTURE_MANIFEST, '   ', 10), []);
  });

  it('respects the limit', () => {
    const rows = textIndexSearch(FIXTURE_MANIFEST, 'a', 1);
    assert.ok(rows.length <= 1);
  });
});

describe('defaultRunSearch (drift fallback)', () => {
  it('falls back to the text index + drift warning when the engine module is missing', async () => {
    const warnings = [];
    const out = await defaultRunSearch(
      { query: 'audit', limit: 5 },
      {
        cwd: process.cwd(),
        getManifest: async () => FIXTURE_MANIFEST,
        loadSearchModule: async () => {
          throw new Error('not installed');
        },
        warn: (m) => warnings.push(m),
      },
    );
    assert.ok(out.drift?.stale);
    assert.match(out.drift.reason, /engine unavailable/);
    assert.ok(out.results.length >= 1);
    assert.deepEqual(out.suggestions, []);
    assert.equal(warnings.length, 1);
  });

  it('falls back with an absent-artifacts drift reason when readArtifacts returns null', async () => {
    const out = await defaultRunSearch(
      { query: 'deployment' },
      {
        cwd: process.cwd(),
        getManifest: async () => FIXTURE_MANIFEST,
        loadSearchModule: async () => ({
          readArtifacts: () => null,
          createSearchEngine: () => ({ search: async () => [] }),
          getProvider: () => ({}),
        }),
        warn: () => {},
      },
    );
    assert.match(out.drift.reason, /artifacts absent/);
    assert.equal(out.results[0].nodeId, 'node-b');
  });

  it('uses the engine (no drift) when artifacts are present', async () => {
    const out = await defaultRunSearch(
      { query: 'audit', limit: 3 },
      {
        cwd: process.cwd(),
        getManifest: async () => FIXTURE_MANIFEST,
        loadSearchModule: async () => ({
          readArtifacts: () => ({ meta: { model: 'm', dimensions: 3 } }),
          getProvider: () => ({ embed: async () => [0, 0, 0] }),
          createSearchEngine: () => ({
            search: async () => [
              { nodeId: 'node-a', title: 'A', cluster: 'core', score: 0.8, snippet: 's', connections: [] },
            ],
          }),
        }),
        warn: () => {},
      },
    );
    assert.equal(out.drift, undefined);
    assert.equal(out.results[0].nodeId, 'node-a');
    assert.equal(out.results[0].score, 0.8);
  });
});

describe('defaultGetManifest (live + bundled fallback)', () => {
  it('returns the live-generated manifest when generation succeeds', async () => {
    const m = await defaultGetManifest({ generate: async () => FIXTURE_MANIFEST });
    assert.deepEqual(m, FIXTURE_MANIFEST);
  });

  it('falls back to a bundled repo-manifest.json when generation throws', async () => {
    const bundled = JSON.stringify({ configRaw: 'bundled' });
    const m = await defaultGetManifest({
      cwd: '/repo',
      generate: async () => {
        throw new Error('no gh');
      },
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('/repo/dist/kb/repo-manifest.json'),
      readFile: () => bundled,
    });
    assert.equal(m.configRaw, 'bundled');
  });

  it('rethrows when generation fails and no bundle exists', async () => {
    await assert.rejects(
      defaultGetManifest({
        generate: async () => {
          throw new Error('nope');
        },
        existsSync: () => false,
        readFile: () => '',
      }),
      /nope/,
    );
  });
});

describe('data-path integration (real loopback)', () => {
  const httpJson = (url, { method = 'GET', body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(url, { method }, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      if (body != null) req.end(typeof body === 'string' ? body : JSON.stringify(body));
      else req.end();
    });

  it('serves /manifest, /manifest/slice and POST /search over a real port via injected seams', async () => {
    const registry = createCanvasRegistry({
      resolveBuildDir: () => null,
      getManifest: async () => FIXTURE_MANIFEST,
      runSearch: async ({ query }) => ({
        results: [toSemanticResult({ nodeId: 'node-a', title: query, cluster: 'core', score: 1 })],
        suggestions: [],
      }),
    });
    const { url } = await registry.open('data-path');
    try {
      const man = await httpJson(`${url}/manifest`);
      assert.equal(man.status, 200);
      assert.equal(JSON.parse(man.body).configRaw, 'title: X');

      const slice = await httpJson(`${url}/manifest/slice?ids=node-b`);
      assert.equal(slice.status, 200);
      assert.deepEqual(Object.keys(JSON.parse(slice.body).authoredContent), ['content/b.md']);

      const search = await httpJson(`${url}/search`, { method: 'POST', body: { query: 'hello', limit: 10 } });
      assert.equal(search.status, 200);
      const sbody = JSON.parse(search.body);
      assert.equal(sbody.results[0].title, 'hello');
      assert.ok(Array.isArray(sbody.suggestions));
    } finally {
      await registry.close('data-path');
    }
  });
});
