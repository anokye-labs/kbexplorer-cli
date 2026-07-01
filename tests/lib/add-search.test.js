import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  SEARCH_MODES,
  SEARCH_MODE_PROFILES,
  SEARCH_PACKAGE,
  DEFAULT_ARTIFACT_DIR,
  SEARCH_ARTIFACT_FILES,
  ADD_SEARCH_STEPS,
  ADD_SEARCH_STATUS,
  ADD_SEARCH_ERRORS,
  planAddSearch,
  applyAddSearch,
} = await import('../../src/lib/add-search.js');

describe('planAddSearch (#151 pure planner)', () => {
  it('none is a no-op plan with no steps', () => {
    const plan = planAddSearch(SEARCH_MODES.NONE);
    assert.equal(plan.mode, 'none');
    assert.equal(plan.needsAction, false);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.artifacts, []);
    assert.equal(plan.needsCredential, false);
  });

  it('local builds a zero-credential lexical plan', () => {
    const plan = planAddSearch(SEARCH_MODES.LOCAL);
    assert.equal(plan.needsAction, true);
    assert.equal(plan.kind, 'lexical');
    assert.equal(plan.provider, 'lexical');
    assert.equal(plan.requiresCredential, false);
    assert.equal(plan.needsCredential, false);
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      ADD_SEARCH_STEPS,
    );
  });

  it('semantic builds a BYO-key vector plan and flags a missing credential', () => {
    const withKey = planAddSearch(SEARCH_MODES.SEMANTIC, { hasCredential: true });
    assert.equal(withKey.kind, 'vector');
    assert.equal(withKey.provider, 'openai');
    assert.equal(withKey.model, 'text-embedding-3-small');
    assert.equal(withKey.requiresCredential, true);
    assert.equal(withKey.needsCredential, false);
    assert.equal(withKey.credentialEnv, 'OPENAI_API_KEY');

    const noKey = planAddSearch(SEARCH_MODES.SEMANTIC, { hasCredential: false });
    assert.equal(noKey.needsCredential, true);
  });

  it('defaults hasCredential to true so the planner never reads process.env', () => {
    const plan = planAddSearch(SEARCH_MODES.SEMANTIC);
    assert.equal(plan.needsCredential, false);
  });

  it('honours a custom artifact dir in the committed artifact paths + CI command', () => {
    const plan = planAddSearch(SEARCH_MODES.LOCAL, { artifactDir: '.idx' });
    assert.equal(plan.artifactDir, '.idx');
    assert.deepEqual(
      plan.artifacts,
      SEARCH_ARTIFACT_FILES.map((f) => `.idx/${f}`),
    );
    const ci = plan.steps.find((s) => s.id === 'configure-ci-gate');
    assert.equal(ci.command, 'kbx search-index --check --dir .idx');
  });

  it('lets provider/model be overridden while keeping the mode profile kind', () => {
    const plan = planAddSearch(SEARCH_MODES.SEMANTIC, { provider: 'cohere', model: 'embed-v3' });
    assert.equal(plan.provider, 'cohere');
    assert.equal(plan.model, 'embed-v3');
    assert.equal(plan.kind, 'vector');
    const build = plan.steps.find((s) => s.id === 'build-index');
    assert.equal(build.provider, 'cohere');
    assert.equal(build.model, 'embed-v3');
  });

  it('install step targets the search package', () => {
    const plan = planAddSearch(SEARCH_MODES.LOCAL);
    const install = plan.steps.find((s) => s.id === 'install-dependency');
    assert.equal(install.pkg, SEARCH_PACKAGE);
  });

  it('is deterministic: same inputs → deep-equal plans', () => {
    const a = planAddSearch(SEARCH_MODES.LOCAL, { artifactDir: '.search' });
    const b = planAddSearch(SEARCH_MODES.LOCAL, { artifactDir: '.search' });
    assert.deepEqual(a, b);
  });

  it('returns frozen plans', () => {
    const plan = planAddSearch(SEARCH_MODES.LOCAL);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.steps));
    assert.ok(plan.steps.every((s) => Object.isFrozen(s)));
  });

  it('throws on an unknown mode', () => {
    assert.throws(() => planAddSearch('quantum'), /unknown search mode/);
  });

  it('default artifact dir is .search with the three committed files', () => {
    assert.equal(DEFAULT_ARTIFACT_DIR, '.search');
    assert.deepEqual([...SEARCH_ARTIFACT_FILES], ['index-meta.json', 'units.json', 'vectors.json']);
    assert.ok(SEARCH_MODE_PROFILES[SEARCH_MODES.LOCAL]);
  });
});

