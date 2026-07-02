import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { registerKbxExtension, createKbxExtensionConfig, KBX_CANVAS_ID } =
  await import('../../src/extension/index.js');

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
});
