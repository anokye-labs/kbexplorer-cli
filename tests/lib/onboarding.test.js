import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  ONBOARDING_STEPS,
  STATUS,
  DECISION_ENUMS,
  STEP_DECISION_KEYS,
  ONBOARDING_ERRORS,
  createOnboardingMachine,
  onboardingReducer,
  canAdvance,
  isTerminal,
  nextActions,
  driveOnboarding,
} = await import('../../src/lib/onboarding.js');

/** Apply a sequence of events, returning the final state (effects discarded). */
function run(state, events) {
  let s = state;
  for (const e of events) ({ state: s } = onboardingReducer(s, e));
  return s;
}

/** Seed every decision so the flow can run headlessly end-to-end. */
const FULL_DECISIONS = {
  strategy: 'vendor',
  contentMode: 'both',
  visual: 'sprites',
  theme: 'light',
  search: 'semantic',
};

describe('createOnboardingMachine (#149)', () => {
  it('starts at preflight/idle with null decisions and a single-step history', () => {
    const m = createOnboardingMachine();
    assert.equal(m.step, 'preflight');
    assert.equal(m.status, STATUS.IDLE);
    assert.deepEqual(m.history, ['preflight']);
    assert.deepEqual(m.decisions, {
      strategy: null,
      contentMode: null,
      visual: null,
      theme: null,
      search: null,
    });
    assert.equal(m.job, null);
    assert.equal(m.error, null);
  });

  it('pre-seeds decisions when provided', () => {
    const m = createOnboardingMachine({ decisions: { strategy: 'vendor', theme: 'sepia' } });
    assert.equal(m.decisions.strategy, 'vendor');
    assert.equal(m.decisions.theme, 'sepia');
    assert.equal(m.decisions.visual, null);
  });

  it('returns a frozen, defensively-copied state', () => {
    const m = createOnboardingMachine();
    assert.ok(Object.isFrozen(m));
    assert.ok(Object.isFrozen(m.decisions));
    assert.throws(() => {
      m.decisions.strategy = 'vendor';
    });
  });

  it('exposes the canonical spine in order', () => {
    assert.deepEqual(ONBOARDING_STEPS, [
      'preflight',
      'template-strategy',
      'content-mode',
      'visual-identity',
      'search-mode',
      'generate',
      'ready',
    ]);
  });
});

describe('decision vocabulary matches init.js (#149)', () => {
  it('enumerates the same content modes, visual modes and themes as the wizard', () => {
    assert.deepEqual([...DECISION_ENUMS.contentMode], ['repo', 'authored', 'both']);
    assert.deepEqual([...DECISION_ENUMS.visual], ['emoji', 'sprites', 'heroes', 'none']);
    assert.deepEqual([...DECISION_ENUMS.theme], ['dark', 'light', 'sepia']);
    assert.deepEqual([...DECISION_ENUMS.strategy], ['submodule', 'vendor']);
    assert.deepEqual([...DECISION_ENUMS.search], ['none', 'local', 'semantic']);
  });

  it('maps visual-identity to two decision keys and others to one', () => {
    assert.deepEqual([...STEP_DECISION_KEYS['visual-identity']], ['visual', 'theme']);
    assert.deepEqual([...STEP_DECISION_KEYS['template-strategy']], ['strategy']);
  });
});

describe('START + preflight gating (#152 composition)', () => {
  it('START emits a preflight effect and moves to running', () => {
    const { state, effects } = onboardingReducer(createOnboardingMachine(), { type: 'START' });
    assert.equal(state.status, STATUS.RUNNING);
    assert.deepEqual(effects, [{ kind: 'preflight' }]);
  });

  it('START is a no-op once past the idle entry', () => {
    const running = run(createOnboardingMachine(), [{ type: 'START' }]);
    const { state, effects } = onboardingReducer(running, { type: 'START' });
    assert.equal(state.status, STATUS.RUNNING);
    assert.deepEqual(effects, []);
  });

  it('a clean preflight result unblocks advancement', () => {
    const s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [] } },
    ]);
    assert.equal(s.status, STATUS.AWAITING_INPUT);
    assert.equal(canAdvance(s), true);
  });

  it('a hard error blocks advancement and records diagnostics', () => {
    const diag = { level: 'error', id: 'node-version', message: 'too old', recovery: 'upgrade' };
    const s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: false, diagnostics: [diag] } },
    ]);
    assert.equal(s.status, STATUS.BLOCKED);
    assert.equal(canAdvance(s), false);
    assert.deepEqual(s.diagnostics, [diag]);
    const blocked = onboardingReducer(s, { type: 'NEXT' });
    assert.equal(blocked.state.step, 'preflight');
    assert.equal(blocked.state.error.code, ONBOARDING_ERRORS.GUARD_BLOCKED);
  });

  it('warnings do not block advancement', () => {
    const warn = { level: 'warn', id: 'git-remote', message: 'no remote', recovery: 'add one' };
    const s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [warn] } },
    ]);
    assert.equal(canAdvance(s), true);
  });

  it('derives ok from the diagnostics when result.ok is omitted', () => {
    const s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { diagnostics: [{ level: 'warn', message: 'x' }] } },
    ]);
    assert.equal(canAdvance(s), true);
  });
});

