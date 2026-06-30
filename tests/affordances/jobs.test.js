/**
 * Workflow / job layer (PE3-F2) — lifecycle + registration tests.
 *
 * Exercises the six job affordances end-to-end through the SAME registry and
 * `executeAffordance` entry point the stateless ops use, with a fresh
 * per-test JobStore and stubbed runtime seams (no model, no git, no transport):
 *
 *   start → status → cancel
 *   start → succeed → preview → apply (incl. partial-failure recovery) → create_pr
 *   late-credential pause → resume
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { createAffordanceContext } = await import('../../src/affordances/context.js');
const { executeAffordance, describeAffordances, ACTION_CLASSES, ERROR_CODES } =
  await import('../../src/affordances/index.js');
const { JobStore, JOB_STATUS, CredentialRequiredError, defaultJobStore } =
  await import('../../src/affordances/jobs/store.js');

/** A deferred promise helper for driving async runtimes deterministically. */
function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

let dir;
let store;
/** Build a context with a fresh store + injectable runtime seams per test. */
function ctxWith(seams = {}) {
  // Default to the documented non-interactive consent opt-in so these lifecycle
  // tests drive write/sample ops without a prompt; per-test seams can override.
  return createAffordanceContext({
    cwd: dir,
    seams: { jobStore: store, consentPolicy: 'allow', ...seams },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-jobs-'));
  store = new JobStore();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('job layer — registration', () => {
  it('registers the six job ops with the documented action classes', () => {
    const byName = Object.fromEntries(describeAffordances().map((d) => [d.name, d.actionClass]));
    assert.equal(byName.start_generate, ACTION_CLASSES.SAMPLE);
    assert.equal(byName.get_job_status, ACTION_CLASSES.READ);
    assert.equal(byName.preview_changes, ACTION_CLASSES.READ);
    assert.equal(byName.cancel_job, ACTION_CLASSES.WRITE);
    assert.equal(byName.apply_changes, ACTION_CLASSES.WRITE);
    assert.equal(byName.create_pr, ACTION_CLASSES.WRITE);
  });

  it('the job ops are reachable through the same executeAffordance entry point', async () => {
    await assert.rejects(
      () => executeAffordance('get_job_status', { id: 'nope' }, ctxWith()),
      (e) => e.code === ERROR_CODES.NOT_FOUND
    );
  });

  it('job ids are deterministic content hashes (no timestamps)', () => {
    const run = () => new Promise(() => {}); // never settles
    const a = new JobStore().start({ operation: 'generate', request: { x: 1 }, run });
    const b = new JobStore().start({ operation: 'generate', request: { x: 1 }, run });
    assert.equal(a.id, b.id); // same op + input + creation index ⇒ same id
    assert.match(a.id, /^job_[0-9a-f]{12}$/);
  });
});

describe('job layer — start / status / cancel', () => {
  it('start_generate is UNSUPPORTED without an injected runtime', async () => {
    await assert.rejects(
      () => executeAffordance('start_generate', {}, ctxWith()),
      (e) => e.code === ERROR_CODES.UNSUPPORTED
    );
  });

  it('start_generate returns a running handle immediately and reports progress', async () => {
    const gate = deferred();
    const ctx = ctxWith({
      runGenerate: async ({ onProgress }) => {
        onProgress({ phase: 'thinking', completed: 1, total: 2, message: 'half' });
        await gate.promise;
        return { changes: [] };
      },
    });

    const started = await executeAffordance('start_generate', {}, ctx);
    assert.equal(started.status, JOB_STATUS.RUNNING);

    const mid = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(mid.status, JOB_STATUS.RUNNING);
    assert.equal(mid.progress.phase, 'thinking');
    assert.equal(mid.progress.completed, 1);

    gate.resolve();
    await store.settle(started.id);
    const done = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(done.status, JOB_STATUS.SUCCEEDED);
  });

  it('cancel_job aborts a running job and the runtime observes the signal', async () => {
    const gate = deferred();
    let observedAbort = false;
    const ctx = ctxWith({
      runGenerate: ({ signal }) =>
        new Promise((res, rej) => {
          signal.addEventListener('abort', () => {
            observedAbort = true;
            rej(new Error('aborted'));
          });
          gate.promise.then(res);
        }),
    });

    const started = await executeAffordance('start_generate', {}, ctx);
    const cancelled = await executeAffordance('cancel_job', { id: started.id }, ctx);
    assert.equal(cancelled.status, JOB_STATUS.CANCELLED);
    assert.equal(observedAbort, true);

    await store.settle(started.id);
    const after = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(after.status, JOB_STATUS.CANCELLED);
  });

  it('cancel_job on an unknown id is NOT_FOUND', async () => {
    await assert.rejects(
      () => executeAffordance('cancel_job', { id: 'job_missing' }, ctxWith()),
      (e) => e.code === ERROR_CODES.NOT_FOUND
    );
  });

  it('a runtime failure transitions the job to failed with a typed error', async () => {
    const ctx = ctxWith({
      runGenerate: async () => {
        throw new Error('boom');
      },
    });
    const started = await executeAffordance('start_generate', {}, ctx);
    await store.settle(started.id);
    const status = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(status.status, JOB_STATUS.FAILED);
    assert.match(status.error.message, /boom/);
  });
});

describe('job layer — preview / apply / create_pr write-back', () => {
  const CHANGES = [
    { path: 'content/new-node.md', contents: '# new\n' },
    { path: 'content/deep/child.md', contents: 'child\n' },
  ];

  async function startSucceeded(ctx, changes = CHANGES) {
    const started = await executeAffordance('start_generate', {}, ctx);
    await store.settle(started.id);
    return started.id;
  }

  it('preview_changes reports paths/sizes/disposition without writing', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: CHANGES }) });
    const id = await startSucceeded(ctx);

    const preview = await executeAffordance('preview_changes', { id }, ctx);
    assert.equal(preview.changes.length, 2);
    assert.equal(preview.changes[0].path, 'content/new-node.md');
    assert.equal(preview.changes[0].disposition, 'create');
    assert.equal(preview.changes[0].bytes, Buffer.byteLength('# new\n'));
    assert.equal('contents' in preview.changes[0], false); // not included by default
    // Nothing written.
    assert.equal(existsSync(resolve(dir, 'content/new-node.md')), false);
  });

  it('preview_changes can include full contents for diff rendering', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: CHANGES }) });
    const id = await startSucceeded(ctx);
    const preview = await executeAffordance('preview_changes', { id, contents: true }, ctx);
    assert.equal(preview.changes[0].contents, '# new\n');
  });

  it('preview/apply reject a job that has not succeeded', async () => {
    const gate = deferred();
    const ctx = ctxWith({ runGenerate: () => gate.promise });
    const started = await executeAffordance('start_generate', {}, ctx);
    await assert.rejects(
      () => executeAffordance('preview_changes', { id: started.id }, ctx),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
    gate.resolve({ changes: [] });
    await store.settle(started.id);
  });

  it('apply_changes writes the change set verbatim and marks the job applied', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: CHANGES }) });
    const id = await startSucceeded(ctx);

    const res = await executeAffordance('apply_changes', { id }, ctx);
    assert.equal(res.failed.length, 0);
    assert.equal(res.applied.length, 2);
    assert.equal(readFileSync(resolve(dir, 'content/new-node.md'), 'utf-8'), '# new\n');
    assert.equal(readFileSync(resolve(dir, 'content/deep/child.md'), 'utf-8'), 'child\n');

    const status = await executeAffordance('get_job_status', { id }, ctx);
    assert.equal(status.applied, true);
  });

  it('apply_changes is idempotent (re-apply reports unchanged)', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: CHANGES }) });
    const id = await startSucceeded(ctx);
    await executeAffordance('apply_changes', { id }, ctx);
    const again = await executeAffordance('apply_changes', { id }, ctx);
    assert.ok(again.applied.every((a) => a.status === 'unchanged'));
  });

  it('apply_changes recovers from partial failure (path escaping the root)', async () => {
    const escaping = [
      { path: 'content/ok.md', contents: 'ok\n' },
      { path: '../escape.md', contents: 'nope\n' },
    ];
    const ctx = ctxWith({ runGenerate: async () => ({ changes: escaping }) });
    const id = await startSucceeded(ctx, escaping);

    const res = await executeAffordance('apply_changes', { id }, ctx);
    assert.equal(res.applied.length, 1);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].path, '../escape.md');
    assert.equal(existsSync(resolve(dir, 'content/ok.md')), true);

    // Job is NOT marked fully applied while a write failed.
    const status = await executeAffordance('get_job_status', { id }, ctx);
    assert.equal(status.applied, false);
    assert.equal(status.partial[0].ok, false);
  });

  it('create_pr requires the changes to be applied first', async () => {
    const ctx = ctxWith({
      runGenerate: async () => ({ changes: CHANGES }),
      createPullRequest: async () => ({ url: 'http://pr/1' }),
    });
    const id = await startSucceeded(ctx);
    await assert.rejects(
      () => executeAffordance('create_pr', { id, title: 'x' }, ctx),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
  });

  it('create_pr is UNSUPPORTED without an injected git runtime', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: CHANGES }) });
    const id = await startSucceeded(ctx);
    await executeAffordance('apply_changes', { id }, ctx);
    await assert.rejects(
      () => executeAffordance('create_pr', { id, title: 'x' }, ctx),
      (e) => e.code === ERROR_CODES.UNSUPPORTED
    );
  });

  it('create_pr drives the injected runtime and returns its url after apply', async () => {
    const seen = [];
    const ctx = ctxWith({
      runGenerate: async () => ({ changes: CHANGES }),
      createPullRequest: async (args) => {
        seen.push(args);
        return { url: 'https://example/pr/7', branch: 'kbx/job' };
      },
    });
    const id = await startSucceeded(ctx);
    await executeAffordance('apply_changes', { id }, ctx);

    const pr = await executeAffordance(
      'create_pr',
      { id, title: 'Add nodes', body: 'desc', branch: 'kbx/job' },
      ctx
    );
    assert.equal(pr.url, 'https://example/pr/7');
    assert.equal(pr.branch, 'kbx/job');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, 'Add nodes');
    assert.equal(seen[0].changes.length, 2);
  });
});

