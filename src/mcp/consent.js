/**
 * MCP consent bridge (PE3-F4 × PE3-F3) — satisfy the `requestConsent` seam over MCP.
 *
 * Consent is enforced **once, at the action core** ({@link module:src/affordances/consent}
 * via {@link executeAffordance}): read-class actions never prompt, write/sample
 * actions must be approved before any side effect, and the gate obtains its
 * yes/no through an injected `context.seams.requestConsent(request)` callback.
 * The affordance layer knows nothing about *how* that approval is rendered — a
 * CLI prompt, a canvas dialog, or, here, an **MCP elicitation**.
 *
 * This module is the MCP rendering of that seam. It turns the transport-neutral
 * {@link import('../affordances/consent.js').ConsentRequest} (title, action class,
 * and the deterministic disclosure of model cost / credential *names* / write
 * targets) into an MCP `elicitation/create` request, and interprets the host's
 * `{ action, content }` response back into a consent decision:
 *
 *   - host `action: 'accept'`  → approved (any collected credential values are
 *     threaded back via `decision.credentials`, which the registry merges into
 *     the affordance input — values, never names, cross the wire);
 *   - host `action: 'decline' | 'cancel'` → denied (→ `CONSENT_DENIED`).
 *
 * **Fail-closed:** if the connected client does not advertise the `elicitation`
 * capability there is no way to ask, so the seam denies with a clear,
 * actionable reason (re-run with `--allow` for non-interactive consent). A host
 * that genuinely wants unattended writes opts in explicitly — the wiring maps
 * `--allow` / `KBX_MCP_CONSENT=allow` to `seams.consentPolicy = 'allow'` and no
 * elicitation seam is installed at all.
 *
 * Pure w.r.t. the SDK: it receives `elicitInput` / `getClientCapabilities` as
 * plain function seams, so it (and its tests) never import the MCP SDK.
 *
 * @module src/mcp/consent
 */

import { createAffordanceContext } from '../affordances/index.js';

/**
 * Render a {@link ConsentRequest} into a deterministic, human-readable message
 * for an MCP elicitation prompt. Timestamp-free and stable — safe to compute
 * repeatedly and to diff in tests.
 *
 * @param {{ title?: string, affordance: string, actionClass: string, summary?: string, disclosure?: object }} request
 * @returns {string}
 */
export function renderConsentMessage(request) {
  const { title, affordance, actionClass, summary, disclosure = {} } = request ?? {};
  const lines = [
    `kbexplorer wants to run "${title ?? affordance}" (${actionClass}-class action).`,
  ];
  if (summary) lines.push(summary);

  const cost = disclosure.cost;
  if (cost && typeof cost.kind === 'string' && cost.kind !== 'none') {
    lines.push(`• Model cost: ${cost.kind}${cost.model ? ` (${cost.model})` : ''}`);
  }
  const credentials = Array.isArray(disclosure.credentials) ? disclosure.credentials : [];
  if (credentials.length) {
    lines.push(`• May use credentials: ${credentials.join(', ')}`);
  }
  const writes = Array.isArray(disclosure.writes) ? disclosure.writes : [];
  if (writes.length) {
    lines.push(`• Writes: ${writes.join(', ')}`);
  }
  lines.push('Approve this action?');
  return lines.join('\n');
}

/**
 * Build the restricted JSON schema an MCP elicitation `requestedSchema` accepts.
 * Elicitation schemas are flat objects of primitive properties only. When the
 * disclosure names credentials the action may use, we expose them as optional
 * string fields so a host *may* collect fresh values inline; approval itself is
 * carried by the elicitation `action`, so the schema stays optional (an empty
 * object when nothing is disclosed).
 *
 * @param {{ disclosure?: { credentials?: string[] } }} request
 * @returns {{ type: 'object', properties: Record<string, object> }}
 */
