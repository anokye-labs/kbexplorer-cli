/**
 * Live, end-to-end proof of the kb_ask sampling round-trip against a REAL model.
 *
 * The unit/subprocess tests answer `sampling/createMessage` with a canned
 * string, which proves the wiring but not that a real model produces a grounded
 * answer. And GitHub Copilot CLI 1.0.64 — the obvious host to try — does not yet
 * implement MCP *sampling* as a host, so pointing Copilot at this server only
 * exercises the degraded path.
 *
 * This bridge closes that gap by inverting the roles: it is itself an MCP host
 * that
 *   - spawns the *real* shipped server (`node bin/cli.js mcp`) over stdio,
 *   - advertises the `sampling` capability, and
 *   - services every `sampling/createMessage` by shelling out to a real model
 *     (`copilot -p`), returning the model's text as the assistant message.
 *
 * Calling `kb_ask` then drives a genuine retrieval-augmented answer: the server
 * scopes the graph to its roots, retrieves context, and asks *our* host to
 * sample — which we satisfy with a real Copilot completion. The result is a
 * true `usedSampling: true` answer grounded in this repo's own content.
 *
 * Requirements: GitHub Copilot CLI on PATH (or KBEXPLORER_COPILOT_BIN), network
 * access, and a signed-in Copilot session. This is a manual verification
 * artifact (like scripts/mcp-smoke.mjs), not part of `npm test`.
 *
 * Usage:
 *   node scripts/mcp-sampling-bridge.mjs ["your question"]
 *   npm run mcp:bridge
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const CLI = join(repoRoot, 'bin', 'cli.js');
const COPILOT = process.env.KBEXPLORER_COPILOT_BIN || (process.platform === 'win32' ? 'copilot.exe' : 'copilot');
const COPILOT_TIMEOUT_MS = Number(process.env.KBEXPLORER_COPILOT_TIMEOUT_MS || 150000);

/**
 * Run the real model on a fully-assembled prompt and resolve with its stdout.
 * Runs in a throwaway cwd so the model does not load this repo's agent
 * instructions or wander the file tree — it should answer purely from the
 * context the server handed us.
 */
function sampleWithCopilot(prompt) {
  return new Promise((resolveText, reject) => {
    const scratch = mkdtempSync(join(tmpdir(), 'kb-bridge-'));
    const child = spawn(COPILOT, ['-p', prompt], { cwd: scratch, shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`copilot -p timed out after ${COPILOT_TIMEOUT_MS}ms`));
    }, COPILOT_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      reject(new Error(`failed to spawn ${COPILOT}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      if (code === 0) resolveText(out.trim());
      else reject(new Error(`copilot -p exited ${code}: ${(err || out).slice(0, 500)}`));
    });
  });
}

function flattenMessages(messages = []) {
  return messages
    .map((m) => {
      const c = m.content;
      if (Array.isArray(c)) return c.map((p) => p?.text ?? '').join('\n');
      return c?.text ?? '';
    })
    .join('\n\n');
}

async function main() {
  const question =
    process.argv.slice(2).join(' ').trim() ||
    "What is kbexplorer's dependency philosophy, and how does the new `kbexplorer mcp` server fit into it?";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: repoRoot, // no host roots granted -> server falls back to this repo (full graph)
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'kb-sampling-bridge', version: '0.1.0' },
    { capabilities: { sampling: {} } },
  );

  let bridged = 0;
  client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
    bridged++;
    const p = req.params;
    const sys = p.systemPrompt ? `${p.systemPrompt}\n\n` : '';
    const body = flattenMessages(p.messages);
    const prompt =
      `${sys}${body}\n\n` +
      'Answer the question using ONLY the context nodes above. Cite the node ids ' +
      'you used in [square brackets]. Be concise. Do not use any tools or read any files.';
    process.stderr.write(`\n[bridge] sampling/createMessage -> ${COPILOT} -p  (prompt: ${prompt.length} chars)\n`);
    const text = await sampleWithCopilot(prompt);
    return {
      role: 'assistant',
      model: 'github-copilot-cli',
      stopReason: 'endTurn',
      content: { type: 'text', text },
    };
  });

  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`\n● connected to ${info?.name} v${info?.version} (real stdio subprocess)`);

  const stats = JSON.parse(
    (await client.callTool({ name: 'kb_graph_stats', arguments: {} })).content.find((c) => c.type === 'text').text,
  );
  console.log(`● scoped graph: ${stats.nodeCount} nodes / ${stats.edgeCount} edges`);
  console.log(`\n● Q: ${question}\n`);
  console.log('● asking the host (us) to sample a real model via copilot -p ...');

  const res = await client.callTool({ name: 'kb_ask', arguments: { question } });
  const payload = JSON.parse(res.content.find((c) => c.type === 'text').text);

  console.log(`\n────────────────────────────────────────────────────────`);
  console.log(`usedSampling : ${payload.usedSampling}`);
  console.log(`model        : ${payload.model}`);
  console.log(`stopReason   : ${payload.stopReason}`);
  console.log(`\n--- ANSWER (real model, grounded in the graph) ---\n`);
  console.log(payload.answer || '(no answer returned)');
  console.log(`\n--- CITATIONS ---`);
  for (const c of payload.citations || []) console.log(`  [${c.id}] ${c.title}  (cluster: ${c.cluster})`);
  console.log(`────────────────────────────────────────────────────────\n`);

  await client.close();

  const ok = payload.usedSampling === true && bridged >= 1 && typeof payload.answer === 'string' && payload.answer.length > 0;
  if (!ok) {
    console.error(
      `FAIL: expected a real-model sampling round-trip ` +
        `(usedSampling=${payload.usedSampling}, bridgeCalls=${bridged}, answerLen=${payload.answer?.length ?? 0})`,
    );
    process.exit(1);
  }
  console.log(`PASS ✓ real-model sampling round-trip — bridge serviced ${bridged} createMessage call(s).`);
}

main().catch((err) => {
  console.error(`\nbridge error: ${err?.stack || err}`);
  process.exit(1);
});
