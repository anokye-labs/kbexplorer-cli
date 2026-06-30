/**
 * Onboarding state machine — the surface-agnostic genesis flow (PE2-F1, #149).
 *
 * Genesis is a **state machine, not a surface** (epic anokye-labs/kbexplorer#20).
 * The CLI `init` wizard and the canvas-rendered onboarding (PE2-F3, #428) are two
 * surfaces that *render and drive* the same deterministic decision flow:
 *
 *   preflight → template-strategy → content-mode → visual-identity → search-mode
 *             → generate → ready
 *
 * This module owns that flow and nothing else. It is a **pure reducer**: every
 * transition is a function of `(state, event) → { state, effects }` with no UI, no
 * I/O, no clock and no randomness. Side effects the flow needs — running the
 * first-run preflight (#152), persisting decisions to `.kbx.json`, kicking off the
 * long-running `generate` job (#154) — are never performed by the machine. They
 * are emitted as **declarative effect descriptors** that a surface (or the thin
 * {@link driveOnboarding} runner) executes through injected seams, feeding the
 * results back as events. That keeps the decision logic hermetically testable and
 * lets any surface supply its own rendering and its own effect wiring.
 *
 * Composition seams (all injected, never imported here):
 *   - `preflight`        → runs the #152 first-run diagnostics, returns
 *                          `{ ok, diagnostics:[{ level, id, message, recovery }] }`.
 *   - `persist`          → merges a decision patch into `.kbx.json`
 *                          (e.g. `writeSourceRecord`).
 *   - `startGenerate`    → drives the #154 generate job to a settled snapshot.
 *
 * The decision vocabulary mirrors `src/commands/init.js` exactly, so the headless
 * (`--yes`) wizard, the interactive wizard and the canvas all validate against one
 * source of truth.
 *
 * @module src/lib/onboarding
 */

/**
 * The ordered onboarding spine. `preflight` is the #152 entry guard; `ready` is
 * terminal and only advertises follow-on actions (dev/build) — the machine never
 * drives those itself ("state machine, not a surface").
 *
 * @type {readonly string[]}
 */
export const ONBOARDING_STEPS = Object.freeze([
  'preflight',
  'template-strategy',
  'content-mode',
  'visual-identity',
  'search-mode',
  'generate',
  'ready',
]);

/**
 * Lifecycle status of the flow as a whole (distinct from the per-step `step`).
 *
 * @enum {string}
 */
export const STATUS = Object.freeze({
  /** Created, nothing started yet (only valid at `preflight`). */
  IDLE: 'idle',
  /** Waiting for the surface to supply a decision or call NEXT. */
  AWAITING_INPUT: 'awaiting-input',
  /** A hard blocker (preflight error / awaiting credential) prevents advancing. */
  BLOCKED: 'blocked',
  /** An async effect is in flight (preflight running, generate job running). */
  RUNNING: 'running',
  /** Reached `ready` — genesis complete. */
  DONE: 'done',
  /** A step failed unrecoverably (generate job failed). */
  FAILED: 'failed',
});

/**
 * Allowed values for each persisted decision key — the single source of truth,
 * matching `src/commands/init.js` (CONTENT_MODES / VISUAL_MODES / THEMES) plus the
 * template-install strategy and the search-mode choice.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DECISION_ENUMS = Object.freeze({
  strategy: Object.freeze(['submodule', 'vendor']),
  contentMode: Object.freeze(['repo', 'authored', 'both']),
  visual: Object.freeze(['emoji', 'sprites', 'heroes', 'none']),
  theme: Object.freeze(['dark', 'light', 'sepia']),
  search: Object.freeze(['none', 'local', 'semantic']),
});

/**
 * Which decision key(s) each decision step owns. `visual-identity` carries two
 * (visual + theme); the rest carry one.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const STEP_DECISION_KEYS = Object.freeze({
  'template-strategy': Object.freeze(['strategy']),
  'content-mode': Object.freeze(['contentMode']),
  'visual-identity': Object.freeze(['visual', 'theme']),
  'search-mode': Object.freeze(['search']),
});

/** Stable, machine-readable error codes surfaced on `state.error`. */
export const ONBOARDING_ERRORS = Object.freeze({
  /** A DECIDE event carried an unknown step or an out-of-enum value. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** NEXT was requested but the current step's guard is not satisfied. */
  GUARD_BLOCKED: 'GUARD_BLOCKED',
  /** BACK was requested at the first step. */
  AT_START: 'AT_START',
});

const DECISION_KEYS = Object.freeze(['strategy', 'contentMode', 'visual', 'theme', 'search']);

