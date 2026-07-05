import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

const { registerKbxExtension, createKbxExtensionConfig, KBX_CANVAS_ID } =
  await import('../../src/extension/index.ts');

const httpPost = (url, json) =>
  new Promise((res, rej) => {
    const req = request(url, { method: 'POST' }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('error', rej);
    req.end(JSON.stringify(json));
  });

describe('registerKbxExtension wiring', () => {
  it('createKbxExtensionConfig returns tools + canvas options', () => {
    const { tools, canvasOptions } = createKbxExtensionConfig();
    assert.equal(tools.length, 14);
    assert.equal(canvasOptions.id, KBX_CANVAS_ID);
    assert.equal(typeof canvasOptions.open, 'function');
  });

  it('binds tools AND the canvas into a single joinSession call', async () => {
    const seen = {};
    const fakeCanvas = { __canvas: true };
    const sessionSentinel = { joined: true };

    const session = await registerKbxExtension({
      createCanvas: (options) => {
        seen.canvasOptions = options;
        return fakeCanvas;
      },
      joinSession: (config) => {
        seen.config = config;
        return sessionSentinel;
      },
    });

    assert.equal(session, sessionSentinel);
    // Canvas built from the placeholder declaration.
    assert.equal(seen.canvasOptions.id, KBX_CANVAS_ID);
    // joinSession received BOTH surfaces in one call (no MCP round-trip).
    assert.equal(seen.config.tools.length, 14);
    assert.deepEqual(seen.config.canvases, [fakeCanvas]);
    assert.ok(seen.config.tools.every((t) => t.name.startsWith('kbx_')));
  });

  it('merges caller-supplied joinConfig tools/canvases and forwards hooks', async () => {
    const extraTool = { name: 'other_tool' };
    const extraCanvas = { __extra: true };
    const hooks = { onSessionStart: () => {} };
    let captured;

    await registerKbxExtension({
      createCanvas: () => ({ __kbx: true }),
      joinSession: (config) => {
        captured = config;
        return null;
      },
      joinConfig: { tools: [extraTool], canvases: [extraCanvas], hooks },
    });

    assert.equal(captured.hooks, hooks);
    assert.equal(captured.tools.length, 15);
    assert.equal(captured.tools[0], extraTool);
    assert.deepEqual(captured.canvases, [extraCanvas, { __kbx: true }]);
  });

  it('forwards tool seams (execute) through to the handlers', async () => {
    const calls = [];
    let toolList;
    await registerKbxExtension({
      createCanvas: () => ({}),
      joinSession: (config) => {
        toolList = config.tools;
        return null;
      },
      toolOptions: {
        execute: async (name) => {
          calls.push(name);
          return { routed: name };
        },
      },
    });
    const res = await toolList.find((t) => t.name === 'kbx_audit').handler({});
    assert.deepEqual(calls, ['audit']);
    assert.equal(res.resultType, 'success');
  });

  it('rejects missing SDK seams', async () => {
    await assert.rejects(() => registerKbxExtension({ createCanvas: () => ({}) }), TypeError);
    await assert.rejects(() => registerKbxExtension({ joinSession: () => null }), TypeError);
  });

  it('wires /chat-intent to the resolved SDK session (#195 click->chat seam)', async () => {
    const sendCalls = [];
    const sessionSentinel = {
      joined: true,
      send: async (prompt) => {
        sendCalls.push(prompt);
        return 'msg-abc';
      },
    };
    let capturedCanvasOptions;
    await registerKbxExtension({
      createCanvas: (options) => {
        capturedCanvasOptions = options;
        return { __canvas: true };
      },
      joinSession: () => sessionSentinel,
    });

    const { url } = await capturedCanvasOptions.open({ instanceId: 'sess-wire-1' });
    try {
      const res = await httpPost(`${url}/chat-intent`, { intent: 'derives', nodeId: 'home' });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true, messageId: 'msg-abc' });
      assert.equal(sendCalls.length, 1);
      assert.match(sendCalls[0], /derives from "home"/);
    } finally {
      // Guarantee the real loopback server is torn down even if an assertion
      // above throws — otherwise a leaked listener hangs the whole test run.
      await capturedCanvasOptions.onClose({ instanceId: 'sess-wire-1' });
    }
  });

  it('/chat-intent fails closed until joinSession resolves, then works (session-binding ordering)', async () => {
    let resolveJoin;
    const joinPromise = new Promise((res) => {
      resolveJoin = res;
    });
    let capturedCanvasOptions;
    const registerPromise = registerKbxExtension({
      createCanvas: (options) => {
        capturedCanvasOptions = options;
        return { __canvas: true };
      },
      joinSession: () => joinPromise,
    });

    // The canvas (and its registry/HTTP server) is built synchronously, before
    // joinSession() resolves — this is exactly the ordering /chat-intent's
    // lazy session-binding closure has to handle.
    const { url } = await capturedCanvasOptions.open({ instanceId: 'sess-wire-2' });
    try {
      // Before the session is bound, the lazy sendChatMessage closure exists
      // (so the endpoint doesn't 503 on "no seam configured") but THROWS when
      // invoked — the endpoint maps that to a 500, never a fake 200. Either
      // way, no message is ever silently dropped or fabricated as delivered.
      const before = await httpPost(`${url}/chat-intent`, { intent: 'derives', nodeId: 'home' });
      assert.equal(before.status, 500);
      assert.match(JSON.parse(before.body).message, /session not yet available/);

      resolveJoin({ send: async () => 'msg-late' });
      await registerPromise;

      const after = await httpPost(`${url}/chat-intent`, { intent: 'derives', nodeId: 'home' });
      assert.equal(after.status, 200);
      assert.deepEqual(JSON.parse(after.body), { ok: true, messageId: 'msg-late' });
    } finally {
      await capturedCanvasOptions.onClose({ instanceId: 'sess-wire-2' });
    }
  });
});
