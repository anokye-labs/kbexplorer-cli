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

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.js';
import { resolveJobStore } from './store.js';

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
  execute(context, input) {
    const store = resolveJobStore(context);
    const snapshot = store.get(input.id);
    if (!snapshot) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${input.id}"`, {
        id: input.id,
      });
    }
    return snapshot;
  },
});
