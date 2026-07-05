import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadKbEnv } from '../lib/kb-env.ts';

const REPL_COMMANDS = ['ls', 'show', 'go', 'back', 'related', 'tree', 'view', 'pack', 'search', 'emit', 'help', 'quit', 'exit'];
const DEFAULT_BUDGET = 600;

function printHelp() {
  console.log(`
  kbx explore — Terminal explorer that hosts the real engine graph

  Usage:
    kbx explore [path|--manifest file|--repo owner/name]
    kbx explore <command> [args]
    kbx explore <source> <command> [args]

  Commands:
    ls [cluster|type]      List clusters or node types
    show <id>              Show a node
    go <id>                Set the current node anchor
    back                   Restore the previous anchor
    related                Show related nodes for the current anchor
    tree <id>              Show an ASCII tree around a node
    view <name>            Show a named projection (current|neighbors|related|subgraph)
    pack <id> [--budget N] Emit a compact llm-context representation
    search <query>         Search via kbexplorer-search artifacts when .search/ exists
    emit json|json-ld      Emit graph or JSON-LD representations

  Options:
    --manifest <file>      Load a prebuilt manifest snapshot
    --repo <owner/name>    Load the live GitHub repository graph
    --json                 Emit machine-readable JSON
    --budget <n>           Character budget for pack output
    -h, --help             Show this help
  `);
}

function parseExploreArgs(args = []) {
  const out = {
    help: false,
    json: false,
    manifest: null,
    repo: null,
    budget: null,
    source: null,
    command: null,
    positionals: [],
    unknown: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--manifest') {
      out.manifest = args[++i] ?? null;
      continue;
    }
    if (arg === '--repo') {
      out.repo = args[++i] ?? null;
      continue;
    }
    if (arg === '--budget') {
      const budget = Number(args[++i]);
      out.budget = Number.isFinite(budget) ? budget : null;
      continue;
    }
    if (arg.startsWith('--budget=')) {
      const value = arg.slice('--budget='.length);
      const budget = Number(value);
      out.budget = Number.isFinite(budget) ? budget : null;
      continue;
    }
    if (arg.startsWith('-')) {
      out.unknown.push(arg);
      continue;
    }
    if (!out.command && REPL_COMMANDS.includes(arg)) {
      out.command = arg;
      continue;
    }
    if (!out.source) {
      out.source = arg;
      continue;
    }
    out.positionals.push(arg);
  }

  return out;
}

function getEngineBanner() {
  const require = createRequire(import.meta.url);
  const engineEntry = require.resolve('@anokye-labs/kbexplorer-engine');
  const pkgPath = resolve(dirname(engineEntry), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return { name: '@anokye-labs/kbexplorer-engine', version: pkg.version ?? 'unknown' };
}

async function loadEngineApi() {
  const [engineMod, sourcesMod] = await Promise.all([
    import('@anokye-labs/kbexplorer-engine'),
    import('@anokye-labs/kbexplorer-engine/sources'),
  ]);
  return { engine: engineMod, sources: sourcesMod };
}

function formatNode(node) {
  return {
    id: node.id,
    title: node.title,
    cluster: node.cluster,
    nodeType: node.nodeType ?? node.entityType ?? node.kind ?? null,
    layer: node.layer ?? null,
    identity: node.identity ?? null,
    source: node.source ?? null,
    content: node.content ?? null,
  };
}

function formatGraphSummary(graph, currentNodeId) {
  return {
    engine: getEngineBanner(),
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    clusterCount: graph.clusters.length,
    currentNodeId,
  };
}

function createJsonOutput(payload) {
  return JSON.stringify(payload, null, 2);
}

function writeOutput(payload, opts) {
  if (opts.json) {
    console.log(createJsonOutput(payload));
    return;
  }
  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }
  if (payload && typeof payload === 'object' && payload.text) {
    console.log(payload.text);
    return;
  }
  console.log(payload);
}

