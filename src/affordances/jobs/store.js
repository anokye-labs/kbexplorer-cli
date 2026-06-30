/**
 * Job store — the runtime spine of the workflow/job layer (PE3-F2).
 *
 * The affordance contract (PE3-F1) is **stateless**: each action is a pure
 * context-in / result-out function. That is deliberately too narrow for the
 * long-running work this layer adds — generation/indexing that takes time, emits
 * progress, can be cancelled, may pause to ask for a late credential, can fail
 * partway, and finally writes back. Those concerns need a *handle* that survives
 * across several stateless calls (`start_generate` returns it; `get_job_status`,
 * `cancel_job`, `preview_changes`, `apply_changes`, `create_pr` all address it).
 *
 * This module is that handle's home. It is **protocol-neutral** — it imports no
 * MCP, JSON-RPC, canvas, or transport code, exactly like the rest of
 * `src/affordances/`. It is also runtime-agnostic: the store never calls a model,
 * git, or the network itself. The actual long-running work is supplied by the
 * caller through injected seams (`runGenerate`, `createPullRequest`), mirroring
 * how `derive` injects `runExtraction`.
 *
 * **Persistence model (the design question in #154).** Job state is a *runtime*
 * concern, held in this in-process store, not a committed artifact — so it carries
 * no timestamps and nothing about it is written to git by the store. The
 * "git-as-store / no timestamps in committed artifacts" rule applies to the
 * write-back products: `apply_changes` writes caller-provided file contents
 * **verbatim** (the store injects no clock), and job ids are **deterministic
 * content hashes** of the operation + canonical input + a per-store creation index
 * — reproducible for a given sequence of calls, never time-derived.
 *
 * @module src/affordances/jobs/store
 */

import { createHash } from 'node:crypto';

/**
 * Lifecycle states a job can occupy. A job is *settled* once it is no longer
 * `RUNNING` and is not waiting on a credential.
 *
 * @enum {string}
 */
export const JOB_STATUS = Object.freeze({
  /** Work is in flight (the injected runtime is executing). */
  RUNNING: 'running',
  /** Work finished and produced a (possibly empty) change set. */
  SUCCEEDED: 'succeeded',
  /** The injected runtime threw a non-credential error. */
  FAILED: 'failed',
  /** Cancelled via `cancel_job` before it could settle. */
  CANCELLED: 'cancelled',
  /** Paused: the runtime asked for a credential it was not given (late prompt). */
  AWAITING_CREDENTIAL: 'awaiting_credential',
});

const SETTLED = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);

/**
 * Raised by a runtime seam (via `getCredential`) when it needs a credential the
 * job was not started with. The job runner catches it and parks the job in
 * {@link JOB_STATUS.AWAITING_CREDENTIAL} rather than failing it, so a client can
 * prompt for the value and resume the *same* job.
 */
export class CredentialRequiredError extends Error {
  /** @param {string} name  Credential identifier (e.g. `GITHUB_TOKEN`). */
  constructor(name) {
    super(`Credential required: ${name}`);
    this.name = 'CredentialRequiredError';
    this.credential = name;
  }
}

/** Stable, key-sorted JSON for deterministic id derivation (no timestamps). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Public, serialisable snapshot of a job (never leaks internal handles). */
function snapshot(job) {
  return {
    id: job.id,
    operation: job.operation,
    status: job.status,
    progress: job.progress,
    changeCount: Array.isArray(job.changes) ? job.changes.length : 0,
    applied: job.applied,
    needs: job.needs ?? null,
    partial: job.partial ?? null,
    error: job.error ?? null,
  };
}

/**
 * An in-process registry of long-running jobs. One store instance is shared
 * process-wide by default ({@link defaultJobStore}) so a job started in one
 * stateless affordance call is observable from the next; tests inject their own
 * fresh store through `context.seams.jobStore` for isolation.
 */
