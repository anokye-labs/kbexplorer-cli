/**
 * Consent gate — the enforced half of the consent rules (PE3-F3).
 *
 * The affordance contract (PE3-F1) classifies every action `read` / `write` /
 * `sample`, but that classification is **advisory** there: the contract enforces
 * nothing. This module turns the classification into an **enforced consent
 * gate** that runs at the action core (the registry's `executeAffordance`), so
 * **every** delivery adapter — the extension-tool adapter and the future MCP
 * adapter — inherits identical behaviour. The dependency arrow stays
 * `affordances → {adapters}`: nothing here imports MCP, JSON-RPC, a canvas, or
 * any transport. The gate obtains the actual yes/no through an **injected
 * callback** (`context.seams.requestConsent`) and never knows how it is rendered
 * (a CLI prompt, a canvas dialog, an MCP elicitation, …).
 *
 * Rules:
 *   - `read` actions bypass the gate entirely (no prompt, zero overhead).
 *   - `write` and `sample` actions require approval **before** they run.
 *   - Disclosure is deterministic and timestamp-free: it discloses the model
 *     cost (which runtime/model a sample invokes), the credential **names** that
 *     may be used (never values), and the paths/targets a write touches.
 *   - **Fail-closed default:** if a write/sample action is invoked and no
 *     `requestConsent` seam is wired, the gate refuses with `CONSENT_REQUIRED`
 *     rather than running silently. A host opts into non-interactive execution
 *     explicitly via `context.seams.consentPolicy === 'allow'`.
 *
 * @module src/affordances/consent
 */

import {
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
  type ActionClass,
  type Affordance,
  type ConsentCost,
  type ConsentDisclosure,
} from './contract.ts';
import type { AffordanceContext } from './context.ts';

export interface DisclosureShape {
  credentials: string[];
  writes: string[];
  cost: ConsentCost & { kind: string };
}

export interface ConsentRequest {
  affordance: string;
  title: string;
  summary: string;
  actionClass: ActionClass;
  disclosure: DisclosureShape;
}

export interface ConsentDecision extends Record<string, unknown> {
  approved: boolean;
  reason?: string;
  credentials?: Record<string, unknown>;
}

/**
 * Action classes that require user consent before execution. `read` is absent by
 * design — observing the graph has no side effects and never prompts.
 *
 * @type {ReadonlySet<string>}
 */
export const CONSENT_REQUIRED_CLASSES = Object.freeze(
  new Set<ActionClass>([ACTION_CLASSES.WRITE, ACTION_CLASSES.SAMPLE]),
);

/** Whether an affordance's action class subjects it to the consent gate. */
export function requiresConsent(affordance: Affordance | null | undefined): boolean {
  return affordance !== null && affordance !== undefined && CONSENT_REQUIRED_CLASSES.has(affordance.actionClass);
}

/**
 * Whether a *specific invocation* of a write/sample affordance is side-effect
 * free and may therefore skip the gate. This is an **explicit, opt-in** escape
 * declared by the affordance via `consent.readOnlyWhen(input)` — e.g. the
 * deterministic `derive --check` drift gate, which never writes and must run
 * unattended in CI. Omitting the predicate means the action is **always** gated
 * (fail-closed by default; never fail-open by omission).
 *
 * @param {object} affordance
 * @param {object} [input]
 * @returns {boolean}
 */
export function isReadOnlyInvocation(
  affordance: Affordance | null | undefined,
  input: Record<string, unknown> = {},
): boolean {
  const pred = affordance?.consent?.readOnlyWhen;
  if (typeof pred !== 'function') return false;
  try {
    return Boolean(pred(input));
  } catch {
    return false;
  }
}

