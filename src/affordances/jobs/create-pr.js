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

import { defineAffordance, defineSchema, AffordanceError, ERROR_CODES, ACTION_CLASSES } from '../contract.js';
import { resolveJobStore, JOB_STATUS } from './store.js';

export default defineAffordance({
  name: 'create_pr',
  title: 'Create pull request',
  summary:
    'Open a pull request for a job whose changes have been applied; the git/GitHub runtime is injected, not owned by the contract.',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    // Write-class: opening a PR uses the GitHub credential and pushes a branch.
    credentials: ['GITHUB_TOKEN'],
    disclose: (input) => ({
      writes: [
        ...(input?.branch ? [`branch:${input.branch}`] : []),
        ...(input?.title ? [`pr:${input.title}`] : []),
      ],
    }),
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
  async execute(context, input) {
    const createPullRequest = context.seams?.createPullRequest;
    if (typeof createPullRequest !== 'function') {
      throw new AffordanceError(
        ERROR_CODES.UNSUPPORTED,
        'create_pr requires a git/PR runtime (context.seams.createPullRequest). ' +
          'The contract does not own git or the GitHub API.'
      );
    }

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
        `Job "${input.id}" is "${job.status}"; cannot open a PR for it`,
        { id: input.id, status: job.status }
      );
    }
    if (!job.applied) {
      throw new AffordanceError(
        ERROR_CODES.INVALID_INPUT,
        `Job "${input.id}" has unapplied changes; run apply_changes before create_pr`,
        { id: input.id }
      );
    }

    try {
      const result = await createPullRequest({
        title: input.title,
        body: input.body ?? '',
        branch: input.branch,
        base: input.base,
        changes: job.changes ?? [],
        cwd: context.cwd,
      });
      return {
        id: job.id,
        url: result?.url ?? '',
        branch: result?.branch ?? input.branch ?? '',
      };
    } catch (err) {
      if (err instanceof AffordanceError) throw err;
      throw new AffordanceError(
        ERROR_CODES.EXECUTION_FAILED,
        `create_pr failed for "${input.id}": ${err?.message ?? err}`,
        { id: input.id }
      );
    }
  },
});
