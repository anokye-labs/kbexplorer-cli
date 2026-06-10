import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { TaskKind, classifyTask, routeTask, routeTasks } =
  await import('../../src/lib/runtime-router.js');

function captureLogger() {
  const lines = [];
  return { log: (msg) => lines.push(msg), lines };
}

describe('classifyTask', () => {
  it('honours an explicit kind', () => {
    assert.strictEqual(classifyTask({ kind: TaskKind.FUZZY }), TaskKind.FUZZY);
    assert.strictEqual(classifyTask({ kind: TaskKind.DETERMINISTIC, prompt: 'x' }), TaskKind.DETERMINISTIC);
  });
  it('treats a prompt as fuzzy', () => {
    assert.strictEqual(classifyTask({ prompt: 'analyze the repo' }), TaskKind.FUZZY);
  });
  it('treats a run function as deterministic', () => {
    assert.strictEqual(classifyTask({ run: () => 1 }), TaskKind.DETERMINISTIC);
  });
  it('defaults to deterministic', () => {
    assert.strictEqual(classifyTask({}), TaskKind.DETERMINISTIC);
  });
});

describe('routeTask', () => {
  it('routes a deterministic task to its run() and logs the decision', async () => {
    const logger = captureLogger();
    const out = await routeTask(
      { name: 'transform', kind: 'deterministic', run: () => 'transformed' },
      { logger },
    );
    assert.strictEqual(out.kind, TaskKind.DETERMINISTIC);
    assert.strictEqual(out.result, 'transformed');
    assert.ok(logger.lines.some((l) => l.includes('transform') && l.includes('deterministic')));
  });

  it('routes a fuzzy task to runFuzzy and logs the decision', async () => {
    const logger = captureLogger();
    let received = null;
    const out = await routeTask(
      { name: 'architect', prompt: 'analyze' },
      { logger, runFuzzy: (task) => { received = task; return { response: 'ok' }; } },
    );
    assert.strictEqual(out.kind, TaskKind.FUZZY);
    assert.deepStrictEqual(out.result, { response: 'ok' });
    assert.strictEqual(received.prompt, 'analyze');
    assert.ok(logger.lines.some((l) => l.includes('architect') && l.includes('fuzzy')));
  });

  it('uses an explicit runDeterministic handler when provided', async () => {
    const out = await routeTask(
      { name: 'x', kind: 'deterministic', payload: 5 },
      { logger: captureLogger(), runDeterministic: (t) => t.payload * 2 },
    );
    assert.strictEqual(out.result, 10);
  });

  it('throws when a fuzzy task has no runFuzzy handler', async () => {
    await assert.rejects(
      routeTask({ name: 'f', prompt: 'go' }, { logger: captureLogger() }),
      /no `runFuzzy` handler/,
    );
  });

  it('throws when a deterministic task has neither run nor handler', async () => {
    await assert.rejects(
      routeTask({ name: 'd', kind: 'deterministic' }, { logger: captureLogger() }),
      /no `run` function/,
    );
  });
});

describe('routeTasks', () => {
  it('routes a mixed pipeline in order, completing both paths', async () => {
    const logger = captureLogger();
    const order = [];
    const results = await routeTasks(
      [
        { name: 'fetch', prompt: 'summarize' },
        { name: 'write', kind: 'deterministic', run: () => { order.push('det'); return 'wrote'; } },
      ],
      {
        logger,
        runFuzzy: () => { order.push('fuzzy'); return 'summary'; },
      },
    );
    assert.deepStrictEqual(order, ['fuzzy', 'det']);
    assert.deepStrictEqual(results.map((r) => r.kind), [TaskKind.FUZZY, TaskKind.DETERMINISTIC]);
    assert.deepStrictEqual(results.map((r) => r.result), ['summary', 'wrote']);
  });
});
