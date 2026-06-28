# Deterministic agent-runtime twin

A **fake agent executable** that speaks the same programmatic-mode contract as
the real `copilot` / `claude` CLIs (see `src/lib/copilot-runtime.js`), but
returns **canned, content-keyed responses** instead of calling a live LLM. It
lets full-pipeline `derive` / `generate` tests — and manual dress rehearsals —
exercise the fuzzy phases end-to-end, hermetically and deterministically.

> **Holdout rule.** The canned responses in [`fixtures.mjs`](./fixtures.mjs) are
> *fixtures only*. They describe what the twin returns; they do **not** encode
> test expectations. Assertions about derive/extract output live in the tests
> (`tests/twins/agent.test.js`), never in the twin.

## What it does

The runtime adapters invoke an agent as `<bin> -p "<prompt>" [flags…]` and parse
its stdout back into a response (`extractResponseText` → `parseExtraction`). The
twin:

1. Reads the prompt from `-p <prompt>` in argv.
2. Selects a canned extraction by matching the prompt against
   [`fixtures.mjs`](./fixtures.mjs) (first substring match wins; falls back to a
   default extraction when nothing matches).
3. Prints structured output in the shape the invoking adapter expects:
   - **copilot** (default): copilot-style JSONL events, with the extraction JSON
     carried in an `assistant` event.
   - **claude** (`--output-format json` in argv): a single Claude
     `{ "type": "result", "result": "<json>" }` object.
4. Echoes the received argv and the matched fixture key to **stderr** (never
   stdout), so diagnostics never pollute the parsed response.

The result is fully deterministic: the same source content always yields the
same graph.

## Files

| File | Purpose |
| --- | --- |
| `fake-agent.mjs` | The twin. Importable (pure helpers + `main`) and runnable. |
| `fixtures.mjs` | Canned `{ entities, relationships }` keyed by prompt substring. |
| `fake-agent` | POSIX launcher (`#!/bin/sh`) — a single executable path. |
| `fake-agent.cmd` | Windows launcher (`node fake-agent.mjs %*`). |

## Pointing the CLI at the twin

The runtime spawns the agent binary with `shell:false`. How you select the twin
depends on the platform, because of what Node's `shell:false` spawn accepts.

### Cross-platform (recommended for tests): `node` + the script

The most portable hermetic invocation — used by the tests — runs `node` as the
binary and passes the twin script via the adapter's `binaryArgs`:

```js
import { extractEntities } from '../../src/lib/extract.js';
const TWIN = '<repo>/twins/agent/fake-agent.mjs';
await extractEntities({
  document,
  runtimeOptions: { binary: process.execPath, binaryArgs: [TWIN] },
});
```

This works identically on Windows, macOS, and Linux.

### Via the binary-override env var

The existing overrides (`KBX_COPILOT_BIN`, `KBX_CLAUDE_BIN`) set
the spawned binary path directly:

- **macOS / Linux** — point the override at the POSIX launcher (mark it
  executable once with `chmod +x twins/agent/fake-agent`):

  ```sh
  chmod +x twins/agent/fake-agent
  KBX_COPILOT_BIN="$PWD/twins/agent/fake-agent" kbx derive src.docx
  ```

- **claude adapter** — same idea with the claude override + runtime selector:

  ```sh
  KBX_RUNTIME=claude \
  KBX_CLAUDE_BIN="$PWD/twins/agent/fake-agent" kbx derive src.docx
  ```

- **Windows** — Node refuses to spawn `.cmd`/`.bat` files with `shell:false`
  (`EINVAL`) and cannot exec a bare `.mjs` (`EFTYPE`). Point the override at
  `node` and pass the script through a wrapper, or use the cross-platform
  `binary`/`binaryArgs` form above in tests. The `fake-agent.cmd` launcher is
  provided for callers that *do* spawn through a shell.

## Adding fixtures

Append to the `FIXTURES` array in [`fixtures.mjs`](./fixtures.mjs):

```js
{ key: 'my-case', match: 'unique substring of the source text', extraction: { entities: [...], relationships: [...] } }
```

`match` is matched case-sensitively as a substring against the full prompt
(which embeds the source document body). Order matters — put more specific
`match` strings earlier, since the first match wins.