describe('applyAddSearch (#151 seam-injected executor)', () => {
  it('skips a none plan without touching any seam', async () => {
    let touched = false;
    const seams = { installDependency: () => (touched = true) };
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.NONE), seams);
    assert.equal(result.status, ADD_SEARCH_STATUS.SKIPPED);
    assert.equal(touched, false);
    assert.deepEqual(result.stepsRun, []);
  });

  it('runs the full local chain in fixed order through the sub-seams', async () => {
    const calls = [];
    const seams = {
      installDependency: (s) => calls.push(s.id),
      buildIndex: (s) => calls.push(s.id),
      stageArtifacts: (s) => calls.push(s.id),
      configureCiGate: (s) => calls.push(s.id),
    };
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.LOCAL), seams);
    assert.equal(result.status, ADD_SEARCH_STATUS.SUCCEEDED);
    assert.deepEqual(calls, ADD_SEARCH_STEPS);
    assert.deepEqual(result.stepsRun, ADD_SEARCH_STEPS);
    assert.equal(result.provider, 'lexical');
  });

  it('is a hermetic dry-run when no seams are supplied (still succeeds)', async () => {
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.LOCAL));
    assert.equal(result.status, ADD_SEARCH_STATUS.SUCCEEDED);
    assert.deepEqual(result.stepsRun, ADD_SEARCH_STEPS);
  });

  it('semantic with the credential present runs the vector build', async () => {
    const built = [];
    const seams = {
      hasCredential: () => true,
      buildIndex: (s) => built.push(s.provider),
    };
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.SEMANTIC, { hasCredential: false }), seams);
    assert.equal(result.status, ADD_SEARCH_STATUS.SUCCEEDED);
    assert.deepEqual(built, ['openai']);
  });

  it('semantic with no credential settles awaiting_credential BEFORE building', async () => {
    let builtCalled = false;
    const seams = {
      hasCredential: () => false,
      buildIndex: () => (builtCalled = true),
    };
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.SEMANTIC), seams);
    assert.equal(result.status, ADD_SEARCH_STATUS.AWAITING_CREDENTIAL);
    assert.equal(builtCalled, false);
    assert.equal(result.needs.kind, 'credential');
    assert.equal(result.needs.env, 'OPENAI_API_KEY');
  });

  it('trusts the plan needsCredential flag when no hasCredential seam is given', async () => {
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.SEMANTIC, { hasCredential: false }));
    assert.equal(result.status, ADD_SEARCH_STATUS.AWAITING_CREDENTIAL);
  });

  it('surfaces a typed failure when a step throws, recording steps already run', async () => {
    const seams = {
      installDependency: () => {},
      buildIndex: () => {
        throw new Error('embedding provider offline');
      },
    };
    const result = await applyAddSearch(planAddSearch(SEARCH_MODES.LOCAL), seams);
    assert.equal(result.status, ADD_SEARCH_STATUS.FAILED);
    assert.equal(result.error.code, ADD_SEARCH_ERRORS.STEP_FAILED);
    assert.equal(result.error.step, 'build-index');
    assert.deepEqual(result.stepsRun, ['install-dependency']);
  });

  it('persists a success summary under onboarding.search when a persist seam is given', async () => {
    const patches = [];
    const seams = { persist: (p) => patches.push(p) };
    await applyAddSearch(planAddSearch(SEARCH_MODES.LOCAL), seams);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].onboarding.search.mode, 'local');
    assert.equal(patches[0].onboarding.search.status, ADD_SEARCH_STATUS.SUCCEEDED);
  });

  it('rejects a non-object plan with a typed error', async () => {
    const result = await applyAddSearch(null);
    assert.equal(result.status, ADD_SEARCH_STATUS.FAILED);
    assert.equal(result.error.code, ADD_SEARCH_ERRORS.INVALID_MODE);
  });
});
