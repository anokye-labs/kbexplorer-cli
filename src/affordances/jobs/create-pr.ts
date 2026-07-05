/**
 * Affordance: `create_pr` — open a pull request for an applied job (PE3-F2).
 *
 * Write-class. The final step of the workflow: turn an applied change set into a
 * pull request. Like every other side-effecting runtime concern in this layer,
 * the contract does **not** own git or the GitHub API — the actual PR creation is
 * supplied by the caller through `context.seams.createPullRequest` (which the
 * adapter/host wires to `gh` or an API client). When that seam is absent the
 * action reports a typed `UNSUPPORTED` rather than shelling out itself.
 *
 * A PR is only meaningful once the job's changes have been written back, so the
 * action requires the job to be `applied` first.
 *
 * @module src/affordances/jobs/create-pr
 */

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.ts';
import { resolveJobStore, JOB_STATUS } from './store.ts';
import type { AffordanceContext } from '../context.ts';

interface CreatePrInput extends Record<string, unknown> {
  id: string;
  title: string;
  body?: string;
  branch?: string;
  base?: string;
}

export default defineAffordance({
  name: 'create_pr',
  title: 'Create pull request',
  summary:
    'Open a pull request for a job whose changes have been applied; the git/GitHub runtime is injected, not owned by the contract.',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // Write-class: opening a PR uses the GitHub credential and pushes a branch.
    credentials: ['GITHUB_TOKEN'],
    disclose: (input: Record<string, unknown>) => {
      const args = input as CreatePrInput;
      return {
      writes: [
        ...(args.branch ? [`branch:${args.branch}`] : []),
        ...(args.title ? [`pr:${args.title}`] : []),
      ],
      };
    },
  },
  input: defineSchema({
    id: { type: 'string', required: true, description: 'Job id whose applied changes to publish.' },
    title: { type: 'string', required: true, description: 'Pull request title.' },
    body: { type: 'string', description: 'Pull request body.' },
    branch: { type: 'string', description: 'Head branch to push the changes to.' },
    base: { type: 'string', description: 'Base branch to target (defaults to the repo default).' },
  }),
  output: defineSchema({
    id: { type: 'string' },
    url: { type: 'string' },
    branch: { type: 'string' },
  }),
  async execute(context: AffordanceContext, input: Record<string, unknown>) {
    const args = input as CreatePrInput;
    const createPullRequest = context.seams?.createPullRequest;
    if (typeof createPullRequest !== 'function') {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        'create_pr requires a git/PR runtime (context.seams.createPullRequest). ' +
          'The contract does not own git or the GitHub API.'
      );
    }

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
        `Job "${args.id}" is "${job.status}"; cannot open a PR for it`,
        { id: args.id, status: job.status }
      );
    }
    if (!job.applied) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        `Job "${args.id}" has unapplied changes; run apply_changes before create_pr`,
        { id: args.id }
      );
    }

    try {
      const result = await createPullRequest({
        title: args.title,
        body: args.body ?? '',
        branch: args.branch,
        base: args.base,
        changes: job.changes ?? [],
        cwd: context.cwd,
      });
      return {
        id: job.id,
        url: result?.url ?? '',
        branch: result?.branch ?? args.branch ?? '',
      };
    } catch (err: unknown) {
      if (err instanceof AffordanceError) throw err;
      throw new AffordanceError(
        ERROR_CODES.EXECUTION_FAILED,
        `create_pr failed for "${args.id}": ${err instanceof Error ? err.message : String(err)}`,
        { id: args.id }
      );
    }
  },
});