function freezeState(state) {
  return Object.freeze({
    ...state,
    decisions: Object.freeze({ ...state.decisions }),
    diagnostics: Object.freeze([...state.diagnostics]),
    history: Object.freeze([...state.history]),
  });
}

function emptyDecisions(overrides = {}) {
  const out = {};
  for (const k of DECISION_KEYS) {
    const v = overrides[k];
    out[k] = v === undefined ? null : v;
  }
  return out;
}

/**
 * Create the initial machine state. Decisions may be pre-seeded (the headless
 * `--yes` path seeds all of them up-front; an interactive surface seeds none and
 * fills them in via DECIDE events).
 *
 * @param {object} [opts]
 * @param {Partial<Record<'strategy'|'contentMode'|'visual'|'theme'|'search', string>>} [opts.decisions]
 *        Pre-seeded decisions. Values are NOT validated here — invalid seeds are
 *        caught at the relevant step's advance guard / DECIDE call.
 * @returns {Readonly<object>} A frozen initial state.
 */
export function createOnboardingMachine({ decisions = {} } = {}) {
  return freezeState({
    step: 'preflight',
    status: STATUS.IDLE,
    decisions: emptyDecisions(decisions),
    diagnostics: [],
    job: null,
    needs: null,
    error: null,
    history: ['preflight'],
  });
}

function stepIndex(step) {
  return ONBOARDING_STEPS.indexOf(step);
}

/** Whether a step is one of the decision-collecting steps. */
function isDecisionStep(step) {
  return Object.prototype.hasOwnProperty.call(STEP_DECISION_KEYS, step);
}

/** Whether every decision the given step owns has been chosen. */
function decisionsSatisfied(state, step) {
  const keys = STEP_DECISION_KEYS[step] ?? [];
  return keys.every((k) => state.decisions[k] != null);
}

/**
 * Pure guard: may the flow advance from its current step? No side effects.
 *
 *   - preflight        → an OK preflight result has been received
 *                        (no `level: 'error'` diagnostic).
 *   - decision steps   → all of the step's decisions are set.
 *   - generate         → the generate job has settled `succeeded`.
 *   - ready            → terminal, never advances.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function canAdvance(state) {
  switch (state.step) {
    case 'preflight':
      return state.diagnostics.length > 0
        ? !state.diagnostics.some((d) => d.level === 'error')
        : state.status === STATUS.AWAITING_INPUT;
    case 'generate':
      return state.job?.status === 'succeeded';
    case 'ready':
      return false;
    default:
      return isDecisionStep(state.step) && decisionsSatisfied(state, state.step);
  }
}

/** Whether the machine has reached a terminal status. */
export function isTerminal(state) {
  return state.status === STATUS.DONE || state.status === STATUS.FAILED;
}

/**
 * Follow-on actions advertised once `ready` is reached. The machine does not run
 * these — a surface offers them as the natural next steps after genesis.
 *
 * @param {object} state
 * @returns {string[]}
 */
export function nextActions(state) {
  return state.step === 'ready' ? ['dev', 'build'] : [];
}

/** Build the persist patch for a set of changed decision keys. */
function persistPatch(decisions, keys) {
  const onboarding = {};
  for (const k of keys) onboarding[k] = decisions[k];
  return { onboarding };
}

function withError(state, code, message) {
  return { state: freezeState({ ...state, error: { code, message } }), effects: [] };
}

function normalizeDecideValue(step, value) {
  const keys = STEP_DECISION_KEYS[step];
  // Single-key steps accept a bare scalar or a { key: value } object.
  if (keys.length === 1 && (typeof value !== 'object' || value === null)) {
    return { [keys[0]]: value };
  }
  if (value && typeof value === 'object') return { ...value };
  return null;
}

/** Handle a DECIDE event (validate + merge + emit a persist effect). */
function reduceDecide(state, event) {
  const { step, value } = event;
  if (!isDecisionStep(step)) {
    return withError(state, ONBOARDING_ERRORS.INVALID_INPUT, `Unknown decision step: "${step}"`);
  }
  const patch = normalizeDecideValue(step, value);
  if (!patch || Object.keys(patch).length === 0) {
    return withError(state, ONBOARDING_ERRORS.INVALID_INPUT, `No decision value supplied for "${step}"`);
  }
  const allowedKeys = STEP_DECISION_KEYS[step];
  const changed = [];
  const nextDecisions = { ...state.decisions };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowedKeys.includes(k)) {
      return withError(
        state,
        ONBOARDING_ERRORS.INVALID_INPUT,
        `Decision "${k}" does not belong to step "${step}" (expected ${allowedKeys.join('|')})`,
      );
    }
    if (!DECISION_ENUMS[k].includes(v)) {
      return withError(
        state,
        ONBOARDING_ERRORS.INVALID_INPUT,
        `Invalid ${k} "${v}" — must be one of ${DECISION_ENUMS[k].join('|')}`,
      );
    }
    nextDecisions[k] = v;
    changed.push(k);
  }
  return {
    state: freezeState({
      ...state,
      decisions: nextDecisions,
      status: STATUS.AWAITING_INPUT,
      error: null,
    }),
    effects: [{ kind: 'persist', patch: persistPatch(nextDecisions, changed) }],
  };
}

