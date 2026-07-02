import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildCanvasOptions,
  buildCanvasActions,
  KBX_CANVAS_ID,
} from '../../src/extension/canvas.js';
import { createCanvasRegistry, SSE_EVENTS } from '../../src/extension/canvas-server.js';
import { createAffordanceContext } from '../../src/affordances/index.js';

/** A fake registry that records open/close/emit/search calls and returns a canned url. */
function makeFakeRegistry({ search } = {}) {
  const calls = { open: [], close: [], emit: [], search: [] };
  return {
    calls,
    open(instanceId, options) {
      calls.open.push({ instanceId, options });
      return { url: `http://127.0.0.1:1234#${instanceId}`, title: 'kbexplorer Knowledge Graph' };
    },
    close(instanceId) {
      calls.close.push(instanceId);
    },
    emit(instanceId, event, data) {
      calls.emit.push({ instanceId, event, data });
      return true;
    },
    async search(params) {
      calls.search.push(params);
      if (search) return search(params);
      return { results: [], suggestions: [] };
    },
  };
}

describe('buildCanvasOptions (A1 server-backed)', () => {
  it('declares the canvas with a real async open/onClose', () => {
    const opts = buildCanvasOptions({ registry: makeFakeRegistry() });
    assert.equal(opts.id, KBX_CANVAS_ID);
    assert.equal(typeof opts.open, 'function');
    assert.equal(typeof opts.onClose, 'function');
    assert.equal(opts.inputSchema.properties.nodeId.type, 'string');
  });

  it('open() returns a real url + title from the registry', async () => {
    const registry = makeFakeRegistry();
    const opts = buildCanvasOptions({ registry });
    const res = await opts.open({ instanceId: 'panel-1' });
    assert.equal(res.url, 'http://127.0.0.1:1234#panel-1');
    assert.equal(res.title, 'kbexplorer Knowledge Graph');
    assert.equal(registry.calls.open[0].instanceId, 'panel-1');
  });

  it('threads input.nodeId through as anchorNodeId', async () => {
    const registry = makeFakeRegistry();
    const opts = buildCanvasOptions({ registry });
    await opts.open({ instanceId: 'p', input: { nodeId: 'n-9' } });
    assert.equal(registry.calls.open[0].options.anchorNodeId, 'n-9');
  });

  it('falls back to the canvas id when no instanceId is supplied', async () => {
    const registry = makeFakeRegistry();
    const opts = buildCanvasOptions({ registry });
    await opts.open({});
    assert.equal(registry.calls.open[0].instanceId, KBX_CANVAS_ID);
  });

  it('onClose() tears down the same instance', async () => {
    const registry = makeFakeRegistry();
    const opts = buildCanvasOptions({ registry });
    await opts.onClose({ instanceId: 'panel-1' });
    assert.deepEqual(registry.calls.close, ['panel-1']);
  });

  it('defaults to a real registry when none injected (no url before open)', () => {
    const opts = buildCanvasOptions();
    assert.equal(opts.id, KBX_CANVAS_ID);
    assert.equal(typeof opts.open, 'function');
  });

  it('declares the actions[] surface with anchor/expand/trace/filter, well-formed', () => {
    const opts = buildCanvasOptions({ registry: makeFakeRegistry() });
    const names = opts.actions.map((a) => a.name);
    assert.deepEqual(names, ['anchor', 'expand', 'trace', 'filter']);
    for (const action of opts.actions) {
      // Copilot canvas SDK action-name rule: must not start with the reserved
      // `canvas.` lifecycle-verb prefix.
      assert.equal(action.name.startsWith('canvas.'), false);
      assert.equal(typeof action.description, 'string');
      assert.ok(action.description.length > 0);
      assert.equal(action.inputSchema.type, 'object');
      assert.equal(typeof action.handler, 'function');
    }
  });
});

// ---------------------------------------------------------------------------
// actions[] handlers (#194) — each delegates to an injected `execute` seam and
// pushes the matching event through `registry.emit`. This is the "prove the
// wiring" surface the reopened #194 explicitly required: a test that does NOT
// assert the emit is unacceptable, so every case below checks `registry.calls.emit`.
// ---------------------------------------------------------------------------

