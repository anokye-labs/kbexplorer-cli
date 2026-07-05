/**
 * Result bridge — affordance result / {@link AffordanceError} → MCP `CallToolResult`.
 *
 * The MCP adapter (PE3-F4) is the *second* delivery adapter for the affordance
 * action contract (PE3-F1); it exposes the exact same affordances as the
 * extension-tool adapter, only over the Model Context Protocol wire instead of
 * the Copilot extension SDK. This module is the MCP-shaped sibling of
 * {@link module:src/extension/tool-result}: it maps an affordance's typed result
 * (or a thrown {@link import('../affordances/contract.ts').AffordanceError}) into
 * the `{ content: [...], isError? }` shape an MCP `CallToolResult` requires.
 *
 * It is pure — it imports no MCP SDK and no transport; it only shapes JSON the
 * host already understands. That keeps the SDK out of the static module graph
 * (the SDK is dynamic-imported only in {@link module:src/mcp/index}'s `main`), so
 * the adapter stays hermetically testable and the neutrality guard holds.
 *
 * @module src/mcp/tool-result
 */

import { buildToolErrorEnvelope, buildToolResultEnvelope } from '../affordances/tool-bridge.ts';

export function successResult(value: unknown) {
 const envelope = buildToolResultEnvelope(value);
 return {
   content: [{ type: 'text', text: envelope.text }],
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
export function errorResult(err: unknown) {
 const envelope = buildToolErrorEnvelope(err);
 return {
   isError: true,
   content: [{ type: 'text', text: envelope.text }],
 };
}
