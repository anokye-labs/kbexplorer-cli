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

import type { AffordanceContext } from './context.ts';

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
  /** A write/sample-class action was invoked but no approval seam is wired to
   *  obtain consent. Fail-closed: the action is refused rather than run silently
   *  (PE3-F3). */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** The approval seam was consulted and the user/host declined the action
   *  (PE3-F3). */
  CONSENT_DENIED: 'CONSENT_DENIED',
});

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

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

export type ActionClass = (typeof ACTION_CLASSES)[keyof typeof ACTION_CLASSES];

const VALID_ACTION_CLASSES = new Set<ActionClass>(Object.values(ACTION_CLASSES));

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface FieldDescriptor {
  type: FieldType;
  required?: boolean;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
  minItems?: number;
  item?: FieldDescriptor;
  enum?: string[];
}

export interface SchemaDescriptor {
  fields: Record<string, FieldDescriptor>;
}

export interface ConsentCost {
  kind?: 'sample' | 'none' | string;
  runtime?: string;
  model?: string;
  estimate?: string;
  generator?: string;
  [key: string]: unknown;
}

export interface ConsentDisclosure {
  credentials?: string[];
  writes?: string[];
  cost?: ConsentCost;
  [key: string]: unknown;
}

export interface ConsentDescriptor {
  credentials?: string[];
  cost?: ConsentCost;
  writes?: string[];
  disclose?: (
    input: Record<string, unknown>,
    context?: AffordanceContext,
  ) => ConsentDisclosure | null | undefined;
  readOnlyWhen?: (input: Record<string, unknown>) => boolean;
}

export interface Affordance<Output = unknown> {
  name: string;
  title: string;
  summary: string;
  actionClass: ActionClass;
  input: SchemaDescriptor;
  output?: SchemaDescriptor;
  consent?: Readonly<ConsentDescriptor>;
  execute: (context: AffordanceContext, input: Record<string, unknown>) => Promise<Output> | Output;
}

export interface AffordanceSpec<Output = unknown> {
  name: string;
  title?: string;
  summary: string;
  actionClass: ActionClass;
  input: SchemaDescriptor;
  output?: SchemaDescriptor;
  consent?: ConsentDescriptor;
  execute: (context: AffordanceContext, input: Record<string, unknown>) => Promise<Output> | Output;
}

export interface AffordanceDescription {
  name: string;
  title: string;
  summary: string;
  actionClass: ActionClass;
  input: SchemaDescriptor;
  output: SchemaDescriptor | null;
  consent: {
    credentials?: string[];
    cost?: ConsentCost;
    writes?: string[];
  } | null;
}

/**
 * A typed error raised by affordance validation/execution.
 *
 * @property {string} code  One of {@link ERROR_CODES}.
 * @property {object} [details]  Structured, serialisable diagnostic detail.
 */
export class AffordanceError extends Error {
  code: ErrorCode;
  details?: unknown;

