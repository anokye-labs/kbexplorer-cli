# Copilot programmatic-mode runtime

`kbx` runs **fuzzy** (LLM / agentic) work through GitHub Copilot CLI's
non-interactive mode — `copilot -p "<prompt>"` — and **deterministic** work
through pure, in-process computation (the catalogue → content transform, manifest
regeneration, etc.). A small **router** sends each task to the right place so
callers get consistent behavior regardless of task type.

This is the runtime substrate introduced by Feature **F7** (issue #17). It is
designed to be reused: later features (e.g. **F8**, build-time fuzzy / `docx` →
JSON‑LD extraction) call `runCopilot(...)` directly rather than re-shelling out
to `copilot`.

```
              ┌─────────────────────────┐
  task  ───▶  │   runtime-router        │
              │   classifyTask/routeTask│
              └───────────┬─────────────┘
            fuzzy ────────┘     └──────── deterministic
              │                               │
     ┌────────▼─────────┐            ┌────────▼─────────┐
     │  copilot-runtime │            │  pure functions  │
     │  runCopilot()    │            │  transform, …    │
     │  → copilot -p    │            └──────────────────┘
     └──────────────────┘
```

## Requirements

- [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) installed
  and on your `PATH`, **or** the `KBX_COPILOT_BIN` environment variable
  pointing at the binary.
- Non-interactive runs need auto-approval of tools: pass `--allow-all-tools`
  (trusted flows) or a scoped allowlist via `--allow-tool` (see below).

## Configuration

| Setting | Where | Notes |
|---|---|---|
| Binary path | `KBX_COPILOT_BIN` env, or `binary` option | Defaults to `copilot` on `PATH`. |
| Tool permissions | `--allow-tool` / `--allow-all-tools` (CLI), `allowTools` / `allowAllTools` (API) | A scoped `--allow-tool` opts out of the implicit `--allow-all-tools`. |
| Model | `--model` (CLI), `model` (API) | Forwarded to `copilot --model`. |
| Time budget | `--timeout <ms>` (CLI), `timeoutMs` (API) | Default 600000 ms (10 min). |
| Output format | `outputFormat: 'text' \| 'json'` (API) | `json` is JSONL (one event per line). |

## `kbx generate`

```bash
kbx generate                       # copilot -p → catalogue.json → content/ → manifest
kbx generate --dry-run             # print the assembled copilot command, run nothing
kbx generate --prompt "…"          # override the architect prompt
kbx generate --allow-tool 'shell(git)' --allow-tool 'write'   # scoped permissions
kbx generate --model gpt-5.2
kbx generate --refresh             # re-run analysis even if catalogue.json exists
kbx generate --no-agent            # transform an existing catalogue only
```

The fuzzy step defaults to `--allow-all-tools` (trusted local analysis of your
own repo; non-interactive mode requires auto-approval). Supplying any
`--allow-tool` switches to a scoped allowlist instead.

## Public API — `src/lib/copilot-runtime.js`

The adapter is zero-dependency ESM. Its public surface is stable and intended
for reuse.

### `runCopilot(options) → Promise<RuntimeResult>`

Spawns `copilot -p`, captures output, and returns a structured result. Rejects
with a `CopilotRuntimeError` (carrying a `.code`) on a missing binary, timeout,
or — unless `throwOnError: false` — a non-zero exit.

```js
import { runCopilot, RuntimeErrorCode, CopilotRuntimeError } from './src/lib/copilot-runtime.js';

try {
  const res = await runCopilot({
    prompt: 'Summarize package.json as JSON-LD',
    allowTools: ['view', 'shell(git)'],   // or allowAllTools: true
    outputFormat: 'json',                  // parse JSONL into res.events
    model: 'gpt-5.2',
    timeoutMs: 120_000,
    cwd: process.cwd(),
    onEvent: (e) => {/* stream each JSONL event */},
  });
  console.log(res.ok, res.exitCode, res.response);
} catch (err) {
  if (err instanceof CopilotRuntimeError && err.code === RuntimeErrorCode.BINARY_MISSING) {
    // actionable: install Copilot CLI or set KBX_COPILOT_BIN
  }
}
```

**Options** (all of `buildCopilotArgs`, plus):

| Option | Type | Default | Purpose |
|---|---|---|---|
| `prompt` | `string` | — | **Required.** The prompt text. |
| `allowTools` | `string[]` | `[]` | Each → `--allow-tool=<spec>` (e.g. `shell(git)`, `write`). |
| `denyTools` | `string[]` | `[]` | Each → `--deny-tool=<spec>`. |
| `allowAllTools` | `boolean` | `false` | `--allow-all-tools`. |
| `allowAll` | `boolean` | `false` | `--allow-all` (tools + paths + urls). |
| `model` | `string` | — | `--model`. |
| `outputFormat` | `'text' \| 'json'` | — | `--output-format`; `json` ⇒ `res.events` populated. |
| `silent` | `boolean` | `false` | `-s` (response only, no stats). |
| `noColor` | `boolean` | `true` | `--no-color` for clean capture. |
| `addDirs` | `string[]` | `[]` | `--add-dir <dir>` (repeatable). |
| `logLevel` | `string` | — | `--log-level`. |
| `extraArgs` | `string[]` | `[]` | Verbatim pass-through (forward-compat for new flags). |
| `binary` | `string` | resolved | Override the binary path. |
| `binaryArgs` | `string[]` | `[]` | Args inserted between binary and copilot args (wrappers / tests). |
| `cwd` | `string` | `process.cwd()` | Working directory. |
| `env` | object | `process.env` | Child environment. |
| `timeoutMs` | `number` | `600000` | Time budget; exceeding it rejects with `TIMEOUT`. |
| `input` | `string` | — | Optional stdin payload. |
| `throwOnError` | `boolean` | `true` | Reject on non-zero exit when true. |
| `spawn` | `Function` | `child_process.spawn` | Injectable for hermetic tests. |
| `onEvent` | `Function` | — | Called per parsed JSONL event (json mode). |
| `platform` | `string` | `process.platform` | Injectable for testing the Windows dispatch below. |

**Cross-platform binary dispatch (Windows):** Node's default `shell: false`
spawn cannot exec a `.cmd`/`.bat` shim (`EINVAL`) or a bare `.mjs`/`.js` file
(`EFTYPE`) on Windows. `runRuntimeTask` detects the target extension on
`win32` and adjusts automatically — a `custom` adapter (or a
`KBX_COPILOT_BIN`/`KBX_CLAUDE_BIN` override) pointed at one of these still
works without a manual `node`-wrapping workaround:

| Target extension | Windows behavior |
|---|---|
| `.cmd`, `.bat` | Re-invoked through the shell (`shell: true`), with every argument quoted for `cmd.exe`. |
| `.mjs`, `.js` | Re-invoked as `process.execPath <script> …args`. |
| anything else | Unchanged (`shell: false`, direct exec). |

Non-Windows platforms are never affected. `resolveSpawnPlan(binary, args, { platform, execPath })`
is the pure function behind this decision — see `src/lib/copilot-runtime.js`.

**`RuntimeResult`**

```ts
{
  ok: boolean;            // exitCode === 0
  exitCode: number|null;  // null when killed by signal
  signal: string|null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  response: string;       // best-effort final assistant text (or trimmed stdout)
  events: object[];       // parsed JSONL (empty unless outputFormat === 'json')
  binary: string;
  args: string[];
  command: string;        // human-readable, for logs
  durationMs: number;
}
```

### Other exports

| Export | Description |
|---|---|
| `buildCopilotArgs(options)` | Pure argv assembly (no binary). Deterministic — easy to unit-test. |
| `resolveBinary(options)` | Resolve the binary: explicit → `KBX_COPILOT_BIN` → `copilot`. |
| `isCopilotAvailable(options)` | `true` if `copilot --version` runs (binary present). Never throws. |
| `parseJsonl(text)` | Parse JSONL into events, skipping non-JSON lines. |
| `extractResponseText(events, raw)` | Best-effort final assistant text; falls back to raw stdout. |
| `CopilotRuntimeError` | Error with `.code`, `.exitCode`, `.result`. |
| `RuntimeErrorCode` | `BINARY_MISSING`, `TIMEOUT`, `NONZERO_EXIT`, `SPAWN_FAILED`, `INVALID_INPUT`. |
| `DEFAULT_COPILOT_BINARY`, `COPILOT_BIN_ENV`, `DEFAULT_TIMEOUT_MS` | Constants. |

## Public API — `src/lib/runtime-router.js`

| Export | Description |
|---|---|
| `TaskKind` | `{ DETERMINISTIC, FUZZY }`. |
| `classifyTask(task)` | Decide a task's kind: explicit `kind` → `prompt` (fuzzy) → `run` (deterministic) → default deterministic. |
| `routeTask(task, deps)` | Route one task, logging the decision (`[router] <name> → <kind>`). |
| `routeTasks(tasks, deps)` | Route a pipeline of tasks in order. |

A *task* is `{ name?, kind?, prompt?, run?, … }`. `deps` provides
`runFuzzy(task)` (typically wrapping `runCopilot`), an optional
`runDeterministic(task)` (defaults to calling `task.run()`), and a `logger`.

```js
import { routeTask } from './src/lib/runtime-router.js';
import { runCopilot } from './src/lib/copilot-runtime.js';

await routeTask(
  { name: 'architect', prompt: 'Analyze the repo and write catalogue.json', allowAllTools: true },
  { logger: console, runFuzzy: (t) => runCopilot(t) },
);
```

## Testing

The suite is **hermetic** — it never calls a live LLM:

- Command assembly, JSONL parsing, and error handling are unit-tested with an
  injected `spawn`.
- The real `child_process` path is exercised end-to-end against
  `tests/fixtures/mock-copilot.mjs` (via `binary`/`binaryArgs`), covering
  success, JSONL, non-zero exit, and timeout.
- Router paths and `generate --dry-run` are covered directly.

```bash
npm test
```

## See also

- **F8 build-time derivation** — `kbx derive` reuses `runCopilot(...)`
  through the router to turn `.docx`/prose into committed `*.jsonld`. See the
  "Build-time Derivation" section of the [README](../README.md) and
  `src/commands/derive.js`.
- **Engine node-type contract** — derived artifacts conform to the template
  engine's contract (Epic 1 / F1,
  [kbexplorer-template#148](https://github.com/anokye-labs/kbexplorer-template/issues/148)):
  `kg://` `@id` URNs, an open `@type`, and the six-relation taxonomy
  `leads | staffs | reports-to | structural | derived | deprecated`.