describe('job layer — late-credential prompt + resume recovery', () => {
  it('pauses on a missing credential, then resumes the same job under its id', async () => {
    let attempt = 0;
    const ctx = ctxWith({
      runGenerate: async ({ getCredential }) => {
        attempt += 1;
        const token = getCredential('GITHUB_TOKEN'); // throws first time
        return { changes: [{ path: 'content/gen.md', contents: `tok:${token}\n` }] };
      },
    });

    const started = await executeAffordance('start_generate', {}, ctx);
    await store.settle(started.id);

    const paused = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(paused.status, JOB_STATUS.AWAITING_CREDENTIAL);
    assert.equal(paused.needs.credential, 'GITHUB_TOKEN');

    // Resume the SAME job id with the credential supplied late.
    const resumed = await executeAffordance(
      'start_generate',
      { resume: started.id, credentials: { GITHUB_TOKEN: 'secret' } },
      ctx
    );
    assert.equal(resumed.id, started.id);
    assert.equal(resumed.status, JOB_STATUS.RUNNING);

    await store.settle(started.id);
    const done = await executeAffordance('get_job_status', { id: started.id }, ctx);
    assert.equal(done.status, JOB_STATUS.SUCCEEDED);
    assert.equal(done.changeCount, 1);
    assert.equal(attempt, 2);
  });

  it('resuming a succeeded job is rejected as invalid input', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: [] }) });
    const started = await executeAffordance('start_generate', {}, ctx);
    await store.settle(started.id);
    await assert.rejects(
      () => executeAffordance('start_generate', { resume: started.id }, ctx),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
  });

  it('resuming an unknown job id is NOT_FOUND', async () => {
    const ctx = ctxWith({ runGenerate: async () => ({ changes: [] }) });
    await assert.rejects(
      () => executeAffordance('start_generate', { resume: 'job_ghost' }, ctx),
      (e) => e.code === ERROR_CODES.NOT_FOUND
    );
  });
});

