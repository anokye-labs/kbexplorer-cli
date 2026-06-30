/**
 * Affordance registry — the assembled, protocol-neutral DO-seam (PE3-F1).
 *
 * Collects the seven graph operations into a single contract surface that both
 * delivery adapters bind to:
 *
 *   search · query_node · graph_neighbors · affected · audit · llm_context · derive
 *
 * The registry is the spine of the dependency arrow `affordances → {adapters}`.
 * It exposes:
 *
 *   - {@link listAffordances} / {@link getAffordance} / {@link hasAffordance}
 *   - {@link describeAffordances} — serialisable contract catalogue an adapter
 *     introspects to answer "what actions are available, with what typed
 *     inputs/outputs?" (the extension-tool adapter turns these into `tools`;
 *     the MCP adapter turns them into MCP tool registrations).
 *   - {@link executeAffordance} — validate input against the contract, run the
 *     handler with the given context, and surface failures as typed
 *     {@link AffordanceError}s.
 *
 * Nothing here imports MCP, JSON-RPC, or any canvas/transport code.
 *
 * @module src/affordances
 */

import {
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
  validateInput,
  describeAffordance,
} from './contract.js';
import { createAffordanceContext } from './context.js';
import search from './operations/search.js';
import queryNode from './operations/query-node.js';
import graphNeighbors from './operations/graph-neighbors.js';
import affected from './operations/affected.js';
import audit from './operations/audit.js';
import llmContext from './operations/llm-context.js';
import derive from './operations/derive.js';

/** Canonical ordering of the do-seam operations. */
const AFFORDANCE_LIST = Object.freeze([
  search,
  queryNode,
  graphNeighbors,
  affected,
  audit,
  llmContext,
  derive,
]);

const AFFORDANCES = new Map(AFFORDANCE_LIST.map((a) => [a.name, a]));

/** All affordances in canonical order. */
export function listAffordances() {
  return [...AFFORDANCE_LIST];
}

/** Look up one affordance by name (undefined when absent). */
export function getAffordance(name) {
  return AFFORDANCES.get(name);
}

/** Whether an affordance is registered under `name`. */
export function hasAffordance(name) {
  return AFFORDANCES.has(name);
}

/**
 * Serialisable contract catalogue (metadata only — no `execute`). This is the
 * introspection surface adapters consume.
 *
 * @returns {Array<ReturnType<typeof describeAffordance>>}
 */
export function describeAffordances() {
  return AFFORDANCE_LIST.map((a) => describeAffordance(a));
}

/**
 * Execute an affordance by name: validate the raw input against the contract,
 * then run the handler with `context`.
 *
 * @param {string} name           Affordance name.
 * @param {object} [input={}]     Raw input (validated/coerced against the schema).
 * @param {object} [context]      An {@link createAffordanceContext} result. When
 *        omitted a default context over `process.cwd()` is created.
 * @returns {Promise<*>} The affordance's typed result.
 * @throws {AffordanceError} UNKNOWN_AFFORDANCE / INVALID_INPUT / or a typed
 *         failure raised by the handler.
 */
export async function executeAffordance(name, input = {}, context = undefined) {
  const affordance = AFFORDANCES.get(name);
  if (!affordance) {
    throw new AffordanceError(ERROR_CODES.UNKNOWN_AFFORDANCE, `Unknown affordance: ${name}`, {
      available: [...AFFORDANCES.keys()],
    });
  }

  const { ok, value, errors } = validateInput(affordance.input, input);
  if (!ok) {
    throw new AffordanceError(
      ERROR_CODES.INVALID_INPUT,
      `Invalid input for "${name}": ${errors.join('; ')}`,
      {
        errors,
      }
    );
  }

  const ctx = context ?? createAffordanceContext();
  return affordance.execute(ctx, value);
}

export {
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
  createAffordanceContext,
  describeAffordance,
};
