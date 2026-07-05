/**
 * Shared affordance tool bridge — transport-neutral affordance → tool mapping.
 *
 * This module is the single seam that both delivery adapters share for the
 * affordance contract. It centralises the advisory action-class hint, tool
 * description rendering, and the common handler plumbing (validate/execute,
 * context factory, result wrapping), while the host shims remain responsible for
 * the wire-specific schema field name and result envelope framing.
 *
 * @module src/affordances/tool-bridge
 */

import { executeAffordance, createAffordanceContext, ACTION_CLASSES } from './index.ts';
import { descriptorToJsonSchema } from '../extension/json-schema.ts';

/** Human-readable, advisory consent hint per action class. */
export const ACTION_CLASS_HINT = Object.freeze({
  [ACTION_CLASSES.READ]: 'read-only: observes the graph/repo, no side effects',
  [ACTION_CLASSES.WRITE]: 'write: produces or mutates committed artifacts on disk',
  [ACTION_CLASSES.SAMPLE]: 'sample: assembles context to feed a model (no model call here)',
});

/** Stable JSON stringify with 2-space indent; tolerant of non-serialisable values. */
function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Build the shared description text for a tool.
 *
 * @param {{ actionClass: string, title: string, summary: string }} described
 * @returns {string}
 */
export function buildToolDescription(described) {
  const { title, summary, actionClass } = described;
  const hint = ACTION_CLASS_HINT[actionClass] ?? actionClass;
  return `[${actionClass}] ${title} — ${summary} (${hint})`;
}

/**
 * Build a neutral, host-agnostic result envelope for a successful execution.
 *
 * @param {*} value
 * @returns {{ text: string, resultType: 'success' }}
 */
export function buildToolResultEnvelope(value) {
  return {
    text: value === undefined ? '' : stringify(value),
    resultType: 'success',
  };
}

/**
 * Build a neutral, host-agnostic result envelope for a failed execution.
 *
 * @param {unknown} err
 * @returns {{ text: string, resultType: 'failure', error: string }}
 */
export function buildToolErrorEnvelope(err) {
  let payload;
  let message;

  if (err && typeof err === 'object' && typeof /** @type {any} */ (err).toJSON === 'function') {
    payload = /** @type {any} */ (err).toJSON();
    message = /** @type {any} */ (err).message ?? String(err);
  } else if (err instanceof Error) {
    payload = { error: true, code: 'EXECUTION_FAILED', message: err.message };
    message = err.message;
  } else {
    message = String(err);
    payload = { error: true, code: 'EXECUTION_FAILED', message };
  }

  return {
    text: stringify(payload),
    resultType: 'failure',
    error: message,
  };
}

/**
 * Build a host-neutral tool definition with the shared handler logic.
 *
 * @param {ReturnType<typeof import('./index.ts').describeAffordances>[number]} described
 * @param {object} [opts]
 * @param {string} [opts.prefix='kbx_']
 * @param {(name: string, input: object, context?: object) => Promise<*>|*} [opts.execute]
 * @param {() => object} [opts.contextFactory]
 * @param {(value: *) => object} [opts.wrapSuccess]
 * @param {(err: unknown) => object} [opts.wrapError]
 * @returns {{ name: string, description: string, inputSchema: object, actionClass: string, handler: (args: object) => Promise<object> }}
 */
export function buildToolDefinition(described, opts = {}) {
  const {
    prefix = 'kbx_',
    execute = executeAffordance,
    contextFactory = createAffordanceContext,
    wrapSuccess = buildToolResultEnvelope,
    wrapError = buildToolErrorEnvelope,
  } = opts;
  const { name, actionClass } = described;

  return {
    name: `${prefix}${name}`,
    description: buildToolDescription(described),
    inputSchema: descriptorToJsonSchema(described.input),
    actionClass,
    async handler(args) {
      try {
        const result = await execute(name, args ?? {}, contextFactory());
        return wrapSuccess(result);
      } catch (err) {
        return wrapError(err);
      }
    },
  };
}
