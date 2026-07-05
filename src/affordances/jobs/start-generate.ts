/**
 * Affordance: `start_generate` — kick off a long-running generation job (PE3-F2).
 *
 * Sample-class. This is the entry point of the job layer: it does **not** run a
 * model itself (the contract never does) — it registers a job in the
 * {@link module:src/affordances/jobs/store JobStore} and hands the actual
 * long-running work to an injected runtime seam, `context.seams.runGenerate`,
 * exactly the way `derive` delegates fuzzy extraction to `runExtraction`. The
 * call returns **immediately** with a job handle (`status: running`); progress,
 * cancellation, late-credential prompts and partial failures are then observed
 * through `get_job_status` and acted on through the sibling job affordances.
 *
 * Two modes:
 *   - default — start a brand-new job from `input` (+ optional `credentials`).
 *   - `resume` — re-drive an existing job parked in `awaiting_credential` (or a
 *     `failed` one) under its original id, merging freshly supplied credentials.
 *     This is the late-credential recovery path.
 *
 * @module src/affordances/jobs/start-generate
 */

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore, JOB_STATUS, type JobStatus } from './store.ts';
import { buildDerivation, sampledSourceRef, SAMPLE_GENERATOR } from '../provenance.ts';
import type { AffordanceContext } from '../context.ts';
import type { SourceRef } from '../provenance.ts';

const RESUMABLE = new Set<JobStatus>([JOB_STATUS.AWAITING_CREDENTIAL, JOB_STATUS.FAILED]);

interface StartGenerateInput extends Record<string, unknown> {
  resume?: string;
  refresh?: boolean;
  request?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

/** Collect declared provenance inputs from a generation request (SourceRef-ish). */
function requestInputs(request: Record<string, unknown>): SourceRef[] {
  const raw: unknown[] = [];
  if (Array.isArray(request?.inputs)) raw.push(...request.inputs);
  if (Array.isArray(request?.sources)) raw.push(...request.sources);
  return raw
    .map((input) => sampledSourceRef(input as string | Record<string, unknown> | null | undefined))
    .filter((ref): ref is SourceRef => ref !== null);
}

export default defineAffordance({
  name: 'start_generate',
  title: 'Start generate job',
  summary:
    'Begin a long-running generation job and return a job handle; the model runtime is injected, never owned by the contract.',
  actionClass: ACTION_CLASSES.SAMPLE,
  consent: {
    // Sample-class: discloses that a model runtime is invoked, plus any
    // credential names the caller is handing in (names only — never values).
    cost: { kind: 'sample', runtime: 'context.seams.runGenerate', generator: SAMPLE_GENERATOR },
    disclose: (input: Record<string, unknown>) => ({
      credentials: Object.keys(((input as StartGenerateInput).credentials ?? {}) as Record<string, string>),
    }),
  },
  input: defineSchema({
    resume: {
      type: 'string',
      description: 'Resume an existing job by id (for awaiting_credential / failed recovery).',
    },
    refresh: {
      type: 'boolean',
      default: false,
      description: 'Force a full re-generation rather than an incremental refresh.',
    },
    request: {
      type: 'object',
      description: 'Opaque, serialisable generation request passed through to the runtime.',
    },
    credentials: {
      type: 'object',
      description: 'Name→value credential bag the runtime may consume (e.g. GITHUB_TOKEN).',
    },
  }),
  output: defineSchema({
    id: { type: 'string' },
    status: { type: 'string' },
  }),
  execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as StartGenerateInput;
    const run = context.seams?.runGenerate;
    if (typeof run !== 'function') {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        'start_generate requires a generation runtime (context.seams.runGenerate). ' +
          'The contract does not own the model runtime.'
      );
    }

    const store = resolveJobStore(context);
    const credentials = args.credentials ?? {};

    if (args.resume) {
      const existing = store.get(args.resume);
      if (!existing) {
        throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${args.resume}"`, {
          id: args.resume,
        });
      }
      if (!RESUMABLE.has(existing.status)) {
        throw new AffordanceError(
          ERROR_CODES.INVALID_INPUT,
          `Job "${args.resume}" is "${existing.status}" and cannot be resumed`,
          { id: args.resume, status: existing.status }
        );
      }
      return store.resume(args.resume, credentials, run);
    }

    const request = { refresh: args.refresh ?? false, ...(args.request ?? {}) };
    // Deterministic sampled-content provenance for the changes this job produces:
    // the generator + declared inputs + a digest of the request (no timestamps).
    const derivation = buildDerivation({
      generator: SAMPLE_GENERATOR,
      inputs: requestInputs(request),
      request,
    });
    return store.start({ operation: 'generate', request, credentials, derivation, run });
  },
});
