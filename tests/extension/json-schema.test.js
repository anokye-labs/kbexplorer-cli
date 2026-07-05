import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { fieldToJsonSchema, descriptorToJsonSchema } =
  await import('../../src/extension/json-schema.ts');
const { defineSchema } = await import('../../src/affordances/contract.ts');

describe('json-schema bridge', () => {
  it('maps scalar fields with description and default', () => {
    const s = fieldToJsonSchema({ type: 'string', description: 'q', default: 'x' });
    assert.deepEqual(s, { type: 'string', description: 'q', default: 'x' });
  });

  it('maps number min/max to minimum/maximum', () => {
    const s = fieldToJsonSchema({ type: 'number', min: 1, max: 5 });
    assert.deepEqual(s, { type: 'number', minimum: 1, maximum: 5 });
  });

  it('maps string enum', () => {
    const s = fieldToJsonSchema({ type: 'string', enum: ['a', 'b'] });
    assert.deepEqual(s, { type: 'string', enum: ['a', 'b'] });
  });

  it('maps array with item descriptor and minItems', () => {
    const s = fieldToJsonSchema({ type: 'array', item: { type: 'string' }, minItems: 2 });
    assert.deepEqual(s, { type: 'array', items: { type: 'string' }, minItems: 2 });
  });

  it('rejects a descriptor without a string type', () => {
    assert.throws(() => fieldToJsonSchema({}), TypeError);
    assert.throws(() => fieldToJsonSchema(null), TypeError);
  });

  it('builds an object schema with required + additionalProperties:false', () => {
    const descriptor = defineSchema({
      query: { type: 'string', required: true, description: 'the q' },
      limit: { type: 'number', default: 5, min: 1 },
    });
    const schema = descriptorToJsonSchema(descriptor);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['query']);
    assert.deepEqual(schema.properties.query, { type: 'string', description: 'the q' });
    assert.deepEqual(schema.properties.limit, { type: 'number', default: 5, minimum: 1 });
  });

  it('omits the required array entirely when no field is required', () => {
    const schema = descriptorToJsonSchema(defineSchema({ a: { type: 'string' } }));
    assert.equal('required' in schema, false);
  });

  it('tolerates an empty / missing descriptor', () => {
    assert.deepEqual(descriptorToJsonSchema(), {
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});