describe('DECIDE validation (#149)', () => {
  function atStrategy() {
    return run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [] } },
      { type: 'NEXT' },
    ]);
  }

  it('accepts a valid scalar decision and emits a persist effect', () => {
    const { state, effects } = onboardingReducer(atStrategy(), {
      type: 'DECIDE',
      step: 'template-strategy',
      value: 'vendor',
    });
    assert.equal(state.decisions.strategy, 'vendor');
    assert.equal(state.status, STATUS.AWAITING_INPUT);
    assert.deepEqual(effects, [{ kind: 'persist', patch: { onboarding: { strategy: 'vendor' } } }]);
  });

  it('rejects an out-of-enum value without transitioning', () => {
    const before = atStrategy();
    const { state, effects } = onboardingReducer(before, {
      type: 'DECIDE',
      step: 'template-strategy',
      value: 'nope',
    });
    assert.equal(state.decisions.strategy, null);
    assert.equal(state.error.code, ONBOARDING_ERRORS.INVALID_INPUT);
    assert.deepEqual(effects, []);
  });

  it('rejects an unknown decision step', () => {
    const { state } = onboardingReducer(atStrategy(), {
      type: 'DECIDE',
      step: 'not-a-step',
      value: 'x',
    });
    assert.equal(state.error.code, ONBOARDING_ERRORS.INVALID_INPUT);
  });

  it('accepts the two-key visual-identity decision as an object', () => {
    const m = createOnboardingMachine();
    const { state, effects } = onboardingReducer(m, {
      type: 'DECIDE',
      step: 'visual-identity',
      value: { visual: 'heroes', theme: 'sepia' },
    });
    assert.equal(state.decisions.visual, 'heroes');
    assert.equal(state.decisions.theme, 'sepia');
    assert.deepEqual(effects, [
      { kind: 'persist', patch: { onboarding: { visual: 'heroes', theme: 'sepia' } } },
    ]);
  });

  it('rejects a decision key that does not belong to the step', () => {
    const { state } = onboardingReducer(createOnboardingMachine(), {
      type: 'DECIDE',
      step: 'content-mode',
      value: { theme: 'dark' },
    });
    assert.equal(state.error.code, ONBOARDING_ERRORS.INVALID_INPUT);
  });

  it('clears a prior error on a subsequent valid decision', () => {
    let s = atStrategy();
    ({ state: s } = onboardingReducer(s, { type: 'DECIDE', step: 'template-strategy', value: 'bad' }));
    assert.ok(s.error);
    ({ state: s } = onboardingReducer(s, { type: 'DECIDE', step: 'template-strategy', value: 'submodule' }));
    assert.equal(s.error, null);
  });
});

describe('advancement guards (#149)', () => {
  it('a decision step will not advance until its decision is set', () => {
    let s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [] } },
      { type: 'NEXT' }, // -> template-strategy
    ]);
    assert.equal(s.step, 'template-strategy');
    assert.equal(canAdvance(s), false);
    const blocked = onboardingReducer(s, { type: 'NEXT' });
    assert.equal(blocked.state.step, 'template-strategy');
    assert.equal(blocked.state.error.code, ONBOARDING_ERRORS.GUARD_BLOCKED);
  });

  it('visual-identity needs BOTH visual and theme', () => {
    let s = createOnboardingMachine({ decisions: { visual: 'emoji' } });
    s = { ...s, step: 'visual-identity', status: STATUS.AWAITING_INPUT };
    assert.equal(canAdvance(s), false);
  });
});

