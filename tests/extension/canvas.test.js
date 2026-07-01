import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCanvasOptions, KBX_CANVAS_ID } from '../../src/extension/canvas.js';

/** A fake registry that records open/close calls and returns a canned url. */
function makeFakeRegistry() {
  const calls = { open: [], close: [] };
  return {
    calls,
    open(instanceId, options) {
      calls.open.push({ instanceId, options });
      return { url: `http://127.0.0.1:1234#${instanceId}`, title: 'kbexplorer Knowledge Graph' };
    },
    close(instanceId) {
      calls.close.push(instanceId);
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
});