export function buildElicitationSchema(request) {
  const credentials = Array.isArray(request?.disclosure?.credentials)
    ? request.disclosure.credentials
    : [];
  /** @type {Record<string, object>} */
  const properties = {};
  for (const name of credentials) {
    if (typeof name !== 'string' || !name) continue;
    properties[name] = {
      type: 'string',
      title: name,
      description: `Optional value for credential "${name}" (leave blank to use the ambient environment).`,
    };
  }
  return { type: 'object', properties };
}

/**
 * Create the `requestConsent` seam backed by MCP elicitation.
 *
 * @param {object} deps
 * @param {(params: { message: string, requestedSchema: object }) => Promise<{ action?: string, content?: Record<string, unknown> }>} deps.elicitInput
 *        The MCP server's `elicitInput` (server→client `elicitation/create`).
 * @param {() => (object|undefined)} [deps.getClientCapabilities]
 *        Reads the connected client's advertised capabilities (checked lazily at
 *        call time, since capabilities are only known after the handshake).
 * @returns {(request: object) => Promise<{ approved: boolean, reason?: string, credentials?: object }>}
 */
export function createMcpConsentSeam({ elicitInput, getClientCapabilities } = {}) {
  if (typeof elicitInput !== 'function') {
    throw new TypeError('createMcpConsentSeam: "elicitInput" must be a function');
  }

  return async function requestConsent(request) {
    const caps = (typeof getClientCapabilities === 'function' && getClientCapabilities()) || {};
    if (!caps.elicitation) {
      return {
        approved: false,
        reason:
          'the connected MCP client does not support elicitation, so consent cannot be requested; ' +
          're-run "kbx mcp --allow" (or set KBX_MCP_CONSENT=allow) to opt into non-interactive consent.',
      };
    }

    const response = await elicitInput({
      message: renderConsentMessage(request),
      requestedSchema: buildElicitationSchema(request),
    });

    const approved = response?.action === 'accept';
    if (!approved) {
      return { approved: false, reason: `user ${response?.action ?? 'dismissed'} the consent prompt` };
    }

    // Thread back only non-empty collected credential *values*; the registry
    // merges these into the affordance input (values, never names, cross a wire).
    const decision = { approved: true };
    const content = response?.content;
    if (content && typeof content === 'object') {
      const credentials = {};
      for (const [key, value] of Object.entries(content)) {
        if (typeof value === 'string' && value.length > 0) credentials[key] = value;
      }
      if (Object.keys(credentials).length) decision.credentials = credentials;
    }
    return decision;
  };
}

/**
 * Build the per-call affordance-context factory the MCP tools use, wiring the
 * consent seams appropriate to the run:
 *
 *   - `allow: true` → `seams.consentPolicy = 'allow'` (explicit non-interactive
 *     opt-in; write/sample run without prompting). No elicitation seam.
 *   - otherwise, if `elicitInput` is supplied → install the elicitation-backed
 *     `requestConsent` seam (which itself fails closed when the client can't
 *     elicit).
 *   - otherwise → no consent seam, so the core fails closed with
 *     `CONSENT_REQUIRED` for any write/sample action.
 *
 * @param {object} [opts]
 * @param {string}  [opts.cwd=process.cwd()]  Working root for the context.
 * @param {boolean} [opts.allow=false]        Non-interactive consent opt-in.
 * @param {(params: object) => Promise<object>} [opts.elicitInput]  MCP elicitation seam.
 * @param {() => (object|undefined)} [opts.getClientCapabilities]
 * @returns {() => object} A fresh {@link createAffordanceContext} per call.
 */
export function createMcpContextFactory({
  cwd = process.cwd(),
  allow = false,
  elicitInput,
  getClientCapabilities,
} = {}) {
  /** @type {object} */
  let seams;
  if (allow) {
    seams = { consentPolicy: 'allow' };
  } else if (typeof elicitInput === 'function') {
    seams = { requestConsent: createMcpConsentSeam({ elicitInput, getClientCapabilities }) };
  } else {
    seams = {};
  }
  return () => createAffordanceContext({ cwd, seams });
}
