/**
 * Affordance: `preview_changes` — inspect a job's pending write-back (PE3-F2).
 *
 * Read-class: it observes the change set a succeeded job produced **without
 * touching disk**. This is the review gate that precedes `apply_changes` — a
 * client (or the PE4 review loop) shows the proposed files, their byte sizes, and
 * whether each would create or overwrite, then decides whether to apply.
 *
 * The change set is whatever the injected runtime returned: an array of
 * `{ path, contents }` entries. `preview_changes` reports each entry's path,
 * size and create/overwrite disposition; it returns the raw `contents` too so a
 * diff view can render it, but never writes.
 *
 * @module src/affordances/jobs/preview-changes
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore, JOB_STATUS, type JobChange } from './store.ts';
import type { AffordanceContext } from '../context.ts';

interface PreviewChangesInput extends Record<string, unknown> {
  id: string;
  contents?: boolean;
}

export default defineAffordance({
  name: 'preview_changes',
  title: 'Preview changes',
  summary: 'List the files a succeeded job would write, with sizes and create/overwrite disposition (no disk writes).',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id whose pending changes to preview.' },
    contents: {
      type: 'boolean',
      default: false,
      description: 'Include the full proposed file contents (for diff rendering).',
    },
  }),
  output: defineSchema({
    id: { type: 'string' },
    changes: { type: 'array' },
  }),
  execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as PreviewChangesInput;
    const store = resolveJobStore(context);
    const job = store._raw(args.id);
    if (!job) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${args.id}"`, {
        id: args.id,
      });
    }
    if (job.status !== JOB_STATUS.SUCCEEDED) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        `Job "${args.id}" is "${job.status}"; only a succeeded job has previewable changes`,
        { id: args.id, status: job.status }
      );
    }

    const changes = (job.changes ?? []).map((change: JobChange) => {
      const abs = resolve(context.cwd, change.path);
      const text = typeof change.contents === 'string' ? change.contents : '';
      return {
        path: change.path,
        bytes: Buffer.byteLength(text, 'utf-8'),
        disposition: existsSync(abs) ? 'overwrite' : 'create',
        ...(args.contents ? { contents: text } : {}),
      };
    });

    return { id: job.id, changes };
  },
});
