#!/usr/bin/env node
/**
 * Deterministic agent-runtime twin (kbexplorer-cli issue #59).
 *
 * A fake "agent" executable that speaks the programmatic-mode contract the
 * runtime adapters expect (src/lib/copilot-runtime.js): it is invoked the same
 * way the real `copilot` / `claude` CLIs are — `<bin> -p "<prompt>" [flags…]` —
 * reads the prompt out of argv, looks up a *canned* response keyed by the prompt
 * content (./fixtures.mjs), and prints structured output that
 * `extractResponseText` / `parseExtraction` parse back into an extraction.
 *
 * Point the CLI at it via the existing binary-override env so a full
 * `derive` / `generate` run completes hermetically with NO live LLM:
 *
 *   # copilot adapter (default) — emits copilot-style JSONL events
 *   KBEXPLORER_COPILOT_BIN="node /abs/path/twins/agent/fake-agent.mjs" kbexplorer derive src.docx
 *
 *   # claude adapter — emits a single Claude `--output-format json` result object
 *   KBEXPLORER_RUNTIME=claude \
 *   KBEXPLORER_CLAUDE_BIN="node /abs/path/twins/agent/fake-agent.mjs" kbexplorer derive src.docx
 *
 * (The runtime spawns the binary with `shell:false`, so when the override needs
 * `node <script>` the adapter's binary/binaryArgs split is used — see the README
 * and tests for the exact invocation. When this file is itself made executable
 * it can be the bare binary.)
 *
 * Output format is auto-detected from argv:
 *   --output-format json   → one Claude-shaped JSON object  { type: "result", result: "<json>" }
 *   otherwise              → copilot-shaped JSONL assistant events
 *
 * Diagnostics: the received argv and the matched fixture key are echoed to
 * stderr (never stdout, so they cannot pollute the parsed response).
 *
 * HOLDOUT RULE: responses come from ./fixtures.mjs (fixtures only). No test
 * expectations live in this file or the fixtures — assertions live in the tests.
 */

import { pathToFileURL } from 'node:url';
import { selectFixture } from './fixtures.mjs';

/**
 * Pull the prompt out of an argv array. All three adapters (copilot, claude,
 * custom) place the prompt as the value immediately following `-p`. The custom
 * adapter may use a different flag, so as a fallback we take the first argv
 * token that parses as our extraction prompt (contains "SOURCE DOCUMENT").
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function extractPromptFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const pIndex = args.indexOf('-p');
  if (pIndex >= 0 && pIndex + 1 < args.length) {
    return args[pIndex + 1];
  }
  const promptFlag = args.indexOf('--prompt');
  if (promptFlag >= 0 && promptFlag + 1 < args.length) {
    return args[promptFlag + 1];
  }
  // Fallback: the longest non-flag token (the prompt is by far the largest arg).
  let best = '';
  for (const a of args) {
    if (typeof a === 'string' && !a.startsWith('-') && a.length > best.length) best = a;
  }
  return best;
}

/** True when argv requests Claude-style single-object JSON output. */
export function wantsClaudeJson(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const i = args.indexOf('--output-format');
  return i >= 0 && args[i + 1] === 'json';
}

/**
 * Render the canned extraction as the bytes the agent prints to stdout.
 *
 * @param {object} extraction  The canned `{ entities, relationships }`.
 * @param {{ claudeJson?: boolean }} [options]
 * @returns {string}
 */
export function renderOutput(extraction, { claudeJson = false } = {}) {
  const responseText = JSON.stringify(extraction);
  if (claudeJson) {
    // Claude `--output-format json` terminal payload: `extractResponseText`
    // reads `result` off a `type: "result"` event.
    return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: responseText }) + '\n';
  }
  // Copilot-style JSONL: status noise + the assistant message carrying the JSON.
  const events = [
    { type: 'status', message: 'twin: starting' },
    { type: 'assistant', text: responseText },
    { type: 'stats', tokens: responseText.length },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Entry point: parse argv, select a fixture, emit deterministic output. */
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  stderr.write(`TWIN_ARGV ${JSON.stringify(argv)}\n`);

  const prompt = extractPromptFromArgv(argv);
  const { key, extraction } = selectFixture(prompt);
  stderr.write(`TWIN_FIXTURE ${key}\n`);

  stdout.write(renderOutput(extraction, { claudeJson: wantsClaudeJson(argv) }));
  return 0;
}

// Run only when invoked as a script (not when imported by tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || process.env.KBEXPLORER_TWIN_FORCE_MAIN === '1') {
  process.exit(main());
}
