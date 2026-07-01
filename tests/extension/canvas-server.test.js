import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import {
  createCanvasRegistry,
  createRequestHandler,
  injectBootConfig,
  defaultResolveBuildDir,
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

  it('404 "not yet" for A2–A5 endpoints', () => {
    const handler = createRequestHandler({
      buildDir: '/build',
      bootConfig,
      existsSync: () => true,
      readFile: () => 'x',
    });
    for (const path of ['/manifest', '/manifest/slice', '/search', '/events', '/affordance/foo']) {
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

    const notYet = await httpGet(`${url}/search`);
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
