/**
 * Add-search — the actionable opt-in chain behind the onboarding `search-mode`
 * decision (PE2-F4, #151, part of epic anokye-labs/kbexplorer#20).
 *
 * The onboarding state machine ({@link module:src/lib/onboarding}) only *records*
 * the `search` choice (`none | local | semantic`). Recording it is not enough: a
 * user who says "yes, add search" cannot discover the whole chain that makes
 * search real — installing `@anokye-labs/kbexplorer-search`, building the index,
 * committing `.search/{index-meta,units,vectors}.json`, and wiring the
 * `kbx search-index --check` CI drift gate. That is the "search cliff" from the
 * narrative (§2a). This module *performs* that chain, keeping the machine's
 * reducer pure: the machine emits a declarative `add-search` effect descriptor,
 * and this module is the injected seam that executes it.
 *
 * Two axes of search (narrative §8.5 — do NOT imply semantic-by-default):
 *   - `local`    → **lexical**, ZERO-credential. Builds a keyword index with the
 *                  `lexical` provider — no embedding API key, fully offline and
 *                  deterministic.
 *   - `semantic` → **vector**, bring-your-own-key. Builds embeddings with a vector
 *                  provider (default `openai` / `text-embedding-3-small`), which
 *                  needs a credential (e.g. `OPENAI_API_KEY`). When the credential
 *                  is absent the plan flags `needsCredential` and the executor
 *                  settles `awaiting_credential` so the surface can block rather
 *                  than silently skip.
 *
 * The design mirrors the rest of onboarding: a **pure planner**
 * ({@link planAddSearch}) turns a mode into a deterministic, ordered list of
 * declarative steps with no I/O, and an **impure executor**
 * ({@link applyAddSearch}) runs those steps through injected sub-seams so the
 * whole thing is hermetically testable.
 *
 * @module src/lib/add-search
 */

/** The three search modes, matching `DECISION_ENUMS.search` in onboarding.js. */
export const SEARCH_MODES = Object.freeze({
  NONE: 'none',
  LOCAL: 'local',
  SEMANTIC: 'semantic',
});

/**
 * How each actionable mode maps onto a search index kind + embedding provider.
 * `local` is the zero-credential lexical index; `semantic` is the BYO-key vector
 * index. Overridable via {@link planAddSearch} options, but these are the
 * documented defaults.
 *
 * @type {Readonly<Record<string, { kind: string, provider: string, model: string|null, requiresCredential: boolean, credentialEnv: string|null }>>}
 */
export const SEARCH_MODE_PROFILES = Object.freeze({
  [SEARCH_MODES.LOCAL]: Object.freeze({
    kind: 'lexical',
    provider: 'lexical',
    model: null,
    requiresCredential: false,
    credentialEnv: null,
  }),
  [SEARCH_MODES.SEMANTIC]: Object.freeze({
    kind: 'vector',
    provider: 'openai',
    model: 'text-embedding-3-small',
    requiresCredential: true,
    credentialEnv: 'OPENAI_API_KEY',
  }),
});

/** The search package the chain installs and builds against. */
export const SEARCH_PACKAGE = '@anokye-labs/kbexplorer-search';

/** Default artifact directory + the fixed set of files the index build commits. */
export const DEFAULT_ARTIFACT_DIR = '.search';
export const SEARCH_ARTIFACT_FILES = Object.freeze([
  'index-meta.json',
  'units.json',
  'vectors.json',
]);

/** The ordered steps of the opt-in chain. Fixed order → deterministic. */
export const ADD_SEARCH_STEPS = Object.freeze([
  'install-dependency',
  'build-index',
  'stage-artifacts',
  'configure-ci-gate',
]);

/** Stable, machine-readable status values an add-search run can settle to. */
export const ADD_SEARCH_STATUS = Object.freeze({
  /** The chosen mode was `none` — nothing to do. */
  SKIPPED: 'skipped',
  /** Every step ran and the artifacts are in place. */
  SUCCEEDED: 'succeeded',
  /** Semantic mode but no embedding credential — surface a `needs`, do not skip. */
  AWAITING_CREDENTIAL: 'awaiting_credential',
  /** A step threw. Carries a typed error. */
  FAILED: 'failed',
});

