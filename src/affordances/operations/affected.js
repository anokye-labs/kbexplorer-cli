/**
 * Affordance: `affected` — map a git diff to impacted content nodes.
 *
 * Read-only, deterministic, protocol-neutral. Wraps the existing
 * `src/lib/affected.js` logic. By default it derives the changed file set from a
 * git ref; callers (or tests) may pass an explicit `files` array to bypass git
 * entirely, keeping the affordance hermetic.
 *
 * @module src/affordances/operations/affected
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';
import { affected } from '../../lib/affected.js';

export default defineAffordance({
  name: 'affected',
  title: 'Affected nodes',
  summary:
    'List content nodes whose citations reference files changed in a git ref (or an explicit file list).',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    ref: {
      type: 'string',
      default: 'HEAD',
      description: 'Git ref to diff (e.g. HEAD~1, main, a SHA).',
    },
    content: { type: 'string', description: 'Override content directory (relative to cwd).' },
    files: {
      type: 'array',
      item: { type: 'string' },
      description: 'Explicit changed-file list; bypasses git diff when provided.',
    },
  }),
  output: defineSchema({
    ref: { type: 'string' },
    changedFiles: { type: 'array' },
    nodeCount: { type: 'number' },
    affected: { type: 'array' },
    detail: { type: 'array' },
    uncited: { type: 'array' },
  }),
  execute(context, input) {
    const { contentDir } = context.resolveContent({ content: input.content });
    try {
      return affected({
        ref: input.ref ?? 'HEAD',
        contentDir,
        cwd: context.cwd,
        files: input.files,
      });
    } catch (err) {
      throw new AffordanceError(ERROR_CODES.EXECUTION_FAILED, `affected failed: ${err.message}`, {
        ref: input.ref,
      });
    }
  },
});
