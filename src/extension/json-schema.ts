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

type FieldDescriptor = {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
  minItems?: number;
  item?: FieldDescriptor;
  enum?: string[];
};

type SchemaDescriptor = {
  fields?: Record<string, FieldDescriptor>;
};

type JsonSchema = {
  type: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: JsonSchema | Record<string, never>;
  minItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * Translate a single {@link import('../affordances/contract.ts').FieldDescriptor}
 * into its JSON Schema fragment. Only the descriptor features the contract can
 * actually express are mapped; nothing is invented.
 *
 * @param {object} desc  A field descriptor from a schema's `fields`.
 * @returns {object} JSON Schema for that property.
 */
export function fieldToJsonSchema(desc: FieldDescriptor): JsonSchema {
  if (!desc || typeof desc !== 'object' || typeof desc.type !== 'string') {
    throw new TypeError('fieldToJsonSchema: descriptor must have a string "type"');
  }

  const schema: JsonSchema = { type: desc.type };

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
export function descriptorToJsonSchema(descriptor?: SchemaDescriptor) {
  const fields = descriptor?.fields ?? {};
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [name, desc] of Object.entries(fields)) {
    properties[name] = fieldToJsonSchema(desc);
    if (desc.required) required.push(name);
  }

  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema as {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties: false;
  };
}