/** Compute the state + effects produced by entering `step`. */
function enterStep(baseState, step) {
  const common = { ...baseState, step, error: null, history: [...baseState.history, step] };
  if (step === 'generate') {
    return {
      state: freezeState({ ...common, status: STATUS.RUNNING, job: null }),
      effects: [
        {
          kind: 'start-job',
          operation: 'generate',
          request: { refresh: false, decisions: { ...baseState.decisions } },
        },
      ],
    };
  }
  if (step === 'ready') {
    return {
      state: freezeState({ ...common, status: STATUS.DONE }),
      effects: [
        { kind: 'persist', patch: { onboarding: { ...baseState.decisions, status: 'ready' } } },
      ],
    };
  }
  // Any decision step → wait for input (or for an already-seeded NEXT).
  return { state: freezeState({ ...common, status: STATUS.AWAITING_INPUT }), effects: [] };
}

/** Handle NEXT (advance through the spine subject to the pure guard). */
function reduceNext(state) {
  if (!canAdvance(state)) {
    return withError(
      state,
      ONBOARDING_ERRORS.GUARD_BLOCKED,
      `Cannot advance from "${state.step}" — its guard is not satisfied.`,
    );
  }
  const next = ONBOARDING_STEPS[stepIndex(state.step) + 1];
  return enterStep(state, next);
}

/** Handle BACK (rewind one step; clears the job when leaving generate). */
function reduceBack(state) {
  const idx = stepIndex(state.step);
  if (idx <= 0) {
    return withError(state, ONBOARDING_ERRORS.AT_START, 'Already at the first step.');
  }
  const prev = ONBOARDING_STEPS[idx - 1];
  const history = state.history.slice(0, -1);
  return {
    state: freezeState({
      ...state,
      step: prev,
      status: prev === 'preflight' ? STATUS.AWAITING_INPUT : STATUS.AWAITING_INPUT,
      job: state.step === 'generate' ? null : state.job,
      needs: null,
      error: null,
      history: history.length ? history : ['preflight'],
    }),
    effects: [],
  };
}

/** Handle START (kick off the preflight effect from the idle entry state). */
function reduceStart(state) {
  if (state.step !== 'preflight' || state.status !== STATUS.IDLE) {
    return { state: freezeState(state), effects: [] };
  }
  return {
    state: freezeState({ ...state, status: STATUS.RUNNING }),
    effects: [{ kind: 'preflight' }],
  };
}

/** Handle PREFLIGHT_RESULT (record diagnostics; gate advancement). */
function reducePreflightResult(state, event) {
  const result = event.result ?? {};
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const ok = result.ok ?? !diagnostics.some((d) => d.level === 'error');
  return {
    state: freezeState({
      ...state,
      diagnostics,
      status: ok ? STATUS.AWAITING_INPUT : STATUS.BLOCKED,
      error: null,
    }),
    effects: [],
  };
}

const JOB_STATUS_MAP = Object.freeze({
  running: STATUS.RUNNING,
  succeeded: STATUS.AWAITING_INPUT,
  failed: STATUS.FAILED,
  cancelled: STATUS.BLOCKED,
  awaiting_credential: STATUS.BLOCKED,
});

/** Handle JOB_UPDATE (fold a generate-job snapshot into the state). */
function reduceJobUpdate(state, event) {
  if (state.step !== 'generate') {
    return { state: freezeState(state), effects: [] };
  }
  const snapshot = event.snapshot ?? {};
  const status = JOB_STATUS_MAP[snapshot.status] ?? state.status;
  return {
    state: freezeState({
      ...state,
      job: snapshot,
      status,
      needs: snapshot.needs ?? null,
      error:
        snapshot.status === 'failed'
          ? snapshot.error ?? { code: 'EXECUTION_FAILED', message: 'generate failed' }
          : null,
    }),
    effects: [],
  };
}

