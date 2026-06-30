/**
 * Affordance action contract — the protocol-neutral DO-seam (PE3-F1).
 *
 * An **affordance** answers a single question: *"given this context, what action
 * is available, with what typed inputs and outputs?"* It is a pure action
 * contract over kbexplorer-core / CLI types. It knows **nothing** about MCP,
 * JSON-RPC, canvases, or any transport — those concerns belong to the separate
 * delivery adapters (extension-tool PE3-F5, MCP PE3-F4) that bind to this
 * contract. The dependency arrow is always `affordances → {adapters}`, never
 * `affordances → transport`.
 *
 * This module defines the contract primitives only — no registry, no operations,
 * no I/O:
 *
 *   - {@link defineAffordance} — declare one action contract (name, classes,
 *     typed input/output descriptors, and a context-in/result-out `execute`).
 *   - {@link validateInput} — coerce + validate a raw input object against a
 *     transport-neutral schema descriptor (defaults, required, clamping).
 *   - {@link AffordanceError} + {@link ERROR_CODES} — a typed error surface every
 *     adapter can map to its own protocol error shape.
 *   - {@link ACTION_CLASSES} — read / write / sample classification used later by
 *     the consent layer (PE3-F3). Purely advisory metadata here.
 *
 * The schema descriptor is intentionally minimal and declarative so adapters can
 * translate it into whatever their protocol needs (zod for MCP, JSON-Schema /
 * tool-input schema for the extension-tool adapter) without this module taking a
 * dependency on any of them.
 *
 * @module src/affordances/contract
 */

/**
 * Stable, machine-readable error codes for affordance execution. Adapters map
 * these to their own protocol error shapes; nothing here is transport-specific.
 *
 * @enum {string}
 */
export const ERROR_CODES = Object.freeze({
  /** Input failed schema validation (missing/typed-wrong/out-of-range field). */
  INVALID_INPUT: 'INVALID_INPUT',
  /** A referenced entity (node id, source file, …) does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The action is recognised but cannot run in the current environment
   *  (e.g. a fuzzy extractor/runtime the contract deliberately does not own). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A required pre-built artifact is absent (e.g. semantic-search index). */
  MISSING_ARTIFACT: 'MISSING_ARTIFACT',
  /** The action ran but its underlying logic threw. */
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  /** No affordance is registered under the requested name. */
  UNKNOWN_AFFORDANCE: 'UNKNOWN_AFFORDANCE',
});

/**
 * Action classes for consent/provenance reasoning (PE3-F3). Advisory metadata on
 * the contract — the contract itself enforces nothing.
 *
 *   - `read`   — observes the graph / repo, no side effects.
 *   - `write`  — produces or mutates committed artifacts on disk.
 *   - `sample` — assembles context intended to be fed to a model (the grounding
 *                bundle); the *contract* never calls a model itself.
 *
 * @enum {string}
 */
export const ACTION_CLASSES = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  SAMPLE: 'sample',
});

const VALID_ACTION_CLASSES = new Set(Object.values(ACTION_CLASSES));

/**
 * A typed error raised by affordance validation/execution.
 *
 * @property {string} code  One of {@link ERROR_CODES}.
 * @property {object} [details]  Structured, serialisable diagnostic detail.
 */
export class AffordanceError extends Error {
  /**
   * @param {string} code     One of {@link ERROR_CODES}.
   * @param {string} message  Human-readable description.
   * @param {object} [details]  Structured, serialisable detail (e.g. field list).
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AffordanceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  /** Serialisable shape for adapters that emit JSON error payloads. */
  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

// ── Schema descriptor + validation ──────────────────────────────────────────

const SUPPORTED_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

/**
 * @typedef {object} FieldDescriptor
 * @property {'string'|'number'|'boolean'|'array'|'object'} type
 * @property {boolean} [required=false]
 * @property {*} [default]            Applied when the field is absent.
 * @property {string} [description]
 * @property {number} [min]           Numeric lower clamp (inclusive).
 * @property {number} [max]           Numeric upper clamp (inclusive).
 * @property {number} [minItems]      Array minimum length.
 * @property {FieldDescriptor} [item] Element descriptor for `type: 'array'`.
 * @property {string[]} [enum]        Allowed string values.
 *
 * @typedef {object} SchemaDescriptor
 * @property {Record<string, FieldDescriptor>} fields
 */

/**
 * Declare a transport-neutral input schema. Returned verbatim plus a marker so
 * adapters can recognise it; kept as a thin function for symmetry/forward-compat.
 *
 * @param {Record<string, FieldDescriptor>} fields
 * @returns {SchemaDescriptor}
 */
export function defineSchema(fields = {}) {
  for (const [name, desc] of Object.entries(fields)) {
    if (!desc || !SUPPORTED_TYPES.has(desc.type)) {
      throw new TypeError(`defineSchema: field "${name}" has unsupported type "${desc?.type}"`);
    }
    if (desc.type === 'array' && desc.item && !SUPPORTED_TYPES.has(desc.item.type)) {
      throw new TypeError(
        `defineSchema: field "${name}.item" has unsupported type "${desc.item.type}"`
      );
    }
  }
  return { fields };
}

function coerceScalar(value, type) {
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  if (type === 'string') {
    return typeof value === 'string' ? value : undefined;
  }
  return value;
}

function validateField(name, desc, raw, errors) {
  if (raw === undefined || raw === null) {
    if (desc.default !== undefined) return desc.default;
    if (desc.required) errors.push(`"${name}" is required`);
    return undefined;
  }

  if (desc.type === 'array') {
    if (!Array.isArray(raw)) {
      errors.push(`"${name}" must be an array`);
      return undefined;
    }
    const out = [];
    raw.forEach((el, i) => {
      if (desc.item) {
        const v = validateField(`${name}[${i}]`, desc.item, el, errors);
        if (v !== undefined) out.push(v);
      } else {
        out.push(el);
      }
    });
    if (typeof desc.minItems === 'number' && out.length < desc.minItems) {
      errors.push(`"${name}" must have at least ${desc.minItems} item(s)`);
    }
    return out;
  }

  if (desc.type === 'object') {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`"${name}" must be an object`);
      return undefined;
    }
    return raw;
  }

  const coerced = coerceScalar(raw, desc.type);
  if (coerced === undefined) {
    errors.push(`"${name}" must be a ${desc.type}`);
    return undefined;
  }
  if (desc.type === 'number') {
    let n = coerced;
    if (typeof desc.min === 'number') n = Math.max(desc.min, n);
    if (typeof desc.max === 'number') n = Math.min(desc.max, n);
    return n;
  }
  if (desc.type === 'string') {
    if (Array.isArray(desc.enum) && !desc.enum.includes(coerced)) {
      errors.push(`"${name}" must be one of: ${desc.enum.join(', ')}`);
      return undefined;
    }
  }
  return coerced;
}

