/**
 * Affordance: `audit` — schema/structural integrity check over content.
 *
 * Read-only, deterministic, protocol-neutral. Wraps the existing
 * `src/lib/audit.js` logic (duplicate ids, broken parents, parent cycles, dead
 * connections, missing required frontmatter, undeclared clusters) as a typed
 * action contract.
 *
 * @module src/affordances/operations/audit
 */

import {
  defineAffordance,
  defineSchema,
  AffordanceError,
  ERROR_CODES,
  ACTION_CLASSES,
} from '../contract.js';
import { audit } from '../../lib/audit.js';

export default defineAffordance({
  name: 'audit',
  title: 'Audit content',
  summary:
    'Structural integrity audit of content/: duplicate ids, broken parents, cycles, dead connections.',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({
    content: { type: 'string', description: 'Override content directory (relative to cwd).' },
  }),
  output: defineSchema({
    findings: { type: 'array' },
    summary: { type: 'object' },
  }),
  execute(context, input) {
    const { contentDir, contentPath } = context.resolveContent({ content: input.content });
    try {
      return audit({ contentDir, cwd: context.cwd, contentPath });
    } catch (err) {
      throw new AffordanceError(ERROR_CODES.EXECUTION_FAILED, `audit failed: ${err.message}`);
    }
  },
});
