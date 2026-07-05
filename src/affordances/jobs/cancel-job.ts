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
import type { AffordanceContext } from '../context.ts';

interface CancelJobInput extends Record<string, unknown> {
  id: string;
}

export default defineAffordance({
  name: 'cancel_job',
  title: 'Cancel job',
  summary: 'Abort a running (or credential-paused) job and mark it cancelled.',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // Write-class but low-impact: it touches no disk paths, only runtime state.
    // Discloses the job it will stop so a host can auto-approve trivial control.
    disclose: (input: Record<string, unknown>) => {
      const args = input as CancelJobInput;
      return { writes: args.id ? [`cancel-job:${args.id}`] : [] };
    },
  },
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id to cancel.' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    status: { type: 'string' },
  }),
  execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as CancelJobInput;
    const store = resolveJobStore(context);
    const snapshot = store.cancel(args.id);
    if (!snapshot) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${args.id}"`, {
        id: args.id,
      });
    }
    return snapshot;
  },
});
