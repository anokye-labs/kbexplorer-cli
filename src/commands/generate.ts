/**
 * kbx generate — run the content-generation pipeline.
 *
 * Two phases, both driven through the {@link module:lib/runtime-router}:
 *   1. fuzzy   — when there is no `catalogue.json` (or `--refresh`), invoke
 *                Copilot programmatic mode (`copilot -p`) to analyze the repo
 *                and emit `catalogue.json` (kb-architect agent / playbook).
 *   2. deterministic — transform the catalogue into content/ and regenerate the
 *                manifest (pure computation, unchanged behavior).
 *
 * The agentless placeholder is gone: fuzzy work now runs through the F7 runtime
 * adapter. Deterministic steps are preserved exactly.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { getAppRoot } from '../lib/detect-repo.ts';
import { transformCatalogue } from '../lib/transform.ts';
import { parseGenerateArgs } from '../lib/args.ts';
import { routeTask } from '../lib/runtime-router.ts';
import {
  runRuntimeTask,
  isAdapterAvailable,
  resolveBinary,
  titleCase,
  RuntimeAdapterError,
  RuntimeErrorCode,
} from '../lib/copilot-runtime.ts';
import {
  loadRuntimeConfig,
  resolveRuntime,
  applyRuntimeConfigDefaults,
  RuntimeConfigError,
} from '../lib/runtime-config.ts';
import {
  runMcpPreflight,
  formatMcpPreflightErrors,
} from '../lib/mcp-config-preflight.ts';

const CATALOGUE_FILE = 'catalogue.json';

/**
 * Default prompt for the fuzzy architect step. Drives the installed kb-architect
 * agent (or its playbook) to produce a catalogue at the repo root.
 */
export function defaultArchitectPrompt() {
  return [
    'Analyze this repository and produce a kbx catalogue.',
    'Prefer the kb-architect agent in .github/agents/; if agents are unavailable,',
    'follow .github/skills/kbx/references/architect-playbook.md.',
    `Write the result as ${CATALOGUE_FILE} at the repository root.`,
    'It MUST be valid JSON shaped as { "title", "subtitle", "clusters", "nodes" },',
    'where each node has { id, title, cluster, connections } and clusters map id → { name }.',
    'Do not modify any other files.',
  ].join(' ');
}

function printHelp() {
  console.log(`
  kbx generate — run the content generation pipeline

  Usage: kbx generate [options]

  When no catalogue.json exists (or with --refresh), generate drives Copilot
  programmatic mode (copilot -p) to analyze the repo and emit catalogue.json,
  then deterministically transforms it into content/ and regenerates the manifest.

  Options:
    -p, --prompt <text>   Override the architect prompt sent to copilot
        --model <model>   Model to use (copilot --model)
        --allow-tool <s>  Scoped tool permission, repeatable (e.g. 'shell(git)').
                          Providing any scoped tool disables implicit --allow-all-tools.
        --allow-all-tools Allow all tools without confirmation (default for the agent step)
        --timeout <ms>    Time budget for the programmatic run (default 600000)
        --no-agent        Skip the fuzzy step; only transform an existing catalogue
        --refresh,--force Re-run the agent even if catalogue.json already exists
        --dry-run         Print the assembled agent command and exit (no run)
        --runtime <name>  Override runtime adapter: "copilot" | "claude" | "custom"
                          (precedence: flag > .kbx.json > KBX_RUNTIME > default)
        --skip-preflight  Skip MCP preflight check (development escape hatch)
    -h, --help            Show this help
`);
}

/**
 * Build the runtime options for the fuzzy architect step from parsed CLI args.
 * Scoped --allow-tool flags take precedence over implicit --allow-all-tools.
 */
export function buildArchitectRuntimeOptions(opts, cwd) {
  const useScoped = opts.allowTools && opts.allowTools.length > 0;
  return {
    prompt: opts.prompt || defaultArchitectPrompt(),
    cwd,
    allowTools: useScoped ? opts.allowTools : [],
    // Default the trusted local-analysis flow to allow-all-tools (non-interactive
    // mode needs auto-approval). An explicit scoped allowlist opts out.
    allowAllTools: useScoped ? false : opts.allowAllTools !== false,
    model: opts.model || undefined,
    timeoutMs: opts.timeout || undefined,
    silent: true,
    noColor: true,
  };
}

