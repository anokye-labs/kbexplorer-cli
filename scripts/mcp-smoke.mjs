/**
 * mcp-smoke.mjs — reusable, model-free smoke test for `kbexplorer mcp`.
 *
 * Spawns the real shipped binary (`node bin/cli.js mcp`) and drives it with the
 * official MCP SDK `StdioClientTransport`, dogfooding *this* repo's own
 * `content/` as the host-granted root. It answers `roots` and `sampling` with
 * canned responses (no live model), then exercises the tool surface and asserts
 * the server behaves end-to-end.
 *
 * Usage:  node scripts/mcp-smoke.mjs   (or: npm run mcp:smoke)
 * Exits 0 on success, 1 on any failed assertion or transport error.
 */

import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema, CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CLI = join(repoRoot, 'bin', 'cli.js');

function parseToolJson(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text == null ? undefined : JSON.parse(text);
}

function log(step, detail = '') {
  process.stdout.write(`  ✓ ${step}${detail ? ` — ${detail}` : ''}\n`);
}

async function main() {
  process.stdout.write('kbexplorer mcp smoke (dogfooding this repo)\n');

  let samplingCalls = 0;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: repoRoot,
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'kbexplorer-smoke', version: '0.0.0' },
    { capabilities: { roots: {}, sampling: {} } },
  );

  // Host-granted root = this repository. Confines everything the server reads.
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: pathToFileURL(repoRoot).href, name: 'kbexplorer-cli' }],
  }));
  // Canned, deterministic "model": echoes the cited node ids back as an answer.
  client.setRequestHandler(CreateMessageRequestSchema, (req) => {
    samplingCalls++;
    const text = req.params.messages?.[0]?.content?.text ?? '';
    const ids = [...text.matchAll(/### \[([^\]]+)\]/g)].map((m) => m[1]);
    return {
      role: 'assistant',
      content: { type: 'text', text: `Grounded answer citing ${ids.map((i) => `[${i}]`).join(', ') || '(no nodes)'}.` },
      model: 'smoke-model',
      stopReason: 'endTurn',
    };
  });

  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    assert.equal(info.name, 'kbexplorer');
    log('handshake', `${info.name}@${info.version}`);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['kb_ask', 'kb_get_node', 'kb_graph_stats', 'kb_neighbors', 'kb_query']);
    log('tools/list', names.join(', '));

    const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.ok(stats.nodeCount > 0, 'expected at least one node in this repo');
    assert.ok(Array.isArray(stats.roots) && stats.roots.length > 0, 'expected scoped roots');
    log('kb_graph_stats', `${stats.nodeCount} nodes / ${stats.edgeCount} edges / ${stats.clusterCount ?? '?'} clusters`);

    const search = parseToolJson(await client.callTool({ name: 'kb_query', arguments: { query: 'mcp server' } }));
    assert.ok(search.count > 0, 'expected kb_query to find nodes about the mcp server');
    log('kb_query', `top hit: ${search.results[0].id} (score ${search.results[0].score})`);

    const node = parseToolJson(await client.callTool({ name: 'kb_get_node', arguments: { id: search.results[0].id } }));
    assert.equal(node.id, search.results[0].id);
    log('kb_get_node', `${node.id} — "${node.title}"`);

    const ask = parseToolJson(await client.callTool({ name: 'kb_ask', arguments: { question: 'What does the mcp server do?' } }));
    assert.equal(ask.usedSampling, true, 'expected kb_ask to use sampling');
    assert.ok(ask.answer && ask.answer.length > 0, 'expected a non-empty answer');
    assert.ok(ask.citations.length > 0, 'expected citations');
    assert.equal(samplingCalls, 1, 'expected exactly one sampling round-trip');
    log('kb_ask', `usedSampling=${ask.usedSampling}, ${ask.citations.length} citations, model=${ask.model}`);

    process.stdout.write('\nSMOKE PASSED ✅\n');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAILED ❌\n${err?.stack ?? err}\n`);
  process.exit(1);
});
