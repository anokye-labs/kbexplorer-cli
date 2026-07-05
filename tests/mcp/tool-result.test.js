import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { successResult, errorResult } = await import('../../src/mcp/tool-result.ts');
const { AffordanceError, ERROR_CODES } = await import('../../src/affordances/contract.ts');

describe('mcp/tool-result — successResult', () => {
  it('wraps a value as a single text content block', () => {
    const r = successResult({ hits: [1, 2] });
    assert.deepEqual(r.content[0].type, 'text');
    assert.equal(JSON.parse(r.content[0].text).hits.length, 2);
    assert.ok(!('isError' in r));
  });

  it('emits an empty text block for undefined', () => {
    const r = successResult(undefined);
    assert.deepEqual(r, { content: [{ type: 'text', text: '' }] });
  });

  it('degrades gracefully on non-serialisable values (circular)', () => {
    const a = {};
    a.self = a;
    const r = successResult(a);
    assert.equal(r.content[0].type, 'text');
    assert.equal(typeof r.content[0].text, 'string');
  });
});

describe('mcp/tool-result — errorResult', () => {
  it('preserves an AffordanceError code + details via toJSON, marks isError', () => {
    const err = new AffordanceError(ERROR_CODES.INVALID_INPUT, 'bad', { errors: ['x'] });
    const r = errorResult(err);
    assert.equal(r.isError, true);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.code, ERROR_CODES.INVALID_INPUT);
    assert.deepEqual(payload.details.errors, ['x']);
  });

  it('maps a plain Error to EXECUTION_FAILED', () => {
    const r = errorResult(new Error('boom'));
    assert.equal(r.isError, true);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.code, 'EXECUTION_FAILED');
    assert.equal(payload.message, 'boom');
  });

  it('maps a thrown non-error to EXECUTION_FAILED', () => {
    const r = errorResult('nope');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /nope/);
  });
});
