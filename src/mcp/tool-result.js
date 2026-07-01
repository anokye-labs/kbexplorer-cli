/**
 * Result bridge — affordance result / {@link AffordanceError} → MCP `CallToolResult`.
 *
 * The MCP adapter (PE3-F4) is the *second* delivery adapter for the affordance
 * action contract (PE3-F1); it exposes the exact same affordances as the
 * extension-tool adapter, only over the Model Context Protocol wire instead of
 * the Copilot extension SDK. This module is the MCP-shaped sibling of
 * {@link module:src/extension/tool-result}: it maps an affordance's typed result
 * (or a thrown {@link import('../affordances/contract.js').AffordanceError}) into
 * the `{ content: [...], isError? }` shape an MCP `CallToolResult` requires.
 *
 * It is pure — it imports no MCP SDK and no transport; it only shapes JSON the
 * host already understands. That keeps the SDK out of the static module graph
 * (the SDK is dynamic-imported only in {@link module:src/mcp/index}'s `main`), so
 * the adapter stays hermetically testable and the neutrality guard holds.
 *
 * @module src/mcp/tool-result
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
 * Wrap a successful affordance result as an MCP `CallToolResult`.
 *
 * @param {*} value  The affordance's typed result.
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
export function successResult(value) {
  return {
    content: [{ type: 'text', text: value === undefined ? '' : stringify(value) }],
  };
}

/**
 * Wrap a thrown failure as an MCP `CallToolResult` with `isError: true`.
 *
 * {@link AffordanceError}s carry a stable `code` and serialisable `details`; we
 * preserve them via the error's own `toJSON()` so the model sees the typed error
 * shape (`{ error, code, message, details? }`). Any other thrown value degrades
 * gracefully to a generic failure payload. The MCP spec surfaces tool failures
 * *in-band* (a normal result with `isError: true`), not as a protocol error, so
 * the host model can read and react to the typed payload.
 *
 * @param {unknown} err
 * @returns {{ isError: true, content: Array<{ type: 'text', text: string }> }}
 */
export function errorResult(err) {
  let payload;

  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).toJSON) === 'function') {
    payload = /** @type {any} */ (err).toJSON();
  } else if (err instanceof Error) {
    payload = { error: true, code: 'EXECUTION_FAILED', message: err.message };
  } else {
    payload = { error: true, code: 'EXECUTION_FAILED', message: String(err) };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: stringify(payload) }],
  };
}