describe('buildCanvasActions: anchor', () => {
  function build(execute) {
    const registry = makeFakeRegistry();
    const actions = buildCanvasActions(registry, { execute, contextFactory: () => ({}) });
    return { registry, action: actions.find((a) => a.name === 'anchor') };
  }

  it('validates the node via execute("query_node", ...) then emits SSE_EVENTS.ANCHOR', async () => {
    const seen = [];
    const { registry, action } = build(async (name, input) => {
      seen.push({ name, input });
      return { id: input.id, title: 'Home Title' };
    });
    const result = await action.handler({ instanceId: 'p1', input: { nodeId: 'home' } });
    assert.deepEqual(seen, [{ name: 'query_node', input: { id: 'home' } }]);
    assert.deepEqual(registry.calls.emit, [
      { instanceId: 'p1', event: SSE_EVENTS.ANCHOR, data: { nodeId: 'home' } },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.title, 'Home Title');
    assert.equal(result.delivered, true);
  });

  it('throws before touching the registry when nodeId is missing', async () => {
    const { registry, action } = build(async () => {
      throw new Error('should not be called');
    });
    await assert.rejects(() => action.handler({ instanceId: 'p1', input: {} }), TypeError);
    assert.deepEqual(registry.calls.emit, []);
  });

  it('propagates a NOT_FOUND-style execute failure without emitting', async () => {
    const { registry, action } = build(async () => {
      throw new Error('no such node');
    });
    await assert.rejects(() => action.handler({ instanceId: 'p1', input: { nodeId: 'nope' } }));
    assert.deepEqual(registry.calls.emit, []);
  });
});

describe('buildCanvasActions: expand', () => {
  function build(execute) {
    const registry = makeFakeRegistry();
    const actions = buildCanvasActions(registry, { execute, contextFactory: () => ({}) });
    return { registry, action: actions.find((a) => a.name === 'expand') };
  }

  it('delegates to execute("graph_neighbors", ...) and emits a view-action envelope with just nodeId/depth', async () => {
    const { registry, action } = build(async (name, input) => {
      assert.equal(name, 'graph_neighbors');
      assert.deepEqual(input, { id: 'home', depth: 2 });
      return { id: 'home', depth: 2, neighbors: [{ id: 'child', distance: 1 }] };
    });
    const result = await action.handler({ instanceId: 'p1', input: { nodeId: 'home', depth: 2 } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'expand', params: { nodeId: 'home', depth: 2 } },
      },
    ]);
    assert.equal(result.delivered, true);
  });

  it('omits depth from the emitted params when not given', async () => {
    const { registry, action } = build(async (name, input) => {
      assert.deepEqual(input, { id: 'home', depth: undefined });
      return { id: 'home', depth: 1, neighbors: [] };
    });
    await action.handler({ instanceId: 'p1', input: { nodeId: 'home' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'expand', params: { nodeId: 'home' } },
      },
    ]);
  });

  it('threads a requestId through as best-effort pass-through when the invocation context happens to supply one (no current SDK guarantee this field exists)', async () => {
    const { registry, action } = build(async () => ({ id: 'home', depth: 1, neighbors: [] }));
    await action.handler({ instanceId: 'p1', input: { nodeId: 'home' }, requestId: 'req-1' });
    assert.equal(registry.calls.emit[0].data.requestId, 'req-1');
  });

  it('omits requestId entirely (no key at all) when the invocation context does not supply one', async () => {
    const { registry, action } = build(async () => ({ id: 'home', depth: 1, neighbors: [] }));
    await action.handler({ instanceId: 'p1', input: { nodeId: 'home' } });
    assert.equal('requestId' in registry.calls.emit[0].data, false);
  });

  it('throws when nodeId is missing', async () => {
    const { action } = build(async () => ({}));
    await assert.rejects(() => action.handler({ instanceId: 'p1', input: {} }), TypeError);
  });
});

describe('buildCanvasActions: trace', () => {
  function build(execute) {
    const registry = makeFakeRegistry();
    const actions = buildCanvasActions(registry, { execute, contextFactory: () => ({}) });
    return { registry, action: actions.find((a) => a.name === 'trace') };
  }

  it('accepts fromId/toId, computes the path via the `trace` affordance, and emits a view-action envelope with just the path', async () => {
    const { registry, action } = build(async (name, input) => {
      assert.equal(name, 'trace');
      assert.deepEqual(input, { fromId: 'home', toId: 'child' });
      return { fromId: 'home', toId: 'child', connected: true, path: ['home', 'child'], nodes: [] };
    });
    const result = await action.handler({
      instanceId: 'p1',
      input: { fromId: 'home', toId: 'child' },
    });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'trace', params: { path: ['home', 'child'] } },
      },
    ]);
    assert.equal(result.delivered, true);
    assert.equal(result.connected, true);
  });

  it('accepts a bare nodeId as an alias for fromId', async () => {
    const { action } = build(async (name, input) => {
      assert.deepEqual(input, { fromId: 'home', toId: undefined });
      return { fromId: 'home', toId: null, connected: true, path: ['home'], nodes: [] };
    });
    await action.handler({ instanceId: 'p1', input: { nodeId: 'home' } });
  });

  it('throws when neither fromId nor nodeId is given', async () => {
    const { action } = build(async () => ({}));
    await assert.rejects(() => action.handler({ instanceId: 'p1', input: {} }), TypeError);
  });
});

