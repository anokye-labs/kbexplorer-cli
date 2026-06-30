import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  defineAffordance,
  defineSchema,
  validateInput,
  describeAffordance,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} = await import('../../src/affordances/contract.js');

describe('contract — validateInput', () => {
  it('applies defaults for absent fields', () => {
    const schema = defineSchema({ depth: { type: 'number', default: 1 } });
    const { ok, value } = validateInput(schema, {});
    assert.equal(ok, true);
    assert.equal(value.depth, 1);
  });

  it('flags required fields that are missing', () => {
    const schema = defineSchema({ id: { type: 'string', required: true } });
    const { ok, errors } = validateInput(schema, {});
    assert.equal(ok, false);
    assert.match(errors[0], /"id" is required/);
  });

  it('coerces numeric strings and clamps to min/max', () => {
    const schema = defineSchema({ depth: { type: 'number', min: 1, max: 4 } });
    assert.equal(validateInput(schema, { depth: '9' }).value.depth, 4);
    assert.equal(validateInput(schema, { depth: 0 }).value.depth, 1);
    assert.equal(validateInput(schema, { depth: 2 }).value.depth, 2);
  });

  it('coerces boolean strings', () => {
    const schema = defineSchema({ check: { type: 'boolean' } });
    assert.equal(validateInput(schema, { check: 'true' }).value.check, true);
    assert.equal(validateInput(schema, { check: 'false' }).value.check, false);
  });

  it('rejects a non-array for an array field', () => {
    const schema = defineSchema({ ids: { type: 'array', item: { type: 'string' } } });
    const { ok, errors } = validateInput(schema, { ids: 'x' });
    assert.equal(ok, false);
    assert.match(errors[0], /must be an array/);
  });

  it('enforces array minItems', () => {
    const schema = defineSchema({ ids: { type: 'array', item: { type: 'string' }, minItems: 1 } });
    const { ok, errors } = validateInput(schema, { ids: [] });
    assert.equal(ok, false);
    assert.match(errors[0], /at least 1 item/);
  });

  it('validates array element types', () => {
    const schema = defineSchema({ ids: { type: 'array', item: { type: 'string' } } });
    const { ok } = validateInput(schema, { ids: [1, 2] });
    assert.equal(ok, false);
  });

  it('enforces string enums', () => {
    const schema = defineSchema({ mode: { type: 'string', enum: ['a', 'b'] } });
    assert.equal(validateInput(schema, { mode: 'a' }).ok, true);
    assert.equal(validateInput(schema, { mode: 'c' }).ok, false);
  });

  it('drops unknown input keys (closed contract)', () => {
    const schema = defineSchema({ id: { type: 'string' } });
    const { value } = validateInput(schema, { id: 'x', extra: 'nope' });
    assert.deepEqual(value, { id: 'x' });
  });
});

describe('contract — defineSchema', () => {
  it('rejects unsupported field types', () => {
    assert.throws(() => defineSchema({ x: { type: 'bigint' } }), /unsupported type/);
  });
});

describe('contract — defineAffordance', () => {
  const base = {
    name: 'demo',
    summary: 'demo',
    actionClass: ACTION_CLASSES.READ,
    input: defineSchema({}),
    execute: () => ({}),
  };

  it('builds a frozen affordance with defaulted title', () => {
    const a = defineAffordance(base);
    assert.equal(a.name, 'demo');
    assert.equal(a.title, 'demo');
    assert.equal(Object.isFrozen(a), true);
  });

  it('requires a name', () => {
    assert.throws(() => defineAffordance({ ...base, name: '' }), /"name" is required/);
  });

  it('requires a valid action class', () => {
    assert.throws(() => defineAffordance({ ...base, actionClass: 'mutate' }), /actionClass/);
  });

  it('requires a schema-descriptor input', () => {
    assert.throws(() => defineAffordance({ ...base, input: {} }), /schema descriptor/);
  });

  it('requires an execute function', () => {
    assert.throws(() => defineAffordance({ ...base, execute: null }), /execute/);
  });
});

describe('contract — describeAffordance', () => {
  it('omits execute and exposes typed metadata', () => {
    const a = defineAffordance({
      name: 'demo',
      title: 'Demo',
      summary: 's',
      actionClass: ACTION_CLASSES.WRITE,
      input: defineSchema({ x: { type: 'string' } }),
      output: defineSchema({ y: { type: 'number' } }),
      execute: () => ({}),
    });
    const d = describeAffordance(a);
    assert.equal('execute' in d, false);
    assert.equal(d.actionClass, 'write');
    assert.ok(d.input.fields.x);
    assert.ok(d.output.fields.y);
  });
});

describe('contract — AffordanceError', () => {
  it('carries a code and serialises to JSON', () => {
    const err = new AffordanceError(ERROR_CODES.NOT_FOUND, 'missing', { id: 'x' });
    assert.equal(err.code, 'NOT_FOUND');
    assert.deepEqual(err.toJSON(), {
      error: true,
      code: 'NOT_FOUND',
      message: 'missing',
      details: { id: 'x' },
    });
  });
});
