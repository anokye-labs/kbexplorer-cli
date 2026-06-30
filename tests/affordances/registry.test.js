import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  listAffordances,
  getAffordance,
  hasAffordance,
  describeAffordances,
  executeAffordance,
  createAffordanceContext,
  ERROR_CODES,
  ACTION_CLASSES,
} = await import('../../src/affordances/index.js');

const EXPECTED = [
  'search',
  'query_node',
  'graph_neighbors',
  'affected',
  'audit',
  'llm_context',
  'derive',
  'start_generate',
  'get_job_status',
  'cancel_job',
  'preview_changes',
  'apply_changes',
  'create_pr',
];

describe('registry', () => {
  it('exposes the do-seam operations in canonical order', () => {
    assert.deepEqual(
      listAffordances().map((a) => a.name),
      EXPECTED
    );
  });

  it('getAffordance / hasAffordance resolve by name', () => {
    assert.equal(hasAffordance('audit'), true);
    assert.equal(hasAffordance('nope'), false);
    assert.equal(getAffordance('audit').name, 'audit');
    assert.equal(getAffordance('nope'), undefined);
  });

  it('describeAffordances yields serialisable, execute-free contracts', () => {
    const described = describeAffordances();
    assert.equal(described.length, EXPECTED.length);
    for (const d of described) {
      assert.equal('execute' in d, false);
      assert.ok(d.input.fields);
      assert.ok(Object.values(ACTION_CLASSES).includes(d.actionClass));
      // Round-trips through JSON unchanged (no functions / non-serialisable bits).
      assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
    }
  });

  it('classifies action classes correctly', () => {
    const byName = Object.fromEntries(describeAffordances().map((d) => [d.name, d.actionClass]));
    assert.equal(byName.query_node, 'read');
    assert.equal(byName.llm_context, 'sample');
    assert.equal(byName.derive, 'write');
  });

  it('executeAffordance throws UNKNOWN_AFFORDANCE for an unregistered name', async () => {
    await assert.rejects(
      () => executeAffordance('teleport', {}),
      (e) =>
        e.code === ERROR_CODES.UNKNOWN_AFFORDANCE && e.details.available.length === EXPECTED.length
    );
  });

  it('executeAffordance validates input before running the handler', async () => {
    await assert.rejects(
      () => executeAffordance('query_node', {}, createAffordanceContext()),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
  });

  it('the do-seam is free of transport coupling', async () => {
    // The contract must never import MCP / JSON-RPC. Assert by scanning the
    // module source graph entrypoints for forbidden imports.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname, join } = await import('node:path');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'affordances');
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(root);
    const importRe =
      /(?:^|\n)\s*(?:import\b[^\n]*?from\s*|import\s*\(|(?:const|let|var)\s+[^\n=]*=\s*require\()\s*['"]([^'"]+)['"]/g;
    const forbidden = /modelcontextprotocol|json-?rpc|StdioServerTransport|server\/mcp/i;
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      let m;
      while ((m = importRe.exec(src)) !== null) {
        assert.doesNotMatch(m[1], forbidden, `${f} imports a transport: ${m[1]}`);
      }
    }
  });
});