export class JobStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._jobs = new Map();
    this._seq = 0;
  }

  /** Deterministic id: hash of operation + canonical input + creation index. */
  _nextId(operation, request) {
    const seq = this._seq++;
    const digest = createHash('sha256')
      .update(`${operation}\u0000${canonicalJson(request)}\u0000${seq}`)
      .digest('hex')
      .slice(0, 12);
    return `job_${digest}`;
  }

  /** Public snapshot for a job id, or `undefined` when unknown. */
  get(id) {
    const job = this._jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  /** Internal record for a job id (used by operation handlers). */
  _raw(id) {
    return this._jobs.get(id);
  }

  /** All job snapshots in creation order. */
  list() {
    return [...this._jobs.values()].map(snapshot);
  }

  /** Whether a job has reached a terminal state. */
  isSettled(id) {
    const job = this._jobs.get(id);
    return Boolean(job && SETTLED.has(job.status));
  }

  /**
   * Resolve once the job leaves {@link JOB_STATUS.RUNNING}. Adapters poll
   * `get_job_status` instead; tests await this to drive the lifecycle
   * deterministically.
   *
   * @param {string} id
   * @returns {Promise<object|undefined>} The settled snapshot (or current one).
   */
  async settle(id) {
    const job = this._jobs.get(id);
    if (!job) return undefined;
    if (job._running) await job._running.catch(() => {});
    return this.get(id);
  }

  /**
   * Start a job: create its record and launch the injected runtime without
   * awaiting it (long-running ⇒ `start_generate` returns immediately). Progress,
   * cancellation, credential pauses and partial failures are all funnelled into
   * the job record by the runner below.
   *
   * @param {object} spec
   * @param {string} spec.operation                 Logical op name (e.g. `generate`).
   * @param {object} spec.request                   Opaque, serialisable job request.
   * @param {object} [spec.credentials]             Name→value credential bag.
   * @param {(args: {request: object, signal: AbortSignal, onProgress: Function, getCredential: Function}) => Promise<{changes?: object[], partial?: object[]}>} spec.run
   *        The injected runtime (e.g. `context.seams.runGenerate`).
   * @returns {object} The created job snapshot (`status: running`).
   */
  start({ operation, request, credentials = {}, run }) {
    const id = this._nextId(operation, request);
    const controller = new AbortController();
    const job = {
      id,
      operation,
      status: JOB_STATUS.RUNNING,
      progress: { phase: 'starting', completed: 0, total: 0, message: '' },
      request,
      credentials: { ...credentials },
      changes: null,
      partial: null,
      applied: false,
      needs: null,
      error: null,
      _controller: controller,
      _running: null,
    };
    this._jobs.set(id, job);
    this._launch(job, run);
    return snapshot(job);
  }

  /**
   * Resume a job parked in {@link JOB_STATUS.AWAITING_CREDENTIAL} (or re-run a
   * `failed` one) under its **original id**, merging freshly supplied
   * credentials. This is the late-credential-prompt recovery path.
   *
   * @param {string} id
   * @param {object} credentials
   * @param {Function} run
   * @returns {object|undefined} The job snapshot now back in `running`.
   */
  resume(id, credentials, run) {
    const job = this._jobs.get(id);
    if (!job) return undefined;
    job.credentials = { ...job.credentials, ...credentials };
    job.needs = null;
    job.error = null;
    job.status = JOB_STATUS.RUNNING;
    job._controller = new AbortController();
    this._launch(job, run);
    return snapshot(job);
  }

  /** Wire the runtime promise into the job record, translating its outcome. */
  _launch(job, run) {
    const onProgress = (progress) => {
      if (job.status !== JOB_STATUS.RUNNING) return;
      job.progress = { ...job.progress, ...progress };
    };
    const getCredential = (name) => {
      const v = job.credentials?.[name];
      if (v === undefined || v === null || v === '') throw new CredentialRequiredError(name);
      return v;
    };

    job._running = Promise.resolve()
      .then(() =>
        run({ request: job.request, signal: job._controller.signal, onProgress, getCredential })
      )
      .then((result) => {
        if (job.status !== JOB_STATUS.RUNNING) return; // already cancelled
        job.changes = Array.isArray(result?.changes) ? result.changes : [];
        job.partial = Array.isArray(result?.partial) ? result.partial : null;
        job.progress = { ...job.progress, phase: 'done', message: 'completed' };
        job.status = JOB_STATUS.SUCCEEDED;
      })
      .catch((err) => {
        if (job.status === JOB_STATUS.CANCELLED) return;
        if (err instanceof CredentialRequiredError) {
          job.needs = { credential: err.credential };
          job.status = JOB_STATUS.AWAITING_CREDENTIAL;
          return;
        }
        if (job._controller.signal.aborted) {
          job.status = JOB_STATUS.CANCELLED;
          return;
        }
        job.error = { code: err?.code ?? 'EXECUTION_FAILED', message: String(err?.message ?? err) };
        job.status = JOB_STATUS.FAILED;
      });
  }

  /**
   * Request cancellation of a running job. Aborts its signal and marks it
   * cancelled immediately (idempotent for already-settled jobs).
   *
   * @param {string} id
   * @returns {object|undefined} The job snapshot, or `undefined` when unknown.
   */
  cancel(id) {
    const job = this._jobs.get(id);
    if (!job) return undefined;
    if (job.status === JOB_STATUS.RUNNING || job.status === JOB_STATUS.AWAITING_CREDENTIAL) {
      job._controller.abort();
      job.status = JOB_STATUS.CANCELLED;
      job.progress = { ...job.progress, phase: 'cancelled', message: 'cancelled' };
    }
    return snapshot(job);
  }
}

/**
 * The process-wide default store. Shared so that a job created in one stateless
 * affordance call is visible to the next call through whichever adapter is in
 * use. Tests pass their own store via `context.seams.jobStore`.
 */
export const defaultJobStore = new JobStore();

/** Resolve the store an affordance should use: injected seam or the singleton. */
export function resolveJobStore(context) {
  return context?.seams?.jobStore ?? defaultJobStore;
}

export { snapshot as jobSnapshot, canonicalJson };
