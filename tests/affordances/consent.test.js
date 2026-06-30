/**
 * Consent gate (PE3-F3) — enforcement, disclosure, and protocol-neutrality.
 *
 * Verifies that the consent rules are enforced at the action core
 * (`executeAffordance`), so both delivery adapters inherit identical behaviour:
 *
 *   - read actions never prompt;
 *   - write/sample actions fail-closed without an approval seam;
 *   - the injected approval callback decides yes/no and is handed a deterministic
 *     disclosure (model cost, credential NAMES, written paths);
 *   - an explicit non-interactive policy or a declared side-effect-free
 *     invocation (derive --check) bypasses the prompt.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createAffordanceContext } = await import('../../src/affordances/context.js');
const { executeAffordance, ERROR_CODES, ACTION_CLASSES } = await import(
  '../../src/affordances/index.js'
);
const {
  enforceConsent,
  requiresConsent,
  isReadOnlyInvocation,
  buildConsentRequest,
  buildDisclosure,
  CONSENT_REQUIRED_CLASSES,
} = await import('../../src/affordances/consent.js');
const { defineAffordance, defineSchema } = await import('../../src/affordances/contract.js');
const { getAffordance } = await import('../../src/affordances/index.js');
const { JobStore } = await import('../../src/affordances/jobs/store.js');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-consent-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A minimal throwaway write affordance for unit-testing the gate directly.
const writeAff = defineAffordance({
  name: 'demo_write',
  summary: 'demo',
  actionClass: ACTION_CLASSES.WRITE,
  consent: {
    credentials: ['GITHUB_TOKEN'],
    disclose: (input) => ({ writes: input.paths ?? [] }),
  },
  input: defineSchema({ paths: { type: 'array', item: { type: 'string' } } }),
  execute: () => ({ ok: true }),
});

const sampleAff = defineAffordance({
  name: 'demo_sample',
  summary: 'demo',
  actionClass: ACTION_CLASSES.SAMPLE,
  input: defineSchema({}),
  execute: () => ({ ok: true }),
});

const readAff = defineAffordance({
  name: 'demo_read',
  summary: 'demo',
  actionClass: ACTION_CLASSES.READ,
  input: defineSchema({}),
  execute: () => ({ ok: true }),
});

describe('consent — classification', () => {
  it('only write/sample classes require consent; read does not', () => {
    assert.equal(requiresConsent(readAff), false);
    assert.equal(requiresConsent(writeAff), true);
    assert.equal(requiresConsent(sampleAff), true);
    assert.deepEqual([...CONSENT_REQUIRED_CLASSES].sort(), ['sample', 'write']);
  });
});

describe('consent — disclosure shape', () => {
  it('discloses credential names (never values), writes, and model cost', () => {
    const d = buildDisclosure(writeAff, { paths: ['a.md', 'b.md'] });
    assert.deepEqual(d.credentials, ['GITHUB_TOKEN']);
    assert.deepEqual(d.writes, ['a.md', 'b.md']);
    assert.equal(d.cost.kind, 'none');
  });

  it('sample actions disclose a sample cost kind even without a static block', () => {
    const d = buildDisclosure(sampleAff, {});
    assert.equal(d.cost.kind, 'sample');
  });

  it('buildConsentRequest is deterministic and JSON-serialisable', () => {
    const r1 = buildConsentRequest(writeAff, { paths: ['x'] });
    const r2 = buildConsentRequest(writeAff, { paths: ['x'] });
    assert.deepEqual(r1, r2);
    assert.deepEqual(JSON.parse(JSON.stringify(r1)), r1);
    assert.equal(r1.affordance, 'demo_write');
    assert.equal(r1.actionClass, 'write');
  });

  it('a throwing disclose helper degrades to static disclosure, never breaks the gate', () => {
    const aff = defineAffordance({
      name: 'demo_throw',
      summary: 'demo',
      actionClass: ACTION_CLASSES.WRITE,
      consent: {
        writes: ['static.md'],
        disclose: () => {
          throw new Error('boom');
        },
      },
      input: defineSchema({}),
      execute: () => ({}),
    });
    const d = buildDisclosure(aff, {});
    assert.deepEqual(d.writes, ['static.md']);
  });
});

describe('consent — enforcement (fail-closed)', () => {
  it('refuses a write action with CONSENT_REQUIRED when no approval seam is wired', async () => {
    await assert.rejects(
      () => enforceConsent(writeAff, { paths: [] }, createAffordanceContext({ cwd: dir })),
      (e) => e.code === ERROR_CODES.CONSENT_REQUIRED && e.details.affordance === 'demo_write'
    );
  });

  it('refuses a sample action with CONSENT_REQUIRED when no approval seam is wired', async () => {
    await assert.rejects(
      () => enforceConsent(sampleAff, {}, createAffordanceContext({ cwd: dir })),
      (e) => e.code === ERROR_CODES.CONSENT_REQUIRED
    );
  });

  it('lets read actions through untouched (no prompt, no seam needed)', async () => {
    const res = await enforceConsent(readAff, {}, createAffordanceContext({ cwd: dir }));
    assert.equal(res.approved, true);
    assert.equal(res.request, null);
    assert.equal(res.decision.bypassed, 'read');
  });
});

describe('consent — approval callback injection (transport-neutral)', () => {
  it('consults requestConsent and passes a disclosure; approval proceeds', async () => {
    const seen = [];
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: {
        requestConsent: (req) => {
          seen.push(req);
          return true;
        },
      },
    });
    const res = await enforceConsent(writeAff, { paths: ['p.md'] }, ctx);
    assert.equal(res.approved, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].affordance, 'demo_write');
    assert.deepEqual(seen[0].disclosure.writes, ['p.md']);
    assert.deepEqual(seen[0].disclosure.credentials, ['GITHUB_TOKEN']);
  });

  it('a falsy decision raises CONSENT_DENIED with the request echoed', async () => {
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: { requestConsent: () => ({ approved: false, reason: 'nope' }) },
    });
    await assert.rejects(
      () => enforceConsent(writeAff, { paths: [] }, ctx),
      (e) =>
        e.code === ERROR_CODES.CONSENT_DENIED &&
        e.details.reason === 'nope' &&
        e.details.request.affordance === 'demo_write'
    );
  });

  it('an approval may thread credentials back, merged into the executed input', async () => {
    // Use the real registry path (executeAffordance) with a sample affordance.
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: {
        requestConsent: () => ({ approved: true, credentials: { GITHUB_TOKEN: 'late-tok' } }),
        runGenerate: async ({ getCredential }) => {
          // The runtime should now see the late-supplied credential.
          return { changes: [{ path: 'out.md', contents: getCredential('GITHUB_TOKEN') }] };
        },
        jobStore: undefined,
      },
    });
    const started = await executeAffordance('start_generate', {}, ctx);
    assert.ok(started.id);
  });

  it('an async approval callback is awaited', async () => {
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: { requestConsent: async () => true },
    });
    const res = await enforceConsent(writeAff, { paths: [] }, ctx);
    assert.equal(res.approved, true);
  });
});

describe('consent — non-interactive opt-in + read-only invocations', () => {
  it('consentPolicy="allow" auto-approves without prompting', async () => {
    let prompted = false;
    const ctx = createAffordanceContext({
      cwd: dir,
      seams: {
        consentPolicy: 'allow',
        requestConsent: () => {
          prompted = true;
          return true;
        },
      },
    });
    const res = await enforceConsent(writeAff, { paths: [] }, ctx);
    assert.equal(res.approved, true);
    assert.equal(res.decision.bypassed, 'policy:allow');
    assert.equal(prompted, false);
  });

  it('a declared side-effect-free invocation skips the gate (derive --check)', async () => {
    const checkAff = defineAffordance({
      name: 'demo_check',
      summary: 'demo',
      actionClass: ACTION_CLASSES.WRITE,
      consent: { readOnlyWhen: (input) => Boolean(input.check) },
      input: defineSchema({ check: { type: 'boolean' } }),
      execute: () => ({}),
    });
    assert.equal(isReadOnlyInvocation(checkAff, { check: true }), true);
    assert.equal(isReadOnlyInvocation(checkAff, { check: false }), false);

    // check:true bypasses even with no seam; check:false fails closed.
    const ctx = createAffordanceContext({ cwd: dir });
    const ok = await enforceConsent(checkAff, { check: true }, ctx);
    assert.equal(ok.decision.bypassed, 'read-only-invocation');
    await assert.rejects(
      () => enforceConsent(checkAff, { check: false }, ctx),
      (e) => e.code === ERROR_CODES.CONSENT_REQUIRED
    );
  });
});

describe('consent — enforced at the registry choke point', () => {
  it('executeAffordance blocks a sample action with no seam (fail-closed)', async () => {
    await assert.rejects(
      () => executeAffordance('llm_context', { nodeIds: ['x'] }, createAffordanceContext({ cwd: dir })),
      (e) => e.code === ERROR_CODES.CONSENT_REQUIRED
    );
  });
});

describe('consent — disclosures on the real registered affordances', () => {
  it('derive discloses its target *.jsonld writes and is read-only under --check', () => {
    const derive = getAffordance('derive');
    const d = buildDisclosure(derive, { sources: ['docs/org.md'], out: 'content/derived' });
    assert.deepEqual(d.writes, ['content/derived/org.jsonld']);
    assert.equal(isReadOnlyInvocation(derive, { check: true }), true);
    assert.equal(isReadOnlyInvocation(derive, {}), false);
  });

  it('start_generate discloses a sample cost (model runtime) + handed credentials', () => {
    const gen = getAffordance('start_generate');
    const d = buildDisclosure(gen, { credentials: { GITHUB_TOKEN: 'x' } });
    assert.equal(d.cost.kind, 'sample');
    assert.equal(typeof d.cost.runtime, 'string');
    assert.deepEqual(d.credentials, ['GITHUB_TOKEN']);
  });

  it('create_pr discloses the GitHub credential and the branch it pushes', () => {
    const pr = getAffordance('create_pr');
    const d = buildDisclosure(pr, { id: 'job_x', title: 'My PR', branch: 'feat/x' });
    assert.deepEqual(d.credentials, ['GITHUB_TOKEN']);
    assert.ok(d.writes.includes('branch:feat/x'));
  });

  it('apply_changes discloses the exact paths resolved from the job change set', () => {
    const store = new JobStore();
    const apply = getAffordance('apply_changes');
    const ctx = createAffordanceContext({ cwd: dir, seams: { jobStore: store } });
    // Seed a fake succeeded job with a pending change set.
    store._jobs.set('job_z', {
      id: 'job_z',
      changes: [{ path: 'content/a.md' }, { path: 'content/b.md' }],
    });
    const d = buildDisclosure(apply, { id: 'job_z' }, ctx);
    assert.deepEqual(d.writes.sort(), ['content/a.md', 'content/b.md']);
    const only = buildDisclosure(apply, { id: 'job_z', only: ['content/b.md'] }, ctx);
    assert.deepEqual(only.writes, ['content/b.md']);
  });
});