/** Stable error codes surfaced on a failed add-search result. */
export const ADD_SEARCH_ERRORS = Object.freeze({
  INVALID_MODE: 'INVALID_MODE',
  STEP_FAILED: 'STEP_FAILED',
});

function artifactPaths(dir) {
  return SEARCH_ARTIFACT_FILES.map((f) => `${dir}/${f}`);
}

/**
 * Pure planner. Turns a search mode into a deterministic, declarative plan the
 * executor can run. No I/O, no clock, no randomness — the same inputs always
 * yield a byte-identical plan.
 *
 * A `none` mode yields an empty step list (`needsAction: false`); the machine
 * never emits an add-search effect for it, but planning it is still well-defined.
 *
 * @param {string} mode  One of {@link SEARCH_MODES}.
 * @param {object} [opts]
 * @param {string} [opts.artifactDir='.search']  Where the index is written/committed.
 * @param {string} [opts.provider]  Override the profile's embedding provider.
 * @param {string} [opts.model]     Override the profile's embedding model.
 * @param {boolean} [opts.hasCredential]  Whether the required credential is present.
 *        Only consulted for credential-requiring (semantic) modes. Defaults to
 *        `true` so the pure planner never reads `process.env`.
 * @returns {Readonly<object>} `{ mode, needsAction, kind, provider, model,
 *          requiresCredential, needsCredential, artifactDir, artifacts, steps }`.
 */
export function planAddSearch(mode, opts = {}) {
  const {
    artifactDir = DEFAULT_ARTIFACT_DIR,
    provider: providerOverride,
    model: modelOverride,
    hasCredential = true,
  } = opts;

  if (mode === SEARCH_MODES.NONE) {
    return Object.freeze({
      mode,
      needsAction: false,
      kind: null,
      provider: null,
      model: null,
      requiresCredential: false,
      needsCredential: false,
      artifactDir,
      artifacts: Object.freeze([]),
      steps: Object.freeze([]),
    });
  }

  const profile = SEARCH_MODE_PROFILES[mode];
  if (!profile) {
    throw new Error(
      `planAddSearch: unknown search mode "${mode}" (expected ${Object.values(SEARCH_MODES).join('|')})`,
    );
  }

  const provider = providerOverride ?? profile.provider;
  const model = modelOverride ?? profile.model;
  const needsCredential = profile.requiresCredential && !hasCredential;
  const artifacts = artifactPaths(artifactDir);

  const steps = [
    { id: 'install-dependency', pkg: SEARCH_PACKAGE },
    { id: 'build-index', provider, model, artifactDir, kind: profile.kind },
    { id: 'stage-artifacts', paths: artifacts },
    { id: 'configure-ci-gate', command: `kbx search-index --check --dir ${artifactDir}` },
  ].map((s) => Object.freeze({ ...s }));

  return Object.freeze({
    mode,
    needsAction: true,
    kind: profile.kind,
    provider,
    model,
    requiresCredential: profile.requiresCredential,
    needsCredential,
    credentialEnv: profile.credentialEnv,
    artifactDir,
    artifacts: Object.freeze(artifacts),
    steps: Object.freeze(steps),
  });
}

function makeError(code, message, details = {}) {
  return { code, message, ...details };
}

