import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildMcpTools, affordanceToMcpTool, toolNameFor, TOOL_PREFIX } = await import(
  '../../src/mcp/tools.js'
);
const { describeAffordances } = await import('../../src/affordances/index.js');

describe('mcp/tools — buildMcpTools', () => {
  it('produces one kbx_-prefixed tool per affordance, in canonical order', () => {
    const described = describeAffordances();
    const tools = buildMcpTools();
    assert.equal(tools.length, described.length);
    assert.ok(tools.every((t) => t.name.startsWith(TOOL_PREFIX)));
    assert.deepEqual(
      tools.map((t) => t.name),
      described.map((d) => toolNameFor(d.name))
    );
  });

  it('each tool exposes a JSON-Schema inputSchema (object, additionalProperties:false)', () => {
    for (const t of buildMcpTools()) {
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.inputSchema.additionalProperties, false);
    }
  });

  it('surfaces the action class advisorily in the description', () => {
    for (const t of buildMcpTools()) {
      assert.match(t.description, new RegExp(`^\\[${t.actionClass}\\]`));
    }
  });
});

describe('mcp/tools — affordanceToMcpTool handler', () => {
  const described = { name: 'search', title: 'Search', summary: 'find', actionClass: 'read', input: { fields: {} } };

  it('routes the handler through the execute seam and wraps success', async () => {
    const calls = [];
    const tool = affordanceToMcpTool(described, {
      execute: async (name, input, ctx) => {
        calls.push({ name, input, ctx });
        return { ok: 1 };
      },
      contextFactory: () => ({ marker: 'ctx' }),
    });
    const res = await tool.handler({ q: 'x' });
    assert.deepEqual(calls[0].name, 'search');
    assert.deepEqual(calls[0].input, { q: 'x' });
    assert.deepEqual(calls[0].ctx, { marker: 'ctx' });
    assert.equal(res.content[0].type, 'text');
    assert.ok(!res.isError);
  });

  it('maps a thrown error to an isError result', async () => {
    const tool = affordanceToMcpTool(described, {
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const res = await tool.handler({});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /kaboom/);
  });

  it('defaults args to {} when omitted', async () => {
    let seen;
    const tool = affordanceToMcpTool(described, {
      execute: async (_n, input) => {
        seen = input;
        return null;
      },
    });
    await tool.handler();
    assert.deepEqual(seen, {});
  });
});
