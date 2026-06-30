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
import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.js';
import { resolveJobStore, JOB_STATUS } from './store.js';

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
  execute(context, input) {
    const store = resolveJobStore(context);
    const job = store._raw(input.id);
    if (!job) {
      throw new AffordanceError(ERROR_CODES.NOT_FOUND, `No job with id "${input.id}"`, {
        id: input.id,
      });
    }
    if (job.status !== JOB_STATUS.SUCCEEDED) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        `Job "${input.id}" is "${job.status}"; only a succeeded job has previewable changes`,
        { id: input.id, status: job.status }
      );
    }

    const changes = (job.changes ?? []).map((c) => {
      const abs = resolve(context.cwd, c.path);
      const text = typeof c.contents === 'string' ? c.contents : '';
      return {
        path: c.path,
        bytes: Buffer.byteLength(text, 'utf-8'),
        disposition: existsSync(abs) ? 'overwrite' : 'create',
        ...(input.contents ? { contents: text } : {}),
      };
    });

    return { id: job.id, changes };
  },
});