/**
 * Impure executor. Runs a plan produced by {@link planAddSearch} through injected
 * sub-seams, in the fixed {@link ADD_SEARCH_STEPS} order, and returns a settled
 * result descriptor. Every side effect is a seam — with no seams supplied it is a
 * pure dry-run that reports what *would* happen, so it stays hermetic in tests.
 *
 * Steps short-circuit: for a credential-requiring mode with no credential, the
 * executor settles `awaiting_credential` *before* the build step, so no build,
 * stage or CI wiring is attempted against an unusable provider.
 *
 * @param {object} plan  A plan from {@link planAddSearch}.
 * @param {object} [seams]
 * @param {() => (boolean|Promise<boolean>)} [seams.hasCredential]  Resolve whether
 *        the embedding credential is present (semantic only). If omitted, the
 *        plan's own `needsCredential` flag is trusted.
 * @param {(step: object) => any} [seams.installDependency]  Ensure {@link SEARCH_PACKAGE}
 *        is a dependency of the project.
 * @param {(step: object) => any} [seams.buildIndex]  Build the search index
 *        (e.g. shell `kbx search-index --provider …`), writing `.search/`.
 * @param {(step: object) => any} [seams.stageArtifacts]  Stage the committed
 *        artifact files (e.g. `git add`).
 * @param {(step: object) => any} [seams.configureCiGate]  Ensure the
 *        `search-index --check` drift gate runs in CI.
 * @param {(patch: object) => any} [seams.persist]  Record the outcome in
 *        `.kbx.json` (deep-merged under the `onboarding.search` block).
 * @returns {Promise<Readonly<object>>} `{ status, mode, provider, model,
 *          artifactDir, artifacts, stepsRun, needs?, error? }`.
 */
export async function applyAddSearch(plan, seams = {}) {
  if (!plan || typeof plan !== 'object') {
    return Object.freeze({
      status: ADD_SEARCH_STATUS.FAILED,
      error: makeError(ADD_SEARCH_ERRORS.INVALID_MODE, 'applyAddSearch requires a plan object'),
    });
  }

  const base = {
    mode: plan.mode,
    provider: plan.provider,
    model: plan.model,
    artifactDir: plan.artifactDir,
    artifacts: plan.artifacts,
    stepsRun: [],
  };

  if (!plan.needsAction) {
    return Object.freeze({ ...base, status: ADD_SEARCH_STATUS.SKIPPED });
  }

  // Credential gate — consult the live seam when provided, else trust the plan.
  let needsCredential = plan.needsCredential;
  if (plan.requiresCredential && typeof seams.hasCredential === 'function') {
    needsCredential = !(await seams.hasCredential(plan));
  }
  if (needsCredential) {
    return Object.freeze({
      ...base,
      status: ADD_SEARCH_STATUS.AWAITING_CREDENTIAL,
      needs: {
        kind: 'credential',
        provider: plan.provider,
        env: plan.credentialEnv ?? null,
        message:
          `Semantic search uses the "${plan.provider}" embedding provider, which needs ` +
          `${plan.credentialEnv ? `\`${plan.credentialEnv}\`` : 'an API credential'}. ` +
          'Set it and re-run, or choose local (lexical) search.',
      },
    });
  }

  const seamForStep = {
    'install-dependency': seams.installDependency,
    'build-index': seams.buildIndex,
    'stage-artifacts': seams.stageArtifacts,
    'configure-ci-gate': seams.configureCiGate,
  };

  const stepsRun = [];
  for (const step of plan.steps) {
    const seam = seamForStep[step.id];
    try {
      if (typeof seam === 'function') await seam(step);
      stepsRun.push(step.id);
    } catch (err) {
      return Object.freeze({
        ...base,
        stepsRun,
        status: ADD_SEARCH_STATUS.FAILED,
        error: makeError(
          ADD_SEARCH_ERRORS.STEP_FAILED,
          `add-search step "${step.id}" failed: ${err?.message ?? String(err)}`,
          { step: step.id },
        ),
      });
    }
  }

  const result = { ...base, stepsRun, status: ADD_SEARCH_STATUS.SUCCEEDED };

  if (typeof seams.persist === 'function') {
    await seams.persist({
      onboarding: {
        search: {
          mode: plan.mode,
          kind: plan.kind,
          provider: plan.provider,
          artifactDir: plan.artifactDir,
          status: ADD_SEARCH_STATUS.SUCCEEDED,
        },
      },
    });
  }

  return Object.freeze(result);
}