/**
 * Validate + coerce a raw input object against a {@link SchemaDescriptor}.
 *
 * Applies defaults for absent fields, coerces scalar types, clamps numbers to
 * `min`/`max`, enforces `required`, `enum`, and array `minItems`. Unknown input
 * keys are dropped (the contract is closed by construction). Never throws on bad
 * input — returns `{ ok: false, errors }` so the caller decides how to surface.
 *
 * @param {SchemaDescriptor} schema
 * @param {object} [input={}]
 * @returns {{ ok: boolean, value: object, errors: string[] }}
 */
export function validateInput(schema, input = {}) {
  const errors = [];
  const value = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [name, desc] of Object.entries(schema?.fields ?? {})) {
    const v = validateField(name, desc, src[name], errors);
    if (v !== undefined) value[name] = v;
  }
  return { ok: errors.length === 0, value, errors };
}

// ── Affordance definition ───────────────────────────────────────────────────

/**
 * @typedef {object} Affordance
 * @property {string} name          Stable identifier (snake_case operation name).
 * @property {string} title         Short human label.
 * @property {string} summary       One-line description of the action.
 * @property {'read'|'write'|'sample'} actionClass  Consent classification.
 * @property {SchemaDescriptor} input   Typed input contract.
 * @property {SchemaDescriptor} [output]  Advisory output shape (documentation).
 * @property {(context: object, input: object) => Promise<*>|*} execute
 *           Pure-of-protocol handler: typed context in, typed result out.
 */

/**
 * Declare a single affordance (action contract). Validates the declaration shape
 * eagerly so registration errors surface at module load, not at call time.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} [spec.title]
 * @param {string} spec.summary
 * @param {'read'|'write'|'sample'} spec.actionClass
 * @param {SchemaDescriptor} spec.input
 * @param {SchemaDescriptor} [spec.output]
 * @param {(context: object, input: object) => Promise<*>|*} spec.execute
 * @returns {Affordance}
 */
export function defineAffordance(spec) {
  const { name, title, summary, actionClass, input, output, execute } = spec ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('defineAffordance: "name" is required');
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new TypeError(`defineAffordance(${name}): "summary" is required`);
  }
  if (!VALID_ACTION_CLASSES.has(actionClass)) {
    throw new TypeError(
      `defineAffordance(${name}): "actionClass" must be one of ${[...VALID_ACTION_CLASSES].join(', ')}`
    );
  }
  if (!input || typeof input !== 'object' || !input.fields) {
    throw new TypeError(`defineAffordance(${name}): "input" must be a schema descriptor`);
  }
  if (typeof execute !== 'function') {
    throw new TypeError(`defineAffordance(${name}): "execute" must be a function`);
  }
  return Object.freeze({
    name,
    title: title ?? name,
    summary,
    actionClass,
    input,
    output: output ?? undefined,
    execute,
  });
}

/**
 * Serialise an affordance's contract metadata (everything except `execute`) into
 * a plain, transport-neutral object. This is what a delivery adapter introspects
 * to answer "what actions are available, with what typed inputs/outputs?".
 *
 * @param {Affordance} affordance
 * @returns {{name: string, title: string, summary: string, actionClass: string, input: SchemaDescriptor, output: SchemaDescriptor|null}}
 */
export function describeAffordance(affordance) {
  return {
    name: affordance.name,
    title: affordance.title,
    summary: affordance.summary,
    actionClass: affordance.actionClass,
    input: affordance.input,
    output: affordance.output ?? null,
  };
}
