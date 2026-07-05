import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { successResult, errorResult } = await import('../../src/extension/tool-result.ts');
const { AffordanceError, ERROR_CODES } = await import('../../src/affordances/contract.ts');

describe('tool-result bridge', () => {
  it('wraps a value as a success result (pretty JSON)', () => {
    const r = successResult({ a: 1 });
    assert.equal(r.resultType, 'success');
    assert.deepEqual(JSON.parse(r.textResultForLlm), { a: 1 });
  });

  it('represents undefined as an empty success body', () => {
    assert.deepEqual(successResult(undefined), { textResultForLlm: '', resultType: 'success' });
  });

  it('maps an AffordanceError to a typed failure via toJSON', () => {
    const err = new AffordanceError(ERROR_CODES.INVALID_INPUT, 'bad input', { errors: ['x'] });
    const r = errorResult(err);
    assert.equal(r.resultType, 'failure');
    assert.equal(r.error, 'bad input');
    const payload = JSON.parse(r.textResultForLlm);
    assert.equal(payload.code, ERROR_CODES.INVALID_INPUT);
    assert.deepEqual(payload.details, { errors: ['x'] });
    assert.equal(payload.error, true);
  });

  it('maps a plain Error to a generic failure', () => {
    const r = errorResult(new Error('boom'));
    assert.equal(r.resultType, 'failure');
    assert.equal(r.error, 'boom');
    assert.equal(JSON.parse(r.textResultForLlm).code, 'EXECUTION_FAILED');
  });

  it('tolerates a non-Error throw', () => {
    const r = errorResult('nope');
    assert.equal(r.resultType, 'failure');
    assert.equal(r.error, 'nope');
  });
});
