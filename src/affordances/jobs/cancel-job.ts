/**
 * Affordance: `cancel_job` — request cancellation of a running job (PE3-F2).
 *
 * Write-class (it mutates job/runtime state and signals the injected runtime to
 * stop, a consent-relevant side effect). Aborts the job's signal and transitions
 * it to `cancelled`; on an already-settled job it is a harmless no-op that simply
 * returns the current snapshot.
 *
 * @module src/affordances/jobs/cancel-job
 */

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore } from './store.ts';

export default defineAffordance({
  name: 'cancel_job',
  title: 'Cancel job',
  summary: 'Abort a running (or credential-paused) job and mark it cancelled.',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // Write-class but low-impact: it touches no disk paths, only runtime state.
    // Discloses the job it will stop so a host can auto-approve trivial control.
    disclose: (input) => ({ writes: input?.id ? [`cancel-job:${input.id}`] : [] }),
  },
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id to cancel.' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    status: { type: 'string' },
  }),
  execute(context, input) {
    const store = resolveJobStore(context);
    const snapshot = store.cancel(input.id);
    if (!snapshot) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${input.id}"`, {
        id: input.id,
      });
    }
    return snapshot;
  },
});