function trimToBudget(text, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return text;
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 3))}...`;
}

function buildTree(graph, rootId, engine, maxDepth = 4) {
  const root = engine.getNode(graph, rootId);
  if (!root) return { id: rootId, label: rootId, children: [] };
  const children = [];
  for (const edge of graph.edges) {
    if (edge.from !== rootId) continue;
    const target = engine.getNode(graph, edge.to);
    if (!target) continue;
    const edgeType = edge.type ?? 'related';
    if (!['contains', 'reports_to', 'reports-to', 'depends_on', 'depends-on'].includes(edgeType)) continue;
    children.push({ id: target.id, label: target.title || target.id, children: [], edgeType });
  }
  return { id: root.id, label: root.title || root.id, children };
}

function renderTree(node, prefix = '', isLast = true) {
  const lines = [];
  const connector = isLast ? '└─' : '├─';
  lines.push(`${prefix}${connector} ${node.label}`);
  const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    lines.push(...renderTree(child, childPrefix, i === node.children.length - 1));
  }
  return lines;
}

function buildProjection(graph, currentNodeId, kind, engine) {
  const node = engine.getNode(graph, currentNodeId);
  if (!node) return { kind, nodes: [], edges: [] };
  if (kind === 'current') {
    const projection = engine.subgraph(graph, currentNodeId, { radius: 1 });
    return { kind, nodes: projection.nodes.map(formatNode), edges: projection.edges };
  }
  if (kind === 'neighbors') {
    const nodes = engine.neighbors(graph, currentNodeId).map(formatNode);
    return { kind, nodes, edges: [] };
  }
  if (kind === 'related') {
    const nodes = engine.related(graph, currentNodeId).map(formatNode);
    return { kind, nodes, edges: [] };
  }
  if (kind === 'subgraph') {
    const projection = engine.subgraph(graph, currentNodeId, { radius: 2 });
    return { kind, nodes: projection.nodes.map(formatNode), edges: projection.edges };
  }
  return { kind, nodes: [], edges: [] };
}

function collectClusters(graph) {
  return graph.clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name ?? cluster.id,
    nodeCount: graph.nodes.filter((node) => node.cluster === cluster.id).length,
  }));
}

function collectTypes(graph) {
  const counts = new Map();
  for (const node of graph.nodes) {
    const key = node.nodeType ?? node.entityType ?? node.kind ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

function discoverSourceInput(cwd, sourceArg) {
  if (!sourceArg) return { mode: 'cwd', cwd };
  const resolved = resolve(cwd, sourceArg);
  if (!existsSync(resolved)) {
    return { mode: 'cwd', cwd };
  }
  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    const rootConfigPath = resolve(resolved, 'config.yaml');
    const nestedContentConfigPath = resolve(resolved, 'content', 'config.yaml');
    const nestedContentDir = resolve(resolved, 'content');
    if (existsSync(rootConfigPath)) {
      return { mode: 'repo', cwd: resolved };
    }
    if (existsSync(nestedContentConfigPath)) {
      return { mode: 'repo', cwd: resolved, contentOverride: 'content' };
    }
    if (existsSync(nestedContentDir)) {
      return { mode: 'content-dir', cwd: resolved, contentOverride: 'content' };
    }
    if (basename(resolved) === 'content') {
      return { mode: 'content-dir', cwd: dirname(resolved), contentOverride: basename(resolved) };
    }
    return { mode: 'content-dir', cwd: resolved, contentOverride: basename(resolved) };
  }
  return { mode: 'file', cwd: dirname(resolved), file: resolved };
}

function readManifest(manifestPath, cwd) {
  const absolute = resolve(cwd, manifestPath);
  if (!existsSync(absolute)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

async function resolveGraph(opts, cwd) {
  const env = loadKbEnv(cwd);
  const localConfigPath = opts.source ? discoverSourceInput(cwd, opts.source) : { mode: 'cwd', cwd };
  const contentOverride = localConfigPath.contentOverride ?? env.VITE_KB_PATH ?? null;
  const { engine, sources } = await loadEngineApi();
  const { DEFAULT_CONFIG, loadKnowledgeBase } = engine;

  if (opts.manifest) {
    const manifest = readManifest(opts.manifest, cwd);
    const config = DEFAULT_CONFIG;
    const source = new sources.ManifestSource(manifest, config);
    return { graph: await loadKnowledgeBase(config, { source }), config, sourceLabel: `manifest:${opts.manifest}` };
  }

  if (opts.repo) {
    const [owner, repo] = opts.repo.split('/');
    if (!owner || !repo) {
      throw new Error('--repo expects owner/name');
    }
    const config = DEFAULT_CONFIG;
    const sourceConfig = {
      owner,
      repo,
      path: (config.source && config.source.path) || 'content',
      branch: (config.source && config.source.branch) || 'main',
    };
    const source = new sources.GitHubApiSource(sourceConfig);
    return { graph: await loadKnowledgeBase(config, { source }), config, sourceLabel: `repo:${opts.repo}` };
  }

  if (localConfigPath.mode === 'content-dir' || localConfigPath.mode === 'repo') {
    const targetDir = localConfigPath.cwd;
    const targetContentOverride = localConfigPath.contentOverride ?? contentOverride ?? 'content';
    const source = new sources.FileSystemSource(targetDir, { contentPath: targetContentOverride });
    const graph = await loadKnowledgeBase(DEFAULT_CONFIG, { source });
    return { graph, config: null, sourceLabel: `local:${targetDir}` };
  }

  const source = new sources.FileSystemSource(cwd, { contentPath: contentOverride ?? 'content' });
  const graph = await loadKnowledgeBase(DEFAULT_CONFIG, { source });
  return { graph, config: null, sourceLabel: `local:${cwd}` };
}

async function executeCommand(graph, state, command, args, opts, engine) {
  const currentNodeId = state.currentNodeId;
  const targetId = args[0] ?? currentNodeId;

  if (!command || command === 'help') {
    return { text: 'Use one of: ls, show, go, back, related, tree, view, pack, search, emit, quit' };
  }

  if (command === 'ls') {
    if (args[0] === 'cluster' || args[0] === 'clusters') {
      return { clusters: collectClusters(graph) };
    }
    if (args[0] === 'type' || args[0] === 'types') {
      return { types: collectTypes(graph) };
    }
    return { clusters: collectClusters(graph), types: collectTypes(graph), currentNodeId };
  }

  if (command === 'show') {
    const node = engine.getNode(graph, targetId) ?? engine.getNode(graph, currentNodeId);
    if (!node) {
      throw new Error(`Unknown node: ${targetId}`);
    }
    return { node: formatNode(node), neighbors: engine.neighbors(graph, node.id).map(formatNode), related: engine.related(graph, node.id).map(formatNode) };
  }

  if (command === 'go') {
    const node = engine.getNode(graph, targetId);
    if (!node) {
      throw new Error(`Unknown node: ${targetId}`);
    }
    state.history.push(state.currentNodeId);
    state.currentNodeId = node.id;
    return { currentNodeId: state.currentNodeId, node: formatNode(node) };
  }

  if (command === 'back') {
    const previous = state.history.pop();
    if (!previous) {
      return { currentNodeId: state.currentNodeId, note: 'No previous anchor' };
    }
    state.currentNodeId = previous;
    return { currentNodeId: state.currentNodeId };
  }

  if (command === 'related') {
    const node = engine.getNode(graph, currentNodeId);
    if (!node) {
      throw new Error(`Unknown current node: ${currentNodeId}`);
    }
    return { currentNodeId, related: engine.related(graph, node.id).map(formatNode) };
  }

  if (command === 'tree') {
    const rootId = targetId ?? currentNodeId;
    const tree = buildTree(graph, rootId, engine);
    const rendered = renderTree(tree).join('\n');
    return { rootId, text: rendered || rootId };
  }

  if (command === 'view') {
    const viewName = args[0] ?? 'current';
    return buildProjection(graph, currentNodeId, viewName, engine);
  }

  if (command === 'pack') {
    const node = engine.getNode(graph, targetId) ?? engine.getNode(graph, currentNodeId);
    if (!node) {
      throw new Error(`Unknown node: ${targetId}`);
    }
    const budget = opts.budget ?? DEFAULT_BUDGET;
    const neighborsList = engine.neighbors(graph, node.id).slice(0, 5).map((item) => item.title || item.id);
    const relatedList = engine.related(graph, node.id).slice(0, 5).map((item) => item.title || item.id);
    const text = [
      `# ${node.id}`,
      `title: ${node.title ?? 'untitled'}`,
      `cluster: ${node.cluster ?? 'unknown'}`,
      `type: ${node.nodeType ?? node.entityType ?? 'unknown'}`,
      `neighbors: ${neighborsList.join(', ') || 'none'}`,
      `related: ${relatedList.join(', ') || 'none'}`,
    ].join('\n');
    return { node: formatNode(node), text: trimToBudget(text, budget) };
  }

  if (command === 'search') {
    const query = args.join(' ').trim();
    if (!query) {
      throw new Error('search requires a query');
    }
    const artifactDir = resolve(process.cwd(), '.search');
    if (existsSync(artifactDir)) {
      try {
        const searchMod = await import('@anokye-labs/kbexplorer-search');
        const { readArtifacts, createSearchEngine, getProvider } = searchMod;
        const artifact = readArtifacts(artifactDir);
        if (artifact) {
          const provider = getProvider('openai', { model: artifact.meta?.model ?? 'text-embedding-3-small', dimensions: artifact.meta?.dimensions ?? 1536 });
          const engine = createSearchEngine(artifact, provider);
          const results = await engine.search(query, { limit: 5 });
          return { query, results };
        }
      } catch {
        // Fallback below.
      }
    }
    const matches = graph.nodes.filter((node) => `${node.title ?? ''} ${node.id ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    return { query, results: matches.slice(0, 5).map((node) => ({ id: node.id, title: node.title ?? node.id })) };
  }

  if (command === 'emit') {
    const format = args[0] ?? 'json';
    if (format === 'json-ld') {
      const nodes = graph.nodes.map((node) => ({
        '@id': node.id,
        '@type': 'Node',
        title: node.title ?? node.id,
        cluster: node.cluster ?? null,
        nodeType: node.nodeType ?? node.entityType ?? node.kind ?? null,
      }));
      return { format, nodes };
    }
    return { format, graph: { nodes: graph.nodes.map(formatNode), edges: graph.edges, clusters: graph.clusters, related: graph.related } };
  }

  return { text: `Unknown command: ${command}` };
}

export default async function explore(args = []) {
  const opts = parseExploreArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.unknown.length > 0) {
    console.error(`Unknown option(s): ${opts.unknown.join(', ')}`);
    process.exit(1);
  }

  try {
    const cwd = process.cwd();
    const { graph, sourceLabel } = await resolveGraph(opts, cwd);
    const engineBanner = getEngineBanner();
    const { engine } = await loadEngineApi();
    const state = { currentNodeId: null, history: [] };
    const firstNode = graph.nodes.find((node) => node.id === 'home') ?? graph.nodes[0];
    state.currentNodeId = firstNode?.id ?? null;

    if (!state.currentNodeId) {
      const payload = { engine: engineBanner, source: sourceLabel, message: 'The knowledge graph is empty.' };
      writeOutput(payload, opts);
      return;
    }

    if (!opts.command) {
      if (!input.isTTY && !opts.json) {
        console.error('Interactive REPL requires a TTY. Use a subcommand like `show` or `ls`.');
        process.exit(1);
      }
      if (!input.isTTY && opts.json) {
        const result = await executeCommand(graph, state, 'ls', [], opts, engine);
        const payload = {
          engine: engineBanner,
          source: sourceLabel,
          command: 'ls',
          ...result,
        };
        writeOutput(payload, opts);
        return;
      }
      const rl = createInterface({ input, output });
      console.log(`Loaded ${engineBanner.name}@${engineBanner.version} from ${sourceLabel}`);
      while (true) {
        const answer = await rl.question(`kbx explore (${state.currentNodeId})> `);
        const trimmed = answer.trim();
        if (!trimmed || trimmed === 'quit' || trimmed === 'exit') break;
        if (trimmed === 'help') {
          console.log('Commands: ls, show, go, back, related, tree, view, pack, search, emit, quit');
          continue;
        }
        const parts = trimmed.split(/\s+/);
        const command = parts[0];
        const commandArgs = parts.slice(1);
        try {
          const result = await executeCommand(graph, state, command, commandArgs, opts, engine);
          writeOutput(result, { ...opts, json: false });
        } catch (error) {
          console.error(error.message);
        }
      }
      rl.close();
      return;
    }

    const result = await executeCommand(graph, state, opts.command, opts.positionals, opts, engine);
    const payload = {
      engine: engineBanner,
      source: sourceLabel,
      command: opts.command,
      ...result,
    };
    writeOutput(payload, opts);
  } catch (error) {
    const payload = { error: error.message, engine: getEngineBanner() };
    if (opts.json) {
      console.log(createJsonOutput(payload));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}