/**
 * The pure transition function. Given the current `state` and an `event`, returns
 * the next `state` plus any declarative `effects` to run. Never mutates `state`,
 * never performs I/O, never reads the clock.
 *
 * Events:
 *   - `{ type: 'START' }`                         — begin (emits a `preflight` effect)
 *   - `{ type: 'PREFLIGHT_RESULT', result }`      — feed back the preflight outcome
 *   - `{ type: 'DECIDE', step, value }`           — record a genesis decision
 *   - `{ type: 'NEXT' }`                          — advance one step (guarded)
 *   - `{ type: 'BACK' }`                          — rewind one step
 *   - `{ type: 'JOB_UPDATE', snapshot }`          — feed back a generate-job snapshot
 *   - `{ type: 'RESET' }`                         — rewind to the start, keeping decisions
 *
 * @param {object} state
 * @param {{ type: string, [k: string]: * }} event
 * @returns {{ state: Readonly<object>, effects: object[] }}
 */
export function onboardingReducer(state, event) {
  switch (event?.type) {
    case 'START':
      return reduceStart(state);
    case 'PREFLIGHT_RESULT':
      return reducePreflightResult(state, event);
    case 'DECIDE':
      return reduceDecide(state, event);
    case 'NEXT':
      return reduceNext(state);
    case 'BACK':
      return reduceBack(state);
    case 'JOB_UPDATE':
      return reduceJobUpdate(state, event);
    case 'RESET':
      return { state: createOnboardingMachine({ decisions: state.decisions }), effects: [] };
    default:
      return withError(
        state,
        ONBOARDING_ERRORS.INVALID_INPUT,
        `Unknown event type: "${event?.type}"`,
      );
  }
}

/**
 * Apply one declarative effect through the injected seams, dispatching any
 * resulting events back into the machine. Returns the effects those dispatched
 * events produced (so the driver can keep draining).
 *
 * @param {object} effect
 * @param {object} seams
 * @param {(event: object) => object[]} dispatch  Applies an event and returns its effects.
 * @returns {Promise<object[]>}
 */
async function applyEffect(effect, seams, dispatch) {
  switch (effect.kind) {
    case 'preflight': {
      const result = seams.preflight ? await seams.preflight() : { ok: true, diagnostics: [] };
      return dispatch({ type: 'PREFLIGHT_RESULT', result });
    }
    case 'persist': {
      if (seams.persist) await seams.persist(effect.patch);
      return [];
    }
    case 'start-job': {
      if (typeof seams.startGenerate !== 'function') {
        throw new Error('driveOnboarding requires a seams.startGenerate seam to run the generate step.');
      }
      const snapshot = await seams.startGenerate(effect);
      return dispatch({ type: 'JOB_UPDATE', snapshot });
    }
    default:
      return [];
  }
}

/**
 * Thin async runner — the *only* impure piece, and fully seam-injected. Drives the
 * flow forward autonomously: bootstraps preflight, drains every emitted effect
 * through {@link applyEffect}, and calls NEXT whenever the pure guard is
 * satisfied. Used by the headless (`--yes`) genesis path and by tests; an
 * interactive surface can instead call {@link onboardingReducer} directly per user
 * action and run effects itself.
 *
 * Stops when the flow reaches a terminal status (`done`/`failed`), is `blocked`,
 * or is waiting on input the seeded decisions didn't provide.
 *
 * @param {object} initial   A state from {@link createOnboardingMachine}.
 * @param {object} seams      { preflight?, persist?, startGenerate? }
 * @param {object} [opts]
 * @param {number} [opts.maxIterations=100]  Safety bound against effect loops.
 * @returns {Promise<Readonly<object>>} The final state.
 */
export async function driveOnboarding(initial, seams = {}, { maxIterations = 100 } = {}) {
  let state = initial;
  const dispatch = (event) => {
    const result = onboardingReducer(state, event);
    state = result.state;
    return result.effects;
  };

  let pending = [];
  if (state.step === 'preflight' && state.status === STATUS.IDLE) {
    pending = dispatch({ type: 'START' });
  }

  let iterations = 0;
  while (iterations++ < maxIterations) {
    while (pending.length) {
      if (iterations++ >= maxIterations) {
        throw new Error('driveOnboarding exceeded its iteration budget (effect loop?).');
      }
      const effect = pending.shift();
      const produced = await applyEffect(effect, seams, dispatch);
      if (produced.length) pending.push(...produced);
    }
    if (state.status === STATUS.DONE || state.status === STATUS.FAILED || state.status === STATUS.BLOCKED) {
      break;
    }
    if (state.status === STATUS.AWAITING_INPUT && canAdvance(state)) {
      pending = dispatch({ type: 'NEXT' });
      continue;
    }
    break; // waiting for external input the seeds didn't supply
  }
  return state;
}
