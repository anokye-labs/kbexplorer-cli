/**
 * Deterministic vs. fuzzy task router.
 *
 * One consistent entry point that sends *deterministic* work down the existing
 * pure-computation path (e.g. catalogue → content transform, manifest
 * regeneration) and *fuzzy* work to the Copilot programmatic-mode runtime
 * ({@link module:lib/copilot-runtime}). Callers get the same shape back
 * regardless of task type, and every routing decision is logged for
 * observability.
 *
 * A task is a plain object:
 *   {
 *     name?: string,                 // label for logs
 *     kind?: 'deterministic'|'fuzzy',// explicit override (optional)
 *     prompt?: string,               // present ⇒ fuzzy (LLM) work
 *     run?: () => any,               // present ⇒ deterministic work
 *     ...                            // extra fields forwarded to handlers
 *   }
 *
 * ── Public API ──
 *   TaskKind                         frozen { DETERMINISTIC, FUZZY }
 *   classifyTask(task)   -> TaskKind
 *   routeTask(task, deps)-> Promise<{ kind, name, result }>
 *   routeTasks(tasks, deps) -> Promise<Array<{ kind, name, result }>>
 */

/** The two routing destinations. */
export const TaskKind = Object.freeze({
  DETERMINISTIC: 'deterministic',
  FUZZY: 'fuzzy',
});

/**
 * Decide which path a task takes.
 *
 * Precedence:
 *   1. explicit `task.kind`
 *   2. a `prompt` ⇒ fuzzy
 *   3. a `run` function ⇒ deterministic
 *   4. default ⇒ deterministic (safest: no LLM call unless asked for)
 *
 * @param {object} task
 * @returns {('deterministic'|'fuzzy')}
 */
export function classifyTask(task = {}) {
  if (task.kind === TaskKind.FUZZY || task.kind === TaskKind.DETERMINISTIC) {
    return task.kind;
  }
  if (typeof task.prompt === 'string' && task.prompt.length > 0) {
    return TaskKind.FUZZY;
  }
  if (typeof task.run === 'function') {
    return TaskKind.DETERMINISTIC;
  }
  return TaskKind.DETERMINISTIC;
}

function defaultLogger() {
  return console;
}

/**
 * Route a single task to the correct handler, logging the decision.
 *
 * @param {object} task
 * @param {object} deps
 * @param {(task: object) => any} [deps.runDeterministic]  Handler for deterministic tasks.
 *        Defaults to invoking `task.run()`.
 * @param {(task: object) => any} deps.runFuzzy            Handler for fuzzy tasks (required
 *        when any fuzzy task is routed) — typically wraps `runCopilot`.
 * @param {{ log: Function }} [deps.logger]                Logger (defaults to console).
 * @returns {Promise<{ kind: string, name: string, result: any }>}
 */
export async function routeTask(task, deps = {}) {
  const {
    runDeterministic = (t) => {
      if (typeof t.run !== 'function') {
        throw new TypeError(
          `Deterministic task "${t.name ?? 'task'}" has no \`run\` function and no \`runDeterministic\` handler was provided.`,
        );
      }
      return t.run();
    },
    runFuzzy,
    logger = defaultLogger(),
  } = deps;

  const kind = classifyTask(task);
  const name = task?.name ?? 'task';
  logger.log(`[router] ${name} → ${kind}`);

  if (kind === TaskKind.FUZZY) {
    if (typeof runFuzzy !== 'function') {
      throw new TypeError(
        `Fuzzy task "${name}" routed but no \`runFuzzy\` handler was provided.`,
      );
    }
    return { kind, name, result: await runFuzzy(task) };
  }

  return { kind, name, result: await runDeterministic(task) };
}

/**
 * Route a list of tasks sequentially (order preserved). Useful for pipelines
 * that interleave deterministic and fuzzy steps (e.g. `generate`).
 *
 * @param {object[]} tasks
 * @param {object} deps  See {@link routeTask}.
 * @returns {Promise<Array<{ kind: string, name: string, result: any }>>}
 */
export async function routeTasks(tasks = [], deps = {}) {
  const out = [];
  for (const task of tasks) {
    out.push(await routeTask(task, deps));
  }
  return out;
}
