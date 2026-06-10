#!/usr/bin/env node
/**
 * Hermetic stand-in for the real `copilot` binary, used by the runtime tests.
 *
 * It is invoked through the runtime's real child_process path (via `binaryArgs`)
 * so the spawn / stdout-capture / exit-code plumbing is exercised end-to-end
 * WITHOUT a live LLM or network.
 *
 * Behavior is controlled by environment variables:
 *   MOCK_COPILOT_MODE   = 'text' | 'json' | 'fail' | 'hang'   (default 'text')
 *   MOCK_COPILOT_STDOUT = literal text to print to stdout      (mode 'text')
 *   MOCK_COPILOT_STDERR = literal text to print to stderr
 *   MOCK_COPILOT_EXIT   = exit code to use                     (default 0; mode 'fail' => 7)
 *   MOCK_COPILOT_RESPONSE = assistant text emitted as a JSONL event (mode 'json')
 *
 * It also echoes its received argv to stderr so tests can assert assembly.
 */

const args = process.argv.slice(2);
const mode = process.env.MOCK_COPILOT_MODE || 'text';

process.stderr.write(`MOCK_ARGV ${JSON.stringify(args)}\n`);
if (process.env.MOCK_COPILOT_STDERR) {
  process.stderr.write(process.env.MOCK_COPILOT_STDERR);
}

if (mode === 'hang') {
  // Never exit on its own — the runtime's timeout must terminate us.
  setInterval(() => {}, 1000);
} else if (mode === 'json') {
  const lines = process.env.MOCK_COPILOT_RESPONSE
    ? [
        { type: 'status', message: 'starting' },
        { type: 'assistant', text: process.env.MOCK_COPILOT_RESPONSE },
        { type: 'stats', tokens: 1 },
      ]
    : [
        { type: 'status', message: 'starting' },
        { type: 'assistant', text: 'Hello from ' },
        { type: 'assistant_message', content: 'the mock.' },
        { type: 'stats', tokens: 42 },
      ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\n');
  process.exit(Number(process.env.MOCK_COPILOT_EXIT || 0));
} else if (mode === 'fail') {
  process.exit(Number(process.env.MOCK_COPILOT_EXIT || 7));
} else {
  process.stdout.write(process.env.MOCK_COPILOT_STDOUT ?? 'mock response text\n');
  process.exit(Number(process.env.MOCK_COPILOT_EXIT || 0));
}