function dedupeStrings(values: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Assemble the deterministic, serialisable disclosure for an action: what model
 * cost it incurs, which credential names it may use, and which paths it writes.
 * Built from the affordance's static {@link ConsentDescriptor} merged with its
 * optional input-derived `disclose(input, context)`. No timestamps, no values.
 *
 * @param {object} affordance
 * @param {object} input
 * @param {object} [context]
 * @returns {{credentials: string[], writes: string[], cost: {kind: string}}}
 */
export function buildDisclosure(
  affordance: Affordance,
  input: Record<string, unknown> = {},
  context: AffordanceContext | undefined = undefined,
): DisclosureShape {
  const consent = affordance.consent ?? {};
  let dynamic: ConsentDisclosure = {};
  if (typeof consent.disclose === 'function') {
    try {
      dynamic = consent.disclose(input, context) ?? {};
    } catch {
      // A disclosure helper must never break the gate; fall back to static only.
      dynamic = {};
    }
  }

  const credentials = dedupeStrings([
    ...(Array.isArray(consent.credentials) ? consent.credentials : []),
    ...(Array.isArray(dynamic.credentials) ? dynamic.credentials : []),
  ]).sort();

  const writes = dedupeStrings([
    ...(Array.isArray(consent.writes) ? consent.writes : []),
    ...(Array.isArray(dynamic.writes) ? dynamic.writes : []),
  ]);

  // Sample actions default to a `sample` cost kind even without a static block,
  // so the disclosure always tells the user a model may be invoked.
  const defaultKind = affordance.actionClass === ACTION_CLASSES.SAMPLE ? 'sample' : 'none';
  const cost: ConsentCost & { kind: string } = {
    kind: defaultKind,
    ...(consent.cost ?? {}),
    ...(dynamic.cost ?? {}),
  };
  if (typeof cost.kind !== 'string') cost.kind = defaultKind;

  return { credentials, writes, cost };
}

/**
 * Build the full {@link ConsentRequest} an approval seam is handed. Pure and
 * deterministic — safe to compute repeatedly and to serialise across any
 * transport an adapter chooses.
 *
 * @param {object} affordance
 * @param {object} [input={}]
 * @param {object} [context]
 * @returns {{affordance: string, title: string, summary: string, actionClass: string, disclosure: object}}
 */
export function buildConsentRequest(
  affordance: Affordance,
  input: Record<string, unknown> = {},
  context: AffordanceContext | undefined = undefined,
): ConsentRequest {
  return {
    affordance: affordance.name,
    title: affordance.title,
    summary: affordance.summary,
    actionClass: affordance.actionClass,
    disclosure: buildDisclosure(affordance, input, context),
  };
}

/** Normalise the many shapes an approval callback may return into a decision. */
function normalizeDecision(raw: unknown): ConsentDecision {
  if (raw === true) return { approved: true };
  if (raw === false || raw == null) return { approved: false };
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    return { approved: Boolean(record.approved), ...record };
  }
  // Any other truthy scalar counts as approval.
  return { approved: Boolean(raw) };
}

/**
 * Enforce consent for an affordance about to execute. Read-class actions return
 * immediately. For write/sample actions:
 *
 *   1. Build the disclosure {@link ConsentRequest}.
 *   2. If `context.seams.consentPolicy === 'allow'`, auto-approve (explicit
 *      non-interactive opt-in) and return the request unprompted.
 *   3. Otherwise resolve `context.seams.requestConsent`:
 *        - absent → throw {@link ERROR_CODES.CONSENT_REQUIRED} (fail-closed).
 *        - present → await its decision; a falsy decision throws
 *          {@link ERROR_CODES.CONSENT_DENIED}.
 *
 * The (possibly enriched) decision is returned so the caller can thread back any
 * host-supplied extras (e.g. freshly entered credentials) into the input.
 *
 * @param {object} affordance  A frozen affordance from the registry.
 * @param {object} input       The validated input about to be executed.
 * @param {object} [context]   The affordance execution context (carries seams).
 * @returns {Promise<{approved: boolean, request: object, decision: object}>}
 * @throws {AffordanceError} CONSENT_REQUIRED / CONSENT_DENIED.
 */
export async function enforceConsent(
  affordance: Affordance,
  input: Record<string, unknown>,
  context: AffordanceContext | undefined = undefined,
): Promise<{ approved: boolean; request: ConsentRequest | null; decision: ConsentDecision }> {
  if (!requiresConsent(affordance)) {
    return { approved: true, request: null, decision: { approved: true, bypassed: 'read' } };
  }

  // An explicitly-declared side-effect-free invocation (e.g. `derive --check`)
  // is treated as read: no disclosure, no prompt, safe to run unattended.
  if (isReadOnlyInvocation(affordance, input)) {
    return {
      approved: true,
      request: null,
      decision: { approved: true, bypassed: 'read-only-invocation' },
    };
  }

  const request = buildConsentRequest(affordance, input, context);
  const seams = context?.seams ?? {};

  if (seams.consentPolicy === 'allow') {
    return { approved: true, request, decision: { approved: true, bypassed: 'policy:allow' } };
  }

  const requestConsent = seams.requestConsent;
  if (typeof requestConsent !== 'function') {
    throw new AffordanceError(
      ERROR_CODES.CONSENT_REQUIRED,
      `"${affordance.name}" is a ${affordance.actionClass}-class action and requires consent, ` +
        'but no approval callback was provided (context.seams.requestConsent). ' +
        'Wire an approval seam, or set context.seams.consentPolicy = "allow" to opt into ' +
        'non-interactive execution.',
      { affordance: affordance.name, actionClass: affordance.actionClass, request },
    );
  }

  const decision = normalizeDecision(await requestConsent(request));
  if (!decision.approved) {
    throw new AffordanceError(
      ERROR_CODES.CONSENT_DENIED,
      `Consent denied for "${affordance.name}" (${affordance.actionClass}-class action).`,
      {
        affordance: affordance.name,
        actionClass: affordance.actionClass,
        request,
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    );
  }

  return { approved: true, request, decision };
}
