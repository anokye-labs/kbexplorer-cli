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
import type { AffordanceContext } from './context.ts';
import type { ActionClass, AffordanceDescription } from './contract.ts';

interface JsonSerializableError {
  toJSON(): unknown;
  message?: string;
}

export interface ToolResultEnvelope {
  text: string;
  resultType: 'success';
}

export interface ToolErrorEnvelope {
  text: string;
  resultType: 'failure';
  error: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  actionClass: ActionClass;
  handler: (args: Record<string, unknown>) => Promise<ToolResultEnvelope | ToolErrorEnvelope | Record<string, unknown>>;
}

export interface BuildToolOptions {
  prefix?: string;
  execute?: (
    name: string,
    input: Record<string, unknown>,
    context?: AffordanceContext,
  ) => Promise<unknown> | unknown;
  contextFactory?: () => AffordanceContext;
  wrapSuccess?: (value: unknown) => Record<string, unknown>;
  wrapError?: (err: unknown) => Record<string, unknown>;
}

/** Human-readable, advisory consent hint per action class. */
export const ACTION_CLASS_HINT: Readonly<Record<ActionClass, string>> = Object.freeze({
  [ACTION_CLASSES.READ]: 'read-only: observes the graph/repo, no side effects',
  [ACTION_CLASSES.WRITE]: 'write: produces or mutates committed artifacts on disk',
  [ACTION_CLASSES.SAMPLE]: 'sample: assembles context to feed a model (no model call here)',
});

/** Stable JSON stringify with 2-space indent; tolerant of non-serialisable values. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasJsonSerializer(err: unknown): err is JsonSerializableError {
  return typeof err === 'object' && err !== null && typeof (err as JsonSerializableError).toJSON === 'function';
}

/**
 * Build the shared description text for a tool.
 *
 * @param {{ actionClass: string, title: string, summary: string }} described
 * @returns {string}
 */
export function buildToolDescription(
  described: Pick<AffordanceDescription, 'actionClass' | 'title' | 'summary'>,
): string {
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
export function buildToolResultEnvelope(value: unknown): ToolResultEnvelope {
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
export function buildToolErrorEnvelope(err: unknown): ToolErrorEnvelope {
  let payload: unknown;
  let message: string;

  if (hasJsonSerializer(err)) {
    payload = err.toJSON();
    message = err.message ?? String(err);
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
export function buildToolDefinition(
  described: AffordanceDescription,
  opts: BuildToolOptions = {},
): ToolDefinition {
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
    async handler(
      args: Record<string, unknown>,
    ): Promise<ToolResultEnvelope | ToolErrorEnvelope | Record<string, unknown>> {
      try {
        const result = await execute(name, args ?? {}, contextFactory());
        return wrapSuccess(result);
      } catch (err) {
        return wrapError(err);
      }
    },
  };
}