describe('buildCanvasActions: filter', () => {
  function build() {
    const registry = makeFakeRegistry();
    const actions = buildCanvasActions(registry, {
      execute: async () => {
        throw new Error('filter must not call any affordance');
      },
      contextFactory: () => ({}),
    });
    return { registry, action: actions.find((a) => a.name === 'filter') };
  }

  it('emits a view-action envelope with just cluster when only cluster is given', async () => {
    const { registry, action } = build();
    const result = await action.handler({ instanceId: 'p1', input: { cluster: 'core' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'filter', params: { cluster: 'core' } },
      },
    ]);
    assert.equal(result.delivered, true);
    assert.deepEqual(registry.calls.search, []);
  });

  it('emits a view-action envelope with just layer when only layer is given', async () => {
    const { registry, action } = build();
    await action.handler({ instanceId: 'p1', input: { layer: 'l2' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'filter', params: { layer: 'l2' } },
      },
    ]);
  });

  it('emits both cluster and layer when both are given', async () => {
    const { registry, action } = build();
    await action.handler({ instanceId: 'p1', input: { cluster: 'core', layer: 'l2' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'filter', params: { cluster: 'core', layer: 'l2' } },
      },
    ]);
  });

  it('trims whitespace from cluster/layer before emitting', async () => {
    const { registry, action } = build();
    await action.handler({ instanceId: 'p1', input: { cluster: '  core  ' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'filter', params: { cluster: 'core' } },
      },
    ]);
  });

  it('treats a blank-string field as absent: emits only the other valid field', async () => {
    const { registry, action } = build();
    await action.handler({ instanceId: 'p1', input: { cluster: '   ', layer: ' l2 ' } });
    assert.deepEqual(registry.calls.emit, [
      {
        instanceId: 'p1',
        event: SSE_EVENTS.VIEW_ACTION,
        data: { action: 'filter', params: { layer: 'l2' } },
      },
    ]);
  });

  it('throws when neither cluster nor layer is given', async () => {
    const { registry, action } = build();
    await assert.rejects(() => action.handler({ instanceId: 'p1', input: {} }), TypeError);
    assert.deepEqual(registry.calls.emit, []);
  });

  it('throws when cluster/layer are blank strings', async () => {
    const { action } = build();
    await assert.rejects(
      () => action.handler({ instanceId: 'p1', input: { cluster: '  ' } }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end proof (#212 acceptance bar): invoking an action produced by
// `buildCanvasOptions()` against a REAL registry must produce the matching
// `view-action` SSE frame on that instance's REAL `/events` HTTP stream, with
// true per-instance isolation. No fakes on either side of the seam — this is
// the wiring the original #194 PR never proved.
// ---------------------------------------------------------------------------

describe('canvas actions -> real registry -> real /events SSE (#212 end-to-end proof)', () => {
  /** Build a temp repo with a small content/ graph to run real affordances over. */
  function makeFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'kb-canvas-e2e-'));
    const content = resolve(dir, 'content');
    mkdirSync(content, { recursive: true });
    writeFileSync(
      join(content, 'config.yaml'),
      ['title: Demo', 'clusters:', '  core:', '    name: "Core"', '    color: "#fff"'].join('\n') +
        '\n'
    );
    const node = (id, extra = '', body = 'Body text.') =>
      writeFileSync(
        join(content, `${id}.md`),
        `---\nid: "${id}"\ntitle: "${id} title"\ncluster: core\n${extra}---\n\n${body}\n`
      );
    node('home', '', 'Home page.');
    node('child', 'parent: home\nconnections:\n  - to: "home"\n    description: "links home"\n');
    node('lonely');
    return dir;
  }

  const sseOpen = (url) =>
    new Promise((resolvePromise, rej) => {
      const req = request(url, { method: 'GET' }, (r) => {
        let buf = '';
        const waiters = [];
        r.setEncoding('utf8');
        r.on('data', (c) => {
          buf += c;
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].re.test(buf)) {
              waiters[i].resolve();
              waiters.splice(i, 1);
            }
          }
        });
        resolvePromise({
          get bytes() {
            return buf;
          },
          waitForBytes: (re) =>
            new Promise((res) => {
              if (re.test(buf)) res();
              else waiters.push({ re, resolve: res });
            }),
          abort: () => req.destroy(),
        });
      });
      req.on('error', rej);
      req.end();
    });

  let fixtureDir;
  let registry;
  let opts;
  let url;
  let otherUrl;

  before(async () => {
    fixtureDir = makeFixture();
    registry = createCanvasRegistry({ resolveBuildDir: () => null, cwd: fixtureDir });
    opts = buildCanvasOptions({
      registry,
      contextFactory: () => createAffordanceContext({ cwd: fixtureDir }),
    });
    ({ url } = await registry.open('e2e-inst'));
  });

  after(async () => {
    await registry.close('e2e-inst');
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('anchor: invoking the action delivers a real "anchor" SSE frame', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'anchor');
    const result = await action.handler({ instanceId: 'e2e-inst', input: { nodeId: 'home' } });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);

    await sse.waitForBytes(/event: anchor\ndata: \{"nodeId":"home"\}/);
    sse.abort();
  });

  it('expand: invoking the action delivers a real "view-action" SSE frame', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'expand');
    const result = await action.handler({ instanceId: 'e2e-inst', input: { nodeId: 'home' } });
    assert.equal(result.delivered, true);

    await sse.waitForBytes(
      /event: view-action\ndata: \{"action":"expand","params":\{"nodeId":"home"\}\}/
    );
    sse.abort();
  });

  it('trace: invoking the action delivers a real "view-action" SSE frame with just the path', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'trace');
    const result = await action.handler({
      instanceId: 'e2e-inst',
      input: { fromId: 'home', toId: 'child' },
    });
    assert.equal(result.delivered, true);
    assert.equal(result.connected, true);

    await sse.waitForBytes(
      /event: view-action\ndata: \{"action":"trace","params":\{"path":\["home","child"\]\}\}/
    );
    sse.abort();
  });

  it('filter: with only cluster, delivers a real "view-action" SSE frame with just cluster in params', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'filter');
    const result = await action.handler({
      instanceId: 'e2e-inst',
      input: { cluster: 'core' },
    });
    assert.equal(result.delivered, true);

    await sse.waitForBytes(
      /event: view-action\ndata: \{"action":"filter","params":\{"cluster":"core"\}\}/
    );
    sse.abort();
  });

  it('filter: with cluster+layer, delivers both in the view-action params', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'filter');
    const result = await action.handler({
      instanceId: 'e2e-inst',
      input: { cluster: 'core', layer: 'l2' },
    });
    assert.equal(result.delivered, true);

    await sse.waitForBytes(
      /event: view-action\ndata: \{"action":"filter","params":\{"cluster":"core","layer":"l2"\}\}/
    );
    sse.abort();
  });

  it('two subscribed instances stay isolated: an expand on one never emits view-action on the other', async () => {
    ({ url: otherUrl } = await registry.open('e2e-inst-2'));
    try {
      let sseA;
      let sseB;
      try {
        sseA = await sseOpen(`${url}/events`);
        sseB = await sseOpen(`${otherUrl}/events`);
        await sseA.waitForBytes(/event: ready/);
        await sseB.waitForBytes(/event: ready/);

        const action = opts.actions.find((a) => a.name === 'expand');
        const result = await action.handler({ instanceId: 'e2e-inst', input: { nodeId: 'home' } });
        assert.equal(result.delivered, true);

        await sseA.waitForBytes(/event: view-action/);
        await new Promise((r) => setTimeout(r, 20));
        assert.doesNotMatch(sseB.bytes, /event: view-action/);
      } finally {
        sseA?.abort();
        sseB?.abort();
      }
    } finally {
      await registry.close('e2e-inst-2');
    }
  });

  it('an action invoked for a DIFFERENT instanceId never reaches this stream', async () => {
    const sse = await sseOpen(`${url}/events`);
    await sse.waitForBytes(/event: ready/);

    const action = opts.actions.find((a) => a.name === 'anchor');
    const result = await action.handler({
      instanceId: 'some-other-instance',
      input: { nodeId: 'home' },
    });
    assert.equal(result.delivered, false); // no subscriber on that other instance

    // Give the event loop a tick, then confirm nothing arrived on THIS stream.
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotMatch(sse.bytes, /event: anchor/);
    sse.abort();
  });
});
