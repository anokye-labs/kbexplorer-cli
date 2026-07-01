import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { registerKbxMcpServer } = await import('../../src/mcp/server.js');
const { buildMcpTools } = await import('../../src/mcp/tools.js');

/** Minimal fake low-level MCP Server that records setRequestHandler wiring. */
function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    setRequestHandler(schema, handler) {
      handlers.set(schema, handler);
    },
  };
}

const LIST = { __schema: 'list' };
const CALL = { __schema: 'call' };

describe('mcp/server — registerKbxMcpServer wiring', () => {
  it('validates its inputs', () => {
    assert.throws(() => registerKbxMcpServer({}), TypeError);
    assert.throws(() => registerKbxMcpServer({ server: fakeServer() }), TypeError);
  });

  it('registers list + call handlers and returns the tool list', () => {
    const server = fakeServer();
    const { tools } = registerKbxMcpServer({
      server,
      listToolsSchema: LIST,
      callToolSchema: CALL,
    });
    assert.ok(tools.length > 0);
    assert.equal(typeof server.handlers.get(LIST), 'function');
    assert.equal(typeof server.handlers.get(CALL), 'function');
  });

  it('tools/list returns name+description+inputSchema for each tool', async () => {
    const server = fakeServer();
    registerKbxMcpServer({ server, listToolsSchema: LIST, callToolSchema: CALL });
    const listing = await server.handlers.get(LIST)();
    assert.equal(listing.tools.length, buildMcpTools().length);
    for (const t of listing.tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  it('tools/call dispatches to the matching tool handler', async () => {
    const server = fakeServer();
    const stubTool = {
      name: 'kbx_stub',
      description: 'x',
      inputSchema: { type: 'object' },
      handler: async (args) => ({ content: [{ type: 'text', text: `got:${args.v}` }] }),
    };
    registerKbxMcpServer({
      server,
      listToolsSchema: LIST,
      callToolSchema: CALL,
      tools: [stubTool],
    });
    const res = await server.handlers.get(CALL)({ params: { name: 'kbx_stub', arguments: { v: 7 } } });
    assert.equal(res.content[0].text, 'got:7');
  });

  it('tools/call returns an isError UNKNOWN_TOOL for an unregistered name', async () => {
    const server = fakeServer();
    registerKbxMcpServer({
      server,
      listToolsSchema: LIST,
      callToolSchema: CALL,
      tools: [],
    });
    const res = await server.handlers.get(CALL)({ params: { name: 'nope' } });
    assert.equal(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.code, 'UNKNOWN_TOOL');
  });

  it('forwards toolOptions (execute seam) into the built tools', async () => {
    const server = fakeServer();
    const seen = [];
    registerKbxMcpServer({
      server,
      listToolsSchema: LIST,
      callToolSchema: CALL,
      toolOptions: {
        execute: async (name) => {
          seen.push(name);
          return { routed: name };
        },
      },
    });
    const res = await server.handlers.get(CALL)({ params: { name: 'kbx_audit', arguments: {} } });
    assert.deepEqual(seen, ['audit']);
    assert.match(res.content[0].text, /"routed": "audit"/);
  });
});

describe('mcp/server — end-to-end thin binding over the real registry', () => {
  it('kbx_audit executes through executeAffordance against the repo cwd', async () => {
    const server = fakeServer();
    registerKbxMcpServer({ server, listToolsSchema: LIST, callToolSchema: CALL });
    const res = await server.handlers.get(CALL)({ params: { name: 'kbx_audit', arguments: {} } });
    // audit is read-class: no consent prompt, real result shape returned.
    assert.ok(!res.isError, res.content?.[0]?.text);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(typeof payload, 'object');
  });
});
