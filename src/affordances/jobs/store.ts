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
 * **verbatim** (the store injects no clock).
 *
 * **Job ids are NOT a pure content hash — read this before relying on them as
 * an idempotency key (#206).** `_nextId()` hashes `operation + canonical
 * input + this._seq` where `_seq` is a process-local counter that increments
 * on every call, so the digest mixes in *creation order*, not content alone:
 * calling `start()` twice with identical `operation`/`request` on the same
 * store yields two *different* ids (the counter advances), while replaying
 * an identical *sequence* of calls against a fresh store reproduces the same
 * ids one-for-one (same counter values in the same order). What the guarantee
 * actually buys you: ids are never time-derived (no clock is read, so replay
 * across processes/days is stable) and never random (so tests can assert on
 * them) — but two calls with the same content are not deduplicated to the
 * same id, and the id alone does not prove "this exact input has been seen
 * before" without also knowing its position in the call sequence.
 *
 * @module src/affordances/jobs/store
 */

import { createHash } from 'node:crypto';
import { stampProvenance, type Derivation } from '../provenance.ts';

export interface JobProgress extends Record<string, unknown> {
  phase: string;
  completed: number;
  total: number;
  message: string;
}

export interface JobChange extends Record<string, unknown> {
  path: string;
  contents?: string;
  derivation?: Derivation;
  provenance?: unknown;
}

export interface JobPartialFailure extends Record<string, unknown> {
  unit?: string;
  ok?: boolean;
  error?: string;
  path?: string;
  reason?: string;
}

export interface JobNeeds {
  credential: string;
}

export interface JobErrorInfo {
  code: string;
  message: string;
}

export type CredentialBag = Record<string, string>;

export interface JobRunnerArgs {
  request: Record<string, unknown>;
  signal: AbortSignal;
  onProgress: (progress: Partial<JobProgress>) => void;
  getCredential: (name: string) => string;
}

export interface JobRunnerResult {
  changes?: JobChange[];
  partial?: JobPartialFailure[];
}

export type JobRun = (args: JobRunnerArgs) => Promise<JobRunnerResult>;

export interface JobSnapshot {
  id: string;
  operation: string;
  status: JobStatus;
  progress: JobProgress;
  changeCount: number;
  applied: boolean;
  needs: JobNeeds | null;
  partial: JobPartialFailure[] | null;
  error: JobErrorInfo | null;
  derivation: Derivation | null;
}

export interface JobRecord {
  id: string;
  operation: string;
  status: JobStatus;
  progress: JobProgress;
  request: Record<string, unknown>;
  credentialNames: string[];
  derivation: Derivation | null;
  changes: JobChange[] | null;
  partial: JobPartialFailure[] | null;
  applied: boolean;
  needs: JobNeeds | null;
  error: JobErrorInfo | null;
  _controller: AbortController;
  _running: Promise<void> | null;
}

export interface StartJobSpec {
  operation: string;
  request: Record<string, unknown>;
  credentials?: CredentialBag;
  derivation?: Derivation | null;
  run: JobRun;
}

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

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

const SETTLED = new Set<JobStatus>([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);

/**
 * Raised by a runtime seam (via `getCredential`) when it needs a credential the
 * job was not started with. The job runner catches it and parks the job in
 * {@link JOB_STATUS.AWAITING_CREDENTIAL} rather than failing it, so a client can
 * prompt for the value and resume the *same* job.
 */
export class CredentialRequiredError extends Error {
  credential: string;

  /** @param {string} name  Credential identifier (e.g. `GITHUB_TOKEN`). */
  constructor(name: string) {
    super(`Credential required: ${name}`);
    this.name = 'CredentialRequiredError';
    this.credential = name;
  }
}

/** Redact a credential bag down to its (sorted) key names — never the values. */
function redactCredentialNames(credentials: Record<string, unknown>): string[] {
  return Object.keys(credentials).sort();
}

/** Stable, key-sorted JSON for deterministic id derivation (no timestamps). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Public, serialisable snapshot of a job (never leaks internal handles). */
function snapshot(job: JobRecord): JobSnapshot {
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
    // Sampled-content provenance (PE3-F3): the deterministic Derivation a
    // sample-class job was started with, so previews/clients can disclose what
    // model + inputs produced the pending changes. Null for non-sampled jobs.
    derivation: job.derivation ?? null,
  };
}

function errorInfo(err: unknown): JobErrorInfo {
  if (typeof err === 'object' && err !== null) {
    const record = err as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : 'EXECUTION_FAILED',
      message: typeof record.message === 'string' ? record.message : String(err),
    };
  }
  return { code: 'EXECUTION_FAILED', message: String(err) };
}

/**
 * An in-process registry of long-running jobs. One store instance is shared
 * process-wide by default ({@link defaultJobStore}) so a job started in one
 * stateless affordance call is observable from the next; tests inject their own
 * fresh store through `context.seams.jobStore` for isolation.
 *
 * Credential handling: real credential *values* are never attached to a job
 * record. They live only in `this._credentialVault` (id → name→value bag),
 * read solely by `getCredential()` inside `_launch()` at actual exec time. The
 * job record itself carries `credentialNames` — the (sorted) key names a
 * caller supplied, never the values — so anything that logs, serializes, or
 * otherwise dumps a raw job object (e.g. `_raw()`, a future debug endpoint, an
 * error report) cannot leak a secret just by touching the job.
 */
export class JobStore {
  _jobs: Map<string, JobRecord>;
  _seq: number;
  _credentialVault: Map<string, CredentialBag>;

  constructor() {
    this._jobs = new Map<string, JobRecord>();
    this._seq = 0;
    /** Real credential values, isolated from job records. */
    this._credentialVault = new Map<string, CredentialBag>();
  }

  /**
   * Id: a digest of operation + canonical input + this store's creation-order
   * counter. Not a pure content hash (see the class docstring, #206) — the
   * counter means id equality tracks "same content at the same position in
   * the call sequence", not "same content ever submitted".
   */
  _nextId(operation: string, request: unknown): string {
    const seq = this._seq++;
    const digest = createHash('sha256')
      .update(`${operation}\u0000${canonicalJson(request)}\u0000${seq}`)
      .digest('hex')
      .slice(0, 12);
    return `job_${digest}`;
  }

  /** Public snapshot for a job id, or `undefined` when unknown. */
  get(id: string): JobSnapshot | undefined {
    const job = this._jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  /** Internal record for a job id (used by operation handlers). */
  _raw(id: string): JobRecord | undefined {
    return this._jobs.get(id);
  }

  /** All job snapshots in creation order. */
  list(): JobSnapshot[] {
    return [...this._jobs.values()].map(snapshot);
  }

  /** Whether a job has reached a terminal state. */
  isSettled(id: string): boolean {
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
  async settle(id: string): Promise<JobSnapshot | undefined> {
    const job = this._jobs.get(id);
    if (!job) return undefined;
    if (job._running) await job._running.catch(() => undefined);
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
   * @param {object} [spec.credentials]             Name→value credential bag. Real values are
   *        isolated into `this._credentialVault`, never attached to the job record itself
   *        (only the redacted key names are — see the class docstring).
   * @param {object} [spec.derivation]              Deterministic sampled-content
   *        provenance ({@link module:src/affordances/provenance}); recorded on the
   *        job and stamped onto its generated changes. Omitted for non-sampled work.
   * @param {(args: {request: object, signal: AbortSignal, onProgress: Function, getCredential: Function}) => Promise<{changes?: object[], partial?: object[]}>} spec.run
   *        The injected runtime (e.g. `context.seams.runGenerate`).
   * @returns {object} The created job snapshot (`status: running`).
   */
  start({ operation, request, credentials = {}, derivation = null, run }: StartJobSpec): JobSnapshot {
    const id = this._nextId(operation, request);
    const controller = new AbortController();
    this._credentialVault.set(id, { ...credentials });
    const job: JobRecord = {
      id,
      operation,
      status: JOB_STATUS.RUNNING,
      progress: { phase: 'starting', completed: 0, total: 0, message: '' },
      request,
      // Redacted: names only, never values (see class docstring + getCredential).
      credentialNames: redactCredentialNames(credentials),
      derivation: derivation ?? null,
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
  resume(id: string, credentials: CredentialBag, run: JobRun): JobSnapshot | undefined {
    const job = this._jobs.get(id);
    if (!job) return undefined;
    const merged = { ...(this._credentialVault.get(id) ?? {}), ...credentials };
    this._credentialVault.set(id, merged);
    job.credentialNames = redactCredentialNames(merged);
    job.needs = null;
    job.error = null;
    job.status = JOB_STATUS.RUNNING;
    job._controller = new AbortController();
    this._launch(job, run);
    return snapshot(job);
  }

  /** Wire the runtime promise into the job record, translating its outcome. */
  _launch(job: JobRecord, run: JobRun): void {
    const onProgress = (progress: Partial<JobProgress>): void => {
      if (job.status !== JOB_STATUS.RUNNING) return;
      job.progress = { ...job.progress, ...progress };
    };
    const getCredential = (name: string): string => {
      // Real values live only in the vault, never on `job` — see class docstring.
      const value = this._credentialVault.get(job.id)?.[name];
      if (value === undefined || value === null || value === '') throw new CredentialRequiredError(name);
      return value;
    };

    job._running = Promise.resolve()
      .then(() =>
        run({ request: job.request, signal: job._controller.signal, onProgress, getCredential }),
      )
      .then((result) => {
        if (job.status !== JOB_STATUS.RUNNING) return; // already cancelled
        const rawChanges = Array.isArray(result?.changes) ? result.changes : [];
        // Stamp sampled-content provenance (PE3-F3) onto every generated change
        // so the model + inputs that produced it travel with the bytes through
        // preview_changes / apply_changes. Non-mutating, deterministic, no clock.
        job.changes = job.derivation
          ? rawChanges.map((change) => stampProvenance(change, job.derivation))
          : rawChanges;
        job.partial = Array.isArray(result?.partial) ? result.partial : null;
        job.progress = { ...job.progress, phase: 'done', message: 'completed' };
        job.status = JOB_STATUS.SUCCEEDED;
      })
      .catch((err: unknown) => {
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
        job.error = errorInfo(err);
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
  cancel(id: string): JobSnapshot | undefined {
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

export interface JobStoreCarrier {
  seams?: {
    jobStore?: JobStore;
  };
}

/** Resolve the store an affordance should use: injected seam or the singleton. */
export function resolveJobStore(context: JobStoreCarrier | null | undefined): JobStore {
  return context?.seams?.jobStore ?? defaultJobStore;
}

export { snapshot as jobSnapshot, canonicalJson };
