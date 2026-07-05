/**
 * Schema bridge — transport-neutral {@link SchemaDescriptor} → JSON Schema.
 *
 * The affordance contract (PE3-F1) declares its inputs with a minimal,
 * declarative {@link import('../affordances/contract.ts').SchemaDescriptor}
 * (`{ fields: { name: { type, required, default, min, max, enum, item, … } } }`).
 * The Copilot CLI extension `tools` surface wants a JSON Schema for each tool's
 * `parameters`. This module is the pure, dependency-free translation between the
 * two — it is the extension-tool adapter's half of the `affordances → adapter`
 * arrow, and imports neither the SDK nor any transport.
 *
 * @module src/extension/json-schema
 */

/**
 * Translate a single {@link import('../affordances/contract.ts').FieldDescriptor}
 * into its JSON Schema fragment. Only the descriptor features the contract can
 * actually express are mapped; nothing is invented.
 *
 * @param {object} desc  A field descriptor from a schema's `fields`.
 * @returns {object} JSON Schema for that property.
 */
export function fieldToJsonSchema(desc) {
  if (!desc || typeof desc !== 'object' || typeof desc.type !== 'string') {
    throw new TypeError('fieldToJsonSchema: descriptor must have a string "type"');
  }

  /** @type {Record<string, unknown>} */
  const schema = { type: desc.type };

  if (typeof desc.description === 'string') schema.description = desc.description;
  if (desc.default !== undefined) schema.default = desc.default;

  if (desc.type === 'number') {
    if (typeof desc.min === 'number') schema.minimum = desc.min;
    if (typeof desc.max === 'number') schema.maximum = desc.max;
  }

  if (desc.type === 'string' && Array.isArray(desc.enum)) {
    schema.enum = [...desc.enum];
  }

  if (desc.type === 'array') {
    schema.items = desc.item ? fieldToJsonSchema(desc.item) : {};
    if (typeof desc.minItems === 'number') schema.minItems = desc.minItems;
  }

  return schema;
}

/**
 * Translate a whole {@link import('../affordances/contract.ts').SchemaDescriptor}
 * into a JSON Schema object suitable for a tool's `parameters`. The contract is
 * closed by construction (unknown input keys are dropped at validation time), so
 * the emitted schema is `additionalProperties: false`.
 *
 * @param {{ fields?: Record<string, object> }} [descriptor]
 * @returns {{ type: 'object', properties: Record<string, object>, required?: string[], additionalProperties: false }}
 */
export function descriptorToJsonSchema(descriptor) {
  const fields = descriptor?.fields ?? {};
  /** @type {Record<string, object>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];

  for (const [name, desc] of Object.entries(fields)) {
    properties[name] = fieldToJsonSchema(desc);
    if (desc.required) required.push(name);
  }

  /** @type {Record<string, unknown>} */
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return /** @type {any} */ (schema);
}
