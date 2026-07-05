/**
 * Affordance: `get_job_status` — observe a job's lifecycle (PE3-F2).
 *
 * Read-class. Returns the serialisable snapshot of a job started by
 * `start_generate`: its status, progress, change count, any late-credential the
 * runtime is `needs`-ing, partial-failure detail, and a terminal error. This is
 * the polling surface a client uses to follow long-running work without the
 * contract holding the connection open.
 *
 * @module src/affordances/jobs/get-job-status
 */

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore } from './store.ts';
import type { AffordanceContext } from '../context.ts';

interface GetJobStatusInput extends Record<string, unknown> {
  id: string;
}

export default defineAffordance({
  name: 'get_job_status',
  title: 'Get job status',
  summary: 'Return the current status, progress and pending-change count of a job.',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id returned by start_generate.' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    status: { type: 'string' },
    progress: { type: 'object' },
    changeCount: { type: 'number' },
    needs: { type: 'object' },
    error: { type: 'object' },
  }),
  execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as GetJobStatusInput;
    const store = resolveJobStore(context);
    const snapshot = store.get(args.id);
    if (!snapshot) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${args.id}"`, {
        id: args.id,
      });
    }
    return snapshot;
  },
});