  /**
   * @param {string} code     One of {@link ERROR_CODES}.
   * @param {string} message  Human-readable description.
   * @param {object} [details]  Structured, serialisable detail (e.g. field list).
   */
  constructor(code: ErrorCode, message: string, details: unknown = undefined) {
    super(message);
    this.name = 'AffordanceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  /** Serialisable shape for adapters that emit JSON error payloads. */
  toJSON(): { error: true; code: ErrorCode; message: string; details?: unknown } {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

// ── Schema descriptor + validation ──────────────────────────────────────────

const SUPPORTED_TYPES = new Set<FieldType>(['string', 'number', 'boolean', 'array', 'object']);

/**
 * Declare a transport-neutral input schema. Returned verbatim plus a marker so
 * adapters can recognise it; kept as a thin function for symmetry/forward-compat.
 *
 * @param {Record<string, FieldDescriptor>} fields
 * @returns {SchemaDescriptor}
 */
export function defineSchema(fields: Record<string, FieldDescriptor> = {}): SchemaDescriptor {
  for (const [name, desc] of Object.entries(fields)) {
    if (!desc || !SUPPORTED_TYPES.has(desc.type)) {
      throw new TypeError(`defineSchema: field "${name}" has unsupported type "${desc?.type}"`);
    }
    if (desc.type === 'array' && desc.item && !SUPPORTED_TYPES.has(desc.item.type)) {
      throw new TypeError(
        `defineSchema: field "${name}.item" has unsupported type "${desc.item.type}"`,
      );
    }
  }
  return { fields };
}

function coerceScalar(
  value: unknown,
  type: Extract<FieldType, 'string' | 'number' | 'boolean'>,
): string | number | boolean | undefined {
  if (type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function validateField(
  name: string,
  desc: FieldDescriptor,
  raw: unknown,
  errors: string[],
): unknown {
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
    const out: unknown[] = [];
    raw.forEach((el, i) => {
      if (desc.item) {
        const value = validateField(`${name}[${i}]`, desc.item, el, errors);
        if (value !== undefined) out.push(value);
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
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
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
    let numeric = coerced as number;
    if (typeof desc.min === 'number') numeric = Math.max(desc.min, numeric);
    if (typeof desc.max === 'number') numeric = Math.min(desc.max, numeric);
    return numeric;
  }
  if (desc.type === 'string' && Array.isArray(desc.enum) && !desc.enum.includes(coerced as string)) {
    errors.push(`"${name}" must be one of: ${desc.enum.join(', ')}`);
    return undefined;
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
export function validateInput(
  schema: SchemaDescriptor,
  input: Record<string, unknown> = {},
): { ok: boolean; value: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  const src =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : ({} as Record<string, unknown>);
  for (const [name, desc] of Object.entries(schema.fields)) {
    const fieldValue = validateField(name, desc, src[name], errors);
    if (fieldValue !== undefined) value[name] = fieldValue;
  }
  return { ok: errors.length === 0, value, errors };
}

// ── Affordance definition ───────────────────────────────────────────────────

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
 * @param {ConsentDescriptor} [spec.consent]
 * @param {(context: object, input: object) => Promise<*>|*} spec.execute
 * @returns {Affordance}
 */
export function defineAffordance<Output = unknown>(spec: AffordanceSpec<Output>): Affordance<Output> {
  const { name, title, summary, actionClass, input, output, consent, execute } = spec ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('defineAffordance: "name" is required');
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new TypeError(`defineAffordance(${name}): "summary" is required`);
  }
  if (!VALID_ACTION_CLASSES.has(actionClass)) {
    throw new TypeError(
      `defineAffordance(${name}): "actionClass" must be one of ${[...VALID_ACTION_CLASSES].join(', ')}`,
    );
  }
  if (!input || typeof input !== 'object' || !('fields' in input)) {
    throw new TypeError(`defineAffordance(${name}): "input" must be a schema descriptor`);
  }
  if (
    output !== undefined &&
    (typeof output !== 'object' || output === null || !('fields' in output))
  ) {
    throw new TypeError(`defineAffordance(${name}): "output" must be a schema descriptor`);
  }
  if (consent !== undefined && (typeof consent !== 'object' || consent === null)) {
    throw new TypeError(`defineAffordance(${name}): "consent" must be an object when provided`);
  }
  if (consent?.disclose !== undefined && typeof consent.disclose !== 'function') {
    throw new TypeError(`defineAffordance(${name}): "consent.disclose" must be a function`);
  }
  if (consent?.readOnlyWhen !== undefined && typeof consent.readOnlyWhen !== 'function') {
    throw new TypeError(`defineAffordance(${name}): "consent.readOnlyWhen" must be a function`);
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
    consent: consent ? Object.freeze({ ...consent }) : undefined,
    execute,
  });
}

/**
 * Serialise an affordance's contract metadata (everything except `execute`) into
 * a plain, transport-neutral object. This is what a delivery adapter introspects
 * to answer "what actions are available, with what typed inputs/outputs?".
 *
 * @param {Affordance} affordance
 * @returns {{name: string, title: string, summary: string, actionClass: string, input: SchemaDescriptor, output: SchemaDescriptor|null, consent: object|null}}
 */
export function describeAffordance(affordance: Affordance): AffordanceDescription {
  return {
    name: affordance.name,
    title: affordance.title,
    summary: affordance.summary,
    actionClass: affordance.actionClass,
    input: affordance.input,
    output: affordance.output ?? null,
    // Static disclosure only — the dynamic `disclose` function is intentionally
    // omitted (non-serialisable); adapters obtain input-derived disclosure at
    // call time via buildConsentRequest.
    consent: affordance.consent
      ? {
          ...(affordance.consent.credentials
            ? { credentials: affordance.consent.credentials }
            : {}),
          ...(affordance.consent.cost ? { cost: affordance.consent.cost } : {}),
          ...(affordance.consent.writes ? { writes: affordance.consent.writes } : {}),
        }
      : null,
  };
}