describe('BACK / RESET (#149)', () => {
  it('BACK rewinds one step and trims history', () => {
    let s = run(createOnboardingMachine(), [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [] } },
      { type: 'NEXT' }, // template-strategy
    ]);
    assert.deepEqual(s.history, ['preflight', 'template-strategy']);
    ({ state: s } = onboardingReducer(s, { type: 'BACK' }));
    assert.equal(s.step, 'preflight');
    assert.deepEqual(s.history, ['preflight']);
  });

  it('BACK at the first step errors', () => {
    const { state } = onboardingReducer(createOnboardingMachine(), { type: 'BACK' });
    assert.equal(state.error.code, ONBOARDING_ERRORS.AT_START);
  });

  it('RESET rewinds to preflight but keeps decisions', () => {
    let s = createOnboardingMachine({ decisions: FULL_DECISIONS });
    s = { ...s, step: 'search-mode', status: STATUS.AWAITING_INPUT, history: ['preflight', 'x'] };
    const { state } = onboardingReducer(s, { type: 'RESET' });
    assert.equal(state.step, 'preflight');
    assert.equal(state.status, STATUS.IDLE);
    assert.equal(state.decisions.strategy, 'vendor');
  });
});

describe('generate step composes with the job layer (#154)', () => {
  function atGenerate() {
    // Walk to search-mode with all decisions set, then NEXT into generate.
    let s = createOnboardingMachine({ decisions: FULL_DECISIONS });
    s = run(s, [
      { type: 'START' },
      { type: 'PREFLIGHT_RESULT', result: { ok: true, diagnostics: [] } },
      { type: 'NEXT' }, // template-strategy
      { type: 'NEXT' }, // content-mode
      { type: 'NEXT' }, // visual-identity
      { type: 'NEXT' }, // search-mode
    ]);
    assert.equal(s.step, 'search-mode');
    return onboardingReducer(s, { type: 'NEXT' });
  }

  it('entering generate emits a start-job effect carrying the decisions', () => {
    const { state, effects } = atGenerate();
    assert.equal(state.step, 'generate');
    assert.equal(state.status, STATUS.RUNNING);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].kind, 'start-job');
    assert.equal(effects[0].operation, 'generate');
    assert.deepEqual(effects[0].request.decisions, FULL_DECISIONS);
  });

  it('a running snapshot keeps the flow running and ungated', () => {
    const { state } = atGenerate();
    const { state: s2 } = onboardingReducer(state, {
      type: 'JOB_UPDATE',
      snapshot: { id: 'job_1', status: 'running' },
    });
    assert.equal(s2.status, STATUS.RUNNING);
    assert.equal(canAdvance(s2), false);
  });

  it('a succeeded snapshot unblocks the final advance to ready', () => {
    const { state } = atGenerate();
    const { state: s2 } = onboardingReducer(state, {
      type: 'JOB_UPDATE',
      snapshot: { id: 'job_1', status: 'succeeded', changeCount: 3 },
    });
    assert.equal(s2.status, STATUS.AWAITING_INPUT);
    assert.equal(canAdvance(s2), true);
    const { state: ready, effects } = onboardingReducer(s2, { type: 'NEXT' });
    assert.equal(ready.step, 'ready');
    assert.equal(ready.status, STATUS.DONE);
    assert.ok(isTerminal(ready));
    assert.deepEqual(effects, [
      { kind: 'persist', patch: { onboarding: { ...FULL_DECISIONS, status: 'ready' } } },
    ]);
    assert.deepEqual(nextActions(ready), ['dev', 'build']);
  });

  it('a failed snapshot moves to failed with the job error', () => {
    const { state } = atGenerate();
    const { state: s2 } = onboardingReducer(state, {
      type: 'JOB_UPDATE',
      snapshot: { id: 'job_1', status: 'failed', error: { code: 'BOOM', message: 'kaboom' } },
    });
    assert.equal(s2.status, STATUS.FAILED);
    assert.ok(isTerminal(s2));
    assert.deepEqual(s2.error, { code: 'BOOM', message: 'kaboom' });
  });

  it('an awaiting_credential snapshot blocks with the needs surfaced', () => {
    const { state } = atGenerate();
    const { state: s2 } = onboardingReducer(state, {
      type: 'JOB_UPDATE',
      snapshot: { id: 'job_1', status: 'awaiting_credential', needs: { credential: 'GITHUB_TOKEN' } },
    });
    assert.equal(s2.status, STATUS.BLOCKED);
    assert.deepEqual(s2.needs, { credential: 'GITHUB_TOKEN' });
  });

  it('ignores a JOB_UPDATE outside the generate step', () => {
    const m = createOnboardingMachine();
    const { state } = onboardingReducer(m, { type: 'JOB_UPDATE', snapshot: { status: 'succeeded' } });
    assert.equal(state.step, 'preflight');
    assert.equal(state.job, null);
  });
});

