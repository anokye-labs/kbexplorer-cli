/**
 * Affordance: `apply_changes` — write a job's pending change set back (PE3-F2).
 *
 * Write-class. This is the write-back step: it materialises the `{ path, contents }`
 * entries a succeeded job produced onto disk, relative to `context.cwd`. Two
 * properties matter for the "git-as-store / deterministic" rule in #154:
 *
 *   1. **No clock.** Contents are written **verbatim** — the job layer injects no
 *      timestamps or other nondeterministic bytes. Re-applying an unchanged change
 *      set is a no-op, so the committed artifact is reproducible.
 *   2. **Partial-failure recovery.** Each file is attempted independently; a
 *      failure on one does not abort the rest. The result reports per-file
 *      `applied` / `failed` lists, and the job is marked `applied` only when every
 *      requested write succeeded, so a client can retry just the failures.
 *
 * Writes are confined to `context.cwd` (a path escaping the root is rejected as a
 * failed entry, never followed).
 *
 * @module src/affordances/jobs/apply-changes
 */

import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore, JOB_STATUS, type JobChange } from './store.ts';
import type { AffordanceContext } from '../context.ts';

interface ApplyChangesInput extends Record<string, unknown> {
  id: string;
  only?: string[];
}

interface FailedChange {
  path: string;
  reason: string;
}

/** True when `abs` is inside (or equal to) `root`. */
function within(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export default defineAffordance({
  name: 'apply_changes',
  title: 'Apply changes',
  summary:
    'Write a succeeded job\'s pending changes to disk verbatim (deterministic, no timestamps) with per-file partial-failure recovery.',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // Write-class: discloses the exact paths that will be written, resolved from
    // the target job's pending change set (restricted by `only` when given).
    disclose: (input: Record<string, unknown>, context) => {
      const args = input as ApplyChangesInput;
      try {
        const store = resolveJobStore(context);
        const job = store?._raw?.(args.id);
        const changes = Array.isArray(job?.changes) ? job.changes : [];
        const onlySet = Array.isArray(args.only) && args.only.length ? new Set(args.only) : null;
        return {
          writes: changes
            .map((change) => change.path)
            .filter((path) => typeof path === 'string' && path && (!onlySet || onlySet.has(path))),
        };
      } catch {
        return { writes: [] };
      }
    },
  },
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id whose changes to apply.' },
    only: {
      type: 'array',
      item: { type: 'string' },
      description: 'Restrict the write-back to this subset of change paths (e.g. retry failures).',
    },
  }),
  output: defineSchema({
    id: { type: 'string' },
    applied: { type: 'array' },
    failed: { type: 'array' },
  }),
  execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as ApplyChangesInput;
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
        `Job "${args.id}" is "${job.status}"; only a succeeded job can be applied`,
        { id: args.id, status: job.status }
      );
    }

    const onlySet = Array.isArray(args.only) && args.only.length ? new Set(args.only) : null;
    const pending = (job.changes ?? []).filter((change: JobChange) => !onlySet || onlySet.has(change.path));

    const applied: Array<{ path: string; status: 'unchanged' | 'written' }> = [];
    const failed: FailedChange[] = [];
    for (const change of pending) {
      const text = typeof change.contents === 'string' ? change.contents : '';
      const abs = resolve(context.cwd, change.path);
      if (!within(context.cwd, abs)) {
        failed.push({ path: change.path, reason: 'path escapes the working root' });
        continue;
      }
      try {
        // Idempotent: skip identical existing files so re-apply is a clean no-op.
        const unchanged = existsSync(abs) && readFileSync(abs, 'utf-8') === text;
        if (!unchanged) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text, 'utf-8');
        }
        applied.push({ path: change.path, status: unchanged ? 'unchanged' : 'written' });
      } catch (err: unknown) {
        failed.push({ path: change.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Marked fully applied only when nothing failed and every change was covered.
    job.applied = failed.length === 0 && !onlySet;
    job.partial = failed.length
      ? failed.map((failure) => ({ unit: failure.path, ok: false, error: failure.reason }))
      : job.partial;

    return { id: job.id, applied, failed };
  },
});
