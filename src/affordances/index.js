/**
 * Affordance registry — the assembled, protocol-neutral DO-seam (PE3-F1).
 *
 * Collects the stateless graph operations (PE3-F1) **and** the workflow/job
 * layer (PE3-F2) into a single contract surface that both delivery adapters bind
 * to:
 *
 *   search · query_node · graph_neighbors · affected · audit · llm_context · derive
 *   start_generate · get_job_status · cancel_job · preview_changes · apply_changes · create_pr
 *
 * The job operations are ordinary affordances classified with the same
 * ACTION_CLASSES (start_generate=sample, get_job_status/preview_changes=read,
 * cancel_job/apply_changes/create_pr=write), so the extension-tool adapter and a
 * future MCP adapter expose them automatically with no adapter changes.
 *
 * The registry is the spine of the dependency arrow `affordances → {adapters}`.
 * It exposes:
 *
 *   - {@link listAffordances} / {@link getAffordance} / {@link hasAffordance}
 *   - {@link describeAffordances} — serialisable contract catalogue an adapter
 *     introspects to answer "what actions are available, with what typed
 *     inputs/outputs?" (the extension-tool adapter turns these into `tools`;
 *     the MCP adapter turns them into MCP tool registrations).
 *   - {@link executeAffordance} — validate input against the contract, enforce
 *     consent for write/sample-class actions (PE3-F3), run the handler with the
 *     given context, and surface failures as typed {@link AffordanceError}s.
 *
 * The consent gate is enforced **here, at the action core**, not in any adapter,
 * so the extension-tool adapter and a future MCP adapter inherit identical
 * approval/disclosure behaviour. Nothing here imports MCP, JSON-RPC, or any
 * canvas/transport code.
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
import {
  enforceConsent,
  requiresConsent,
  isReadOnlyInvocation,
  buildConsentRequest,
  buildDisclosure,
  CONSENT_REQUIRED_CLASSES,
} from './consent.js';
import {
  buildDerivation,
  stampProvenance,
  sampledSourceRef,
  SAMPLE_GENERATOR,
} from './provenance.js';
import search from './operations/search.js';
import queryNode from './operations/query-node.js';
import graphNeighbors from './operations/graph-neighbors.js';
import affected from './operations/affected.js';
import audit from './operations/audit.js';
import llmContext from './operations/llm-context.js';
import derive from './operations/derive.js';
import startGenerate from './jobs/start-generate.js';
import getJobStatus from './jobs/get-job-status.js';
import cancelJob from './jobs/cancel-job.js';
import previewChanges from './jobs/preview-changes.js';
import applyChanges from './jobs/apply-changes.js';
import createPr from './jobs/create-pr.js';

/**
 * Canonical ordering of the do-seam operations. The first seven are the stateless
 * graph actions (PE3-F1); the trailing six are the workflow/job layer (PE3-F2)
 * for long-running work — registered here so **both** delivery adapters pick them
 * up generically, with no adapter changes.
 */
const AFFORDANCE_LIST = Object.freeze([
  search,
  queryNode,
  graphNeighbors,
  affected,
  audit,
  llmContext,
  derive,
  startGenerate,
  getJobStatus,
  cancelJob,
  previewChanges,
  applyChanges,
  createPr,
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
 * **enforce consent** for write/sample-class actions, then run the handler with
 * `context`. The consent gate (PE3-F3) lives here — at the action core — so both
 * delivery adapters inherit identical enforcement; read-class actions skip it
 * with zero overhead.
 *
 * @param {string} name           Affordance name.
 * @param {object} [input={}]     Raw input (validated/coerced against the schema).
 * @param {object} [context]      An {@link createAffordanceContext} result. When
 *        omitted a default context over `process.cwd()` is created.
 * @returns {Promise<*>} The affordance's typed result.
 * @throws {AffordanceError} UNKNOWN_AFFORDANCE / INVALID_INPUT / CONSENT_REQUIRED /
 *         CONSENT_DENIED / or a typed failure raised by the handler.
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

  // Consent gate: refuse or prompt for write/sample actions before any side
  // effect or model call. A host may thread freshly-supplied credentials back
  // through the decision; merge them into the input the handler sees.
  const { decision } = await enforceConsent(affordance, value, ctx);
  const effectiveInput =
    decision && decision.credentials && typeof decision.credentials === 'object'
      ? { ...value, credentials: { ...(value.credentials ?? {}), ...decision.credentials } }
      : value;

  return affordance.execute(ctx, effectiveInput);
}

export {
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
  createAffordanceContext,
  describeAffordance,
  // Consent gate (PE3-F3) — enforced here at the action core for every adapter.
  enforceConsent,
  requiresConsent,
  isReadOnlyInvocation,
  buildConsentRequest,
  buildDisclosure,
  CONSENT_REQUIRED_CLASSES,
  // Sampled-content provenance (PE3-F3).
  buildDerivation,
  stampProvenance,
  sampledSourceRef,
  SAMPLE_GENERATOR,
};
