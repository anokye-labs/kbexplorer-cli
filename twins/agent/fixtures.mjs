/**
 * Canned response fixtures for the deterministic agent-runtime twin.
 *
 * Each fixture maps a *prompt match* to a canned extraction object. The twin
 * (./fake-agent.mjs) finds the first fixture whose `match` substring appears in
 * the incoming `-p <prompt>` text and emits its `extraction` as the agent's
 * structured output. Matching on the source-document body keeps fixtures keyed
 * to content, so the same source always yields the same graph — hermetically,
 * with no live LLM.
 *
 * HOLDOUT RULE: these are *fixtures only*. They encode what the twin returns;
 * they do NOT encode test expectations. Assertions about derive/extract output
 * live in the tests (tests/twins/agent.test.js), never here.
 *
 * Adding a fixture: append `{ key, match, extraction }`. `match` is matched
 * case-sensitively as a substring against the full prompt; order matters — the
 * first match wins, so put more-specific `match` strings earlier.
 */

/**
 * @typedef {object} AgentFixture
 * @property {string} key         Stable identifier (for diagnostics / selection).
 * @property {string} match       Substring that, when present in the prompt, selects this fixture.
 * @property {{ entities: object[], relationships: object[] }} extraction
 *           The canned extraction intermediate the twin emits as its response.
 */

/** @type {AgentFixture[]} */
export const FIXTURES = [
  {
    key: 'jane-platform',
    match: 'Jane Doe leads Platform Team',
    extraction: {
      entities: [
        { id: 'jane', type: 'person', name: 'Jane Doe', properties: { jobTitle: 'VP' } },
        { id: 'platform-team', type: 'team', name: 'Platform Team' },
      ],
      relationships: [{ from: 'jane', to: 'platform-team', type: 'leads' }],
    },
  },
  {
    key: 'acme-strategy',
    match: 'Acme Corp strategy',
    extraction: {
      entities: [
        { id: 'acme-corp', type: 'organization', name: 'Acme Corp' },
        { id: 'strategy', type: 'document', name: 'Strategy' },
      ],
      relationships: [{ from: 'strategy', to: 'acme-corp', type: 'structural' }],
    },
  },
  {
    key: 'payments-org',
    match: 'Payments',
    extraction: {
      entities: [
        { id: 'ada', type: 'person', name: 'Ada Lovelace', properties: { jobTitle: 'Director' } },
        { id: 'payments', type: 'team', name: 'Payments' },
        { id: 'ledger', type: 'system', name: 'Ledger Service' },
      ],
      relationships: [
        { from: 'ada', to: 'payments', type: 'leads' },
        { from: 'payments', to: 'ledger', type: 'staffs', label: 'owns' },
      ],
    },
  },
];

/** The response the twin emits when no fixture matches a prompt. */
export const DEFAULT_EXTRACTION = {
  entities: [{ id: 'twin-default', type: 'concept', name: 'Twin Default Entity' }],
  relationships: [],
};

/**
 * Select the canned extraction for a given prompt.
 *
 * @param {string} prompt  The full prompt text the agent was invoked with.
 * @returns {{ key: string, extraction: { entities: object[], relationships: object[] } }}
 */
export function selectFixture(prompt) {
  const text = String(prompt ?? '');
  for (const fixture of FIXTURES) {
    if (text.includes(fixture.match)) {
      return { key: fixture.key, extraction: fixture.extraction };
    }
  }
  return { key: 'default', extraction: DEFAULT_EXTRACTION };
}
