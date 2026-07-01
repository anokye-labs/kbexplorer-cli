import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { createKbxMcpServer, waitForClose, SERVER_NAME, SERVER_VERSION } = await import(
  '../../src/mcp/index.js'
);

const LIST = { __schema: 'list' };
const CALL = { __schema: 'call' };

class FakeServer {
  constructor(info, options) {
    this.info = info;
    this.options = options;
    this.handlers = new Map();
    this.elicitCalls = [];
  }
  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }
  getClientCapabilities() {
    return { elicitation: {} };
  }
  async elicitInput(params) {
    this.elicitCalls.push(params);
    return { action: 'accept' };
  }
}

describe('mcp/index — createKbxMcpServer', () => {
  it('throws without a Server constructor', () => {
    assert.throws(() => createKbxMcpServer({ listToolsSchema: LIST, callToolSchema: CALL }), TypeError);
  });

  it('constructs the Server with identity + tools capability and registers handlers', () => {
    let constructed;
    class Spy extends FakeServer {
      constructor(info, options) {
        super(info, options);
        constructed = this;
      }
    }
    const { server, tools } = createKbxMcpServer({
      Server: Spy,
      listToolsSchema: LIST,
      callToolSchema: CALL,
    });
    assert.equal(server, constructed);
    assert.equal(constructed.info.name, SERVER_NAME);
    assert.equal(constructed.info.version, SERVER_VERSION);
    assert.deepEqual(constructed.options.capabilities.tools, {});
    assert.ok(tools.length > 0);
    assert.equal(typeof constructed.handlers.get(LIST), 'function');
    assert.equal(typeof constructed.handlers.get(CALL), 'function');
  });

  it('honours an overridden server name', () => {
    const { server } = createKbxMcpServer({
      Server: FakeServer,
      listToolsSchema: LIST,
      callToolSchema: CALL,
      name: 'custom-kb',
    });
    assert.equal(server.info.name, 'custom-kb');
  });

  it('read-class tools execute without any elicitation round-trip', async () => {
    const { server } = createKbxMcpServer({
      Server: FakeServer,
      listToolsSchema: LIST,
      callToolSchema: CALL,
      cwd: process.cwd(),
    });
    const res = await server.handlers.get(CALL)({ params: { name: 'kbx_audit', arguments: {} } });
    assert.ok(!res.isError);
    assert.equal(server.elicitCalls.length, 0);
  });
});

describe('mcp/index — waitForClose', () => {
  it('settles on stdin end', async () => {
    const stdin = new EventEmitter();
    const proc = new EventEmitter();
    const server = {};
    const p = waitForClose(server, { stdin, proc });
    stdin.emit('end');
    await p;
    assert.ok(true);
  });

  it('settles on server.onclose and preserves a prior onclose', async () => {
    let prior = false;
    const server = { onclose: () => (prior = true) };
    const proc = new EventEmitter();
    const stdin = new EventEmitter();
    const p = waitForClose(server, { stdin, proc });
    server.onclose();
    await p;
    assert.equal(prior, true);
  });

  it('settles on SIGINT', async () => {
    const stdin = new EventEmitter();
    const proc = new EventEmitter();
    const p = waitForClose({}, { stdin, proc });
    proc.emit('SIGINT');
    await p;
    assert.ok(true);
  });
});
