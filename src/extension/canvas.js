/**
 * Canvas stub (PE3-F5) — the minimal declaration the affordance tools ride with.
 *
 * The whole point of the extension-tool adapter is that the affordance `tools`
 * ship in the **same** `joinSession({ canvases, tools })` call as the kbexplorer
 * canvas: "if the plugin provides a canvas, the action tools come with it."
 * This module supplies a deliberately minimal canvas **declaration** so that
 * wiring is real and exercised. The actual canvas rendering (the web view, its
 * open URL, SSE graph updates) is template#401 work owned by a separate session;
 * here we only need a valid, placeholder declaration.
 *
 * Pure and SDK-free: this returns a plain `CanvasOptions`-shaped object. The
 * wiring module passes it to the SDK's `createCanvas` at runtime — see
 * {@link module:src/extension/index}.
 *
 * @module src/extension/canvas
 */

/** Stable, provider-local id for the kbexplorer canvas. */
export const KBX_CANVAS_ID = 'kbexplorer';

/**
 * Build the placeholder canvas options object.
 *
 * The `open` handler is a stub: it acknowledges the open request without
 * rendering anything yet (no `url`), so the declaration is structurally valid
 * and focus/instance plumbing works, while the real renderer lands separately.
 *
 * @returns {object} A `CanvasOptions`-shaped object for the SDK's `createCanvas`.
 */
export function buildCanvasOptions() {
  return {
    id: KBX_CANVAS_ID,
    displayName: 'kbexplorer Knowledge Graph',
    description:
      'Interactive kbexplorer knowledge-graph canvas. Affordance tools (kbx_*) act on the graph it renders.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Optional node id to focus on open.' },
      },
      additionalProperties: false,
    },
    // Placeholder: real rendering (web view + SSE) is template#401, separate.
    open() {
      return {
        title: 'kbexplorer Knowledge Graph',
        status: 'placeholder: canvas rendering not yet wired (template#401)',
      };
    },
  };
}
