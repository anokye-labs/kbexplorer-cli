/**
 * Result bridge — affordance result / {@link AffordanceError} → `ToolResultObject`.
 *
 * An affordance's `execute` returns a plain typed result on success or raises an
 * {@link import('../affordances/contract.js').AffordanceError} (or, defensively,
 * an unexpected `Error`) on failure. The Copilot CLI extension `tools` surface
 * wants either a string or a structured
 * `{ textResultForLlm, resultType, error? }` object back from a tool handler.
 *
 * This module is the pure mapping between the two. It imports no SDK and no
 * transport — it only shapes JSON the host already understands.
 *
 * @module src/extension/tool-result
 */

/** Stable JSON stringify with 2-space indent; tolerant of non-serialisable values. */
function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Wrap a successful affordance result as a `ToolResultObject`.
 *
 * @param {*} value  The affordance's typed result.
 * @returns {{ textResultForLlm: string, resultType: 'success' }}
 */
export function successResult(value) {
  return {
    textResultForLlm: value === undefined ? '' : stringify(value),
    resultType: 'success',
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
  let payload;
  let message;

  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).toJSON) === 'function') {
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
    textResultForLlm: stringify(payload),
    resultType: 'failure',
    error: message,
  };
}