describe('job layer — store internals', () => {
  it('CredentialRequiredError carries the credential name', () => {
    const e = new CredentialRequiredError('NPM_TOKEN');
    assert.equal(e.credential, 'NPM_TOKEN');
  });

  it('exposes a process-wide default store distinct from a fresh one', () => {
    assert.ok(defaultJobStore instanceof JobStore);
    assert.notEqual(defaultJobStore, new JobStore());
  });

  it('the job layer imports no transport (MCP/JSON-RPC)', async () => {
    const { readFileSync: rf, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { resolve: r, dirname, join: j } = await import('node:path');
    const root = r(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'affordances', 'jobs');
    const importRe =
      /(?:^|\n)\s*(?:import\b[^\n]*?from\s*|import\s*\(|(?:const|let|var)\s+[^\n=]*=\s*require\()\s*['"]([^'"]+)['"]/g;
    const forbidden = /modelcontextprotocol|json-?rpc|StdioServerTransport|server\/mcp/i;
    for (const e of readdirSync(root)) {
      if (!e.endsWith('.js')) continue;
      const src = rf(j(root, e), 'utf-8');
      let m;
      while ((m = importRe.exec(src)) !== null) {
        assert.doesNotMatch(m[1], forbidden, `${e} imports a transport: ${m[1]}`);
      }
    }
  });
});