describe('purity & misc', () => {
  it('does not mutate the input state', () => {
    const m = createOnboardingMachine();
    onboardingReducer(m, { type: 'START' });
    assert.equal(m.status, STATUS.IDLE);
  });

  it('an unknown event type yields an INVALID_INPUT error, no transition', () => {
    const m = createOnboardingMachine();
    const { state, effects } = onboardingReducer(m, { type: 'NONSENSE' });
    assert.equal(state.step, 'preflight');
    assert.equal(state.error.code, ONBOARDING_ERRORS.INVALID_INPUT);
    assert.deepEqual(effects, []);
  });
});

describe('driveOnboarding runner (seam-injected effects)', () => {
  it('runs an all-seeded flow end-to-end to ready', async () => {
    const persisted = [];
    const seams = {
      preflight: async () => ({ ok: true, diagnostics: [] }),
      persist: async (patch) => persisted.push(patch),
      startGenerate: async (effect) => {
        assert.equal(effect.operation, 'generate');
        return { id: 'job_x', status: 'succeeded', changeCount: 2 };
      },
    };
    const final = await driveOnboarding(createOnboardingMachine({ decisions: FULL_DECISIONS }), seams);
    assert.equal(final.step, 'ready');
    assert.equal(final.status, STATUS.DONE);
    // Final persist records the terminal onboarding record.
    const last = persisted[persisted.length - 1];
    assert.equal(last.onboarding.status, 'ready');
    assert.equal(last.onboarding.strategy, 'vendor');
  });

  it('halts at a blocking preflight error without touching generate', async () => {
    let generateCalled = false;
    const seams = {
      preflight: async () => ({
        ok: false,
        diagnostics: [{ level: 'error', id: 'node-version', message: 'old', recovery: 'upgrade' }],
      }),
      startGenerate: async () => {
        generateCalled = true;
        return { status: 'succeeded' };
      },
    };
    const final = await driveOnboarding(createOnboardingMachine({ decisions: FULL_DECISIONS }), seams);
    assert.equal(final.status, STATUS.BLOCKED);
    assert.equal(final.step, 'preflight');
    assert.equal(generateCalled, false);
  });

  it('stops awaiting input when a decision was not seeded', async () => {
    const seams = {
      preflight: async () => ({ ok: true, diagnostics: [] }),
      persist: async () => {},
      startGenerate: async () => ({ status: 'succeeded' }),
    };
    // Missing `strategy` — flow should stall at template-strategy.
    const seed = { ...FULL_DECISIONS };
    delete seed.strategy;
    const final = await driveOnboarding(createOnboardingMachine({ decisions: seed }), seams);
    assert.equal(final.step, 'template-strategy');
    assert.equal(final.status, STATUS.AWAITING_INPUT);
  });

  it('surfaces a generate-job failure as a terminal failed state', async () => {
    const seams = {
      preflight: async () => ({ ok: true, diagnostics: [] }),
      persist: async () => {},
      startGenerate: async () => ({ status: 'failed', error: { code: 'X', message: 'no' } }),
    };
    const final = await driveOnboarding(createOnboardingMachine({ decisions: FULL_DECISIONS }), seams);
    assert.equal(final.status, STATUS.FAILED);
    assert.equal(final.step, 'generate');
  });

  it('throws a clear error when the generate seam is missing', async () => {
    const seams = { preflight: async () => ({ ok: true, diagnostics: [] }), persist: async () => {} };
    await assert.rejects(
      () => driveOnboarding(createOnboardingMachine({ decisions: FULL_DECISIONS }), seams),
      /seams\.startGenerate/,
    );
  });
});
