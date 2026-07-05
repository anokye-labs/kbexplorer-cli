/**
 * Result bridge — affordance result / {@link AffordanceError} → `ToolResultObject`.
 *
 * An affordance's `execute` returns a plain typed result on success or raises an
 * {@link import('../affordances/contract.ts').AffordanceError} (or, defensively,
 * an unexpected `Error`) on failure. The Copilot CLI extension `tools` surface
 * wants either a string or a structured
 * `{ textResultForLlm, resultType, error? }` object back from a tool handler.
 *
 * This module is the pure mapping between the two. It imports no SDK and no
 * transport — it only shapes JSON the host already understands.
 *
 * @module src/extension/tool-result
 */

import { buildToolErrorEnvelope, buildToolResultEnvelope } from '../affordances/tool-bridge.ts';

/**
* Wrap a successful affordance result as a `ToolResultObject`.
*
* @param {*} value  The affordance's typed result.
* @returns {{ textResultForLlm: string, resultType: 'success' }}
*/
export function successResult(value) {
 const envelope = buildToolResultEnvelope(value);
 return {
   textResultForLlm: envelope.text,
   resultType: envelope.resultType,
 };
}

/**
* Wrap a thrown failure as a `ToolResultObject` with `resultType: "failure"`.
*
* {@link AffordanceError}s carry a stable `code` and serialisable `details`; we
* preserve them via the error's own `toJSON()` so the model sees the typed error
* shape (`{ error, code, message, details? }`). Any other thrown value degrades
* gracefully to a generic failure payload.
*
* @param {unknown} err
* @returns {{ textResultForLlm: string, resultType: 'failure', error: string }}
*/
export function errorResult(err) {
 const envelope = buildToolErrorEnvelope(err);
 return {
   textResultForLlm: envelope.text,
   resultType: envelope.resultType,
   error: envelope.error,
 };
}
