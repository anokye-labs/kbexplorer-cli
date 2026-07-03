import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { TOOL_PREFIX, toolNameFor, affordanceToTool, buildAffordanceTools } =
  await import('../../src/extension/tools.js');
const { describeAffordances, ACTION_CLASSES, ERROR_CODES } =
  await import('../../src/affordances/index.js');

const EXPECTED = [
  'search',
  'query_node',
  'graph_neighbors',
  'trace',
  'affected',
  'audit',
  'llm_context',
  'derive',
  // Job layer (PE3-F2) — picked up generically by the adapter, no source changes.
  'start_generate',
  'get_job_status',
  'cancel_job',
  'preview_changes',
  'apply_changes',
  'create_pr',
];

describe('affordance → tool binding', () => {
  it('toolNameFor namespaces with the kbx_ prefix', () => {
    assert.equal(TOOL_PREFIX, 'kbx_');
    assert.equal(toolNameFor('search'), 'kbx_search');
  });

  it('exposes every affordance as a tool, in canonical order', () => {
    const tools = buildAffordanceTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      EXPECTED.map(toolNameFor)
    );
    assert.equal(tools.length, EXPECTED.length);
  });

  it('enumerates the same affordance set as the MCP host', async () => {
    const { buildMcpTools } = await import('../../src/mcp/tools.js');
    assert.deepEqual(buildAffordanceTools().map((t) => t.name), buildMcpTools().map((t) => t.name));
  });

  it('each tool has a JSON-Schema parameters object derived from the contract', () => {
    const byName = Object.fromEntries(describeAffordances().map((d) => [d.name, d]));
    for (const tool of buildAffordanceTools()) {
      const affName = tool.name.slice(TOOL_PREFIX.length);
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.additionalProperties, false);
      // Property keys match the contract's declared input fields.
      assert.deepEqual(
        Object.keys(tool.parameters.properties).sort(),
        Object.keys(byName[affName].input.fields).sort()
      );
    }
  });

  it('surfaces the action class as advisory metadata (field + description)', () => {
    const byName = Object.fromEntries(buildAffordanceTools().map((t) => [t.name, t]));
    assert.equal(byName.kbx_query_node.actionClass, ACTION_CLASSES.READ);
    assert.equal(byName.kbx_derive.actionClass, ACTION_CLASSES.WRITE);
    assert.equal(byName.kbx_llm_context.actionClass, ACTION_CLASSES.SAMPLE);
    assert.match(byName.kbx_derive.description, /^\[write\]/);
  });

  it('handler routes to the injected registry executor with (name, args, context)', async () => {
    const calls = [];
    const ctx = { sentinel: true };
    const tool = affordanceToTool(
      describeAffordances().find((d) => d.name === 'search'),
      {
        execute: async (name, input, context) => {
          calls.push({ name, input, context });
          return { ok: true, echoed: input };
        },
        contextFactory: () => ctx,
      }
    );

    const res = await tool.handler({ query: 'hello' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'search');
    assert.deepEqual(calls[0].input, { query: 'hello' });
    assert.equal(calls[0].context, ctx);
    assert.equal(res.resultType, 'success');
    assert.deepEqual(JSON.parse(res.textResultForLlm), { ok: true, echoed: { query: 'hello' } });
  });

  it('maps a thrown AffordanceError to a failure tool result', async () => {
    const { AffordanceError } = await import('../../src/affordances/contract.js');
    const tool = affordanceToTool(describeAffordances()[0], {
      execute: () => {
        throw new AffordanceError(ERROR_CODES.UNSUPPORTED, 'no engine');
      },
    });
    const res = await tool.handler({});
    assert.equal(res.resultType, 'failure');
    assert.equal(res.error, 'no engine');
    assert.equal(JSON.parse(res.textResultForLlm).code, ERROR_CODES.UNSUPPORTED);
  });

  it('routes into the REAL registry by default — invalid input yields INVALID_INPUT', async () => {
    // query_node requires an `id`; calling with no args must flow through the
    // real executeAffordance validation and come back as a typed failure.
    const tool = buildAffordanceTools().find((t) => t.name === 'kbx_query_node');
    const res = await tool.handler({});
    assert.equal(res.resultType, 'failure');
    assert.equal(JSON.parse(res.textResultForLlm).code, ERROR_CODES.INVALID_INPUT);
  });
});