export default async function generate(args = []) {
  const opts = parseGenerateArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);
  const cataloguePath = resolve(cwd, CATALOGUE_FILE);
  const haveCatalogue = existsSync(cataloguePath);

  // ── Resolve runtime adapter (precedence: --runtime flag > .kbx.json > env > default) ──
  let runtimeConfig;
  let runtimeAdapter;
  try {
    runtimeConfig = loadRuntimeConfig(cwd);
    runtimeAdapter = resolveRuntime({ flag: opts.runtime, config: runtimeConfig });
  } catch (err) {
    if (err instanceof RuntimeConfigError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  // CLI --timeout wins; config timeoutMs fills the gap.
  const runtimeOptions = applyRuntimeConfigDefaults(buildArchitectRuntimeOptions(opts, cwd), runtimeConfig);

  // ── Dry run: show exactly what would be invoked, then stop. ──
  if (opts.dryRun) {
    const binary = resolveBinary({ envVar: runtimeAdapter.binaryEnv, defaultBinary: runtimeAdapter.defaultBinary });
    const argv = runtimeAdapter.buildArgs(runtimeOptions);
    console.log(`Dry run — would invoke ${titleCase(runtimeAdapter.name)} programmatic mode:`);
    console.log(`  ${binary} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return;
  }

  const wantAgent = !opts.noAgent && (!haveCatalogue || opts.refresh);

  // ── MCP preflight: verify required servers are configured before any LLM call ──
  // Only runs when the runtime config declares an `mcp` block and a fuzzy phase will run.
  // Skipped for --no-agent (no LLM), --dry-run (no LLM).
  if (wantAgent && runtimeConfig?.mcp) {
    if (opts.skipPreflight) {
      console.warn('⚠ --skip-preflight: skipping MCP server verification (development mode).');
    } else {
      const preflight = runMcpPreflight({ adapter: runtimeAdapter, config: runtimeConfig, cwd });
      for (const w of preflight.warnings) {
        console.warn(`⚠ ${w}`);
      }
      if (!preflight.ok) {
        const lines = formatMcpPreflightErrors(preflight.missing, runtimeAdapter.name, cwd);
        for (const line of lines) {
          console.error(line);
        }
        process.exit(1);
      }
    }
  }

  // ── Phase 1 (fuzzy): drive the configured agent to produce catalogue.json ──
  if (wantAgent) {
    if (!isAdapterAvailable(runtimeAdapter)) {
      console.error(`✗ ${titleCase(runtimeAdapter.name)} CLI not found on PATH.`);
      if (runtimeAdapter.installUrl) {
        console.error(`  Install it: ${runtimeAdapter.installUrl}`);
      }
      if (runtimeAdapter.binaryEnv) {
        console.error(`  Or set ${runtimeAdapter.binaryEnv} to its full path.`);
      }
      if (!haveCatalogue) {
        console.error('  Alternatively, produce catalogue.json another way and re-run with --no-agent.');
        process.exit(1);
      }
      console.warn('⚠ Continuing with the existing catalogue.json (deterministic transform only).');
    } else {
      console.log(`🤖 Running ${titleCase(runtimeAdapter.name)} programmatic mode (architect)...`);
      try {
        const { result } = await routeTask(
          { name: 'architect', kind: 'fuzzy', prompt: runtimeOptions.prompt, ...runtimeOptions },
          { logger: console, runFuzzy: (task) => runRuntimeTask({ adapter: runtimeAdapter, ...task }) },
        );
        if (result.response) {
          console.log(result.response.trim());
        }
      } catch (err) {
        if (err instanceof RuntimeAdapterError) {
          console.error(`✗ ${titleCase(runtimeAdapter.name)} run failed (${err.code}): ${err.message}`);
          if (err.code === RuntimeErrorCode.BINARY_MISSING && !haveCatalogue) {
            process.exit(1);
          }
          if (!existsSync(cataloguePath)) {
            console.error('  No catalogue.json was produced — aborting.');
            process.exit(1);
          }
          console.warn('⚠ Falling back to the existing catalogue.json.');
        } else {
          throw err;
        }
      }
    }
  }

  // ── Phase 2 (deterministic): transform catalogue → content ──
  if (existsSync(cataloguePath)) {
    await routeTask(
      {
        name: 'transform-catalogue',
        kind: 'deterministic',
        run: () => {
          console.log(`📋 Transforming ${CATALOGUE_FILE} → content/...`);
          const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf-8'));
          return transformCatalogue(catalogue, resolve(cwd, 'content'));
        },
      },
      { logger: console },
    );
  } else {
    console.log('No catalogue.json found and no agent step ran.');
    console.log('');
    console.log('Run `kbx generate` (drives Copilot programmatic mode) to create one,');
    console.log('or produce catalogue.json yourself and run `kbx generate --no-agent`.');
    process.exit(0);
  }

  // ── Phase 2b (deterministic): regenerate manifest ──
  if (appRoot) {
    await routeTask(
      {
        name: 'regenerate-manifest',
        kind: 'deterministic',
        run: () => {
          const manifestScript = resolve(appRoot, 'scripts', 'generate-manifest.js');
          if (existsSync(manifestScript)) {
            console.log('📋 Regenerating manifest...');
            // Use spawnSync (not execSync) so a non-zero exit is logged, not thrown.
            // This prevents the template script failing (e.g. missing node_modules in
            // a vendored install) from crashing the whole generate pipeline.
            const r = spawnSync('node', [manifestScript], {
              cwd: appRoot,
              stdio: 'inherit',
              env: { ...process.env, VITE_KB_LOCAL: 'true', VITE_KB_HOST_ROOT: cwd },
            });
            if (r.status !== 0) {
              console.warn(`⚠ Manifest script exited ${r.status} — manifest may be stale. Run kbx manifest separately.`);
            }
          }
        },
      },
      { logger: console },
    );
  }

  console.log('\n✅ Content generated. Run `npx kbx dev` to preview.');
}


