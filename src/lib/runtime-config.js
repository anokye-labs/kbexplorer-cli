/**
 * Runtime configuration loader and adapter resolver for kbexplorer.
 *
 * Loads and validates the optional `runtime` block from `.kbexplorer.json`,
 * and implements the selection precedence:
 *
 *   1. Explicit `--runtime <name>` CLI flag
 *   2. `runtime` block in `.kbexplorer.json`
 *   3. `KBEXPLORER_RUNTIME` env var
 *   4. Default: copilot
 *
 * Named adapters:  "copilot" | "claude" | "custom"
 * Binary overrides `KBEXPLORER_COPILOT_BIN` / `KBEXPLORER_CLAUDE_BIN` are
 * honoured by the adapters themselves — this module does not re-implement them.
 */

import {
  createCopilotAdapter,
  createClaudeAdapter,
  createCustomAdapter,
  copilotAdapter,
  claudeAdapter,
} from './copilot-runtime.js';
import { readSourceRecord } from './source.js';

/** Environment variable for selecting the runtime adapter by name. */
export const RUNTIME_ENV = 'KBEXPLORER_RUNTIME';

/** The known named agents. */
export const KNOWN_AGENTS = Object.freeze(['copilot', 'claude', 'custom']);

export class RuntimeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/**
 * Validate the `runtime` block from `.kbexplorer.json`.
 *
 * Accepted shape:
 * ```json
 * {
 *   "agent": "copilot" | "claude" | "custom",
 *   "command": "my-agent",              // custom only; required when agent=custom
 *   "argsTemplate": ["-p", "{prompt}"], // custom only; required when agent=custom; must contain {prompt}
 *   "outputFormat": "text" | "jsonl",   // optional; custom only
 *   "timeoutMs": 600000,                // optional
 *   "binaryEnv": "MY_AGENT_BIN"         // optional; custom only
 * }
 * ```
 *
 * @param {unknown} runtime - The raw runtime block (parsed from JSON).
 * @returns {{ agent: string, command?: string, argsTemplate?: string[], outputFormat?: string, timeoutMs?: number, binaryEnv?: string }}
 * @throws {RuntimeConfigError} on invalid shape.
 */
export function validateRuntimeBlock(runtime) {
  if (runtime == null || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new RuntimeConfigError(
      'runtime block in .kbexplorer.json must be a JSON object.',
    );
  }

  const { agent, command, argsTemplate, outputFormat, timeoutMs, binaryEnv } = runtime;

  // ── agent field ──────────────────────────────────────────────────────────────
  if (agent == null) {
    throw new RuntimeConfigError(
      'runtime.agent is required. Valid values: "copilot", "claude", "custom".',
    );
  }
  if (typeof agent !== 'string') {
    throw new RuntimeConfigError(
      `runtime.agent must be a string. Got: ${JSON.stringify(agent)}.`,
    );
  }
  const agentLower = agent.toLowerCase();
  if (!KNOWN_AGENTS.includes(agentLower)) {
    throw new RuntimeConfigError(
      `runtime.agent "${agent}" is not a known adapter. Valid values: "copilot", "claude", "custom".`,
    );
  }

  // ── custom-specific fields ───────────────────────────────────────────────────
  if (agentLower === 'custom') {
    if (!command || typeof command !== 'string') {
      throw new RuntimeConfigError(
        'runtime.command is required and must be a non-empty string when runtime.agent is "custom".',
      );
    }
    if (!argsTemplate) {
      throw new RuntimeConfigError(
        'runtime.argsTemplate is required when runtime.agent is "custom". It must be an array containing "{prompt}".',
      );
    }
    if (!Array.isArray(argsTemplate)) {
      throw new RuntimeConfigError(
        'runtime.argsTemplate must be an array of strings (e.g. ["-p", "{prompt}"]).',
      );
    }
    if (argsTemplate.length === 0) {
      throw new RuntimeConfigError(
        'runtime.argsTemplate must not be empty. It must contain "{prompt}" as a placeholder.',
      );
    }
    const serialized = argsTemplate.join(' ');
    if (!serialized.includes('{prompt}')) {
      throw new RuntimeConfigError(
        'runtime.argsTemplate must contain "{prompt}" as a placeholder for the prompt text.',
      );
    }
    for (const token of argsTemplate) {
      if (typeof token !== 'string') {
        throw new RuntimeConfigError(
          `runtime.argsTemplate entries must all be strings. Got: ${JSON.stringify(token)}.`,
        );
      }
    }
  } else {
    // Warn about fields that only apply to custom
    if (command != null) {
      throw new RuntimeConfigError(
        `runtime.command is only valid when runtime.agent is "custom" (got agent "${agent}").`,
      );
    }
    if (argsTemplate != null) {
      throw new RuntimeConfigError(
        `runtime.argsTemplate is only valid when runtime.agent is "custom" (got agent "${agent}").`,
      );
    }
  }

  // ── outputFormat (custom only — named adapters own their output parsing) ───
  if (outputFormat != null) {
    if (agentLower !== 'custom') {
      throw new RuntimeConfigError(
        `runtime.outputFormat is only valid when runtime.agent is "custom" (got agent "${agent}") — named adapters parse their own output.`,
      );
    }
    if (typeof outputFormat !== 'string' || !['text', 'jsonl'].includes(outputFormat)) {
      throw new RuntimeConfigError(
        `runtime.outputFormat must be "text" or "jsonl". Got: ${JSON.stringify(outputFormat)}.`,
      );
    }
  }

  // ── timeoutMs ───────────────────────────────────────────────────────────────
  if (timeoutMs != null) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RuntimeConfigError(
        `runtime.timeoutMs must be a positive number. Got: ${JSON.stringify(timeoutMs)}.`,
      );
    }
  }

  // ── binaryEnv ───────────────────────────────────────────────────────────────
  if (binaryEnv != null) {
    if (typeof binaryEnv !== 'string' || !binaryEnv.trim()) {
      throw new RuntimeConfigError(
        `runtime.binaryEnv must be a non-empty string. Got: ${JSON.stringify(binaryEnv)}.`,
      );
    }
    if (agentLower !== 'custom') {
      throw new RuntimeConfigError(
        `runtime.binaryEnv is only valid when runtime.agent is "custom" (got agent "${agent}").`,
      );
    }
  }

  return {
    agent: agentLower,
    ...(command != null ? { command } : {}),
    ...(argsTemplate != null ? { argsTemplate } : {}),
    ...(outputFormat != null ? { outputFormat } : {}),
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(binaryEnv != null ? { binaryEnv } : {}),
  };
}

/**
 * Load and validate the `runtime` block from `.kbexplorer.json` in `cwd`.
 * Returns `null` when the file doesn't exist or has no `runtime` block.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {{ agent: string, command?: string, argsTemplate?: string[], outputFormat?: string, timeoutMs?: number, binaryEnv?: string }|null}
 * @throws {RuntimeConfigError} if the block exists but is invalid.
 */
export function loadRuntimeConfig(cwd = process.cwd()) {
  const record = readSourceRecord(cwd);
  if (!record || record.runtime == null) return null;
  return validateRuntimeBlock(record.runtime);
}

/**
 * Build a runtime adapter from a validated config block.
 *
 * @param {{ agent: string, command?: string, argsTemplate?: string[], outputFormat?: string, timeoutMs?: number, binaryEnv?: string }} config
 * @returns {object} An adapter instance.
 */
export function adapterFromConfig(config) {
  switch (config.agent) {
    case 'copilot':
      return createCopilotAdapter();
    case 'claude':
      return createClaudeAdapter();
    case 'custom':
      return createCustomAdapter({
        name: 'custom',
        defaultBinary: config.command,
        binaryEnv: config.binaryEnv,
        argsTemplate: config.argsTemplate,
        outputFormat: config.outputFormat ?? 'text',
      });
    default:
      throw new RuntimeConfigError(`Unknown agent: "${config.agent}".`);
  }
}

/**
 * Resolve the runtime adapter using the precedence chain:
 *
 *   1. `flag`  — value of `--runtime <name>` (or null/undefined to skip)
 *   2. `config` — validated runtime block from `.kbexplorer.json` (or null to skip)
 *   3. `env`   — `KBEXPLORER_RUNTIME` env var (or process.env by default)
 *   4. default — copilotAdapter
 *
 * Named adapters (copilot / claude) reuse the singleton instances so callers
 * can use `===` to identity-check the result. Custom configs always produce a
 * fresh adapter.
 *
 * @param {object} [options]
 * @param {string|null|undefined} [options.flag]   Value of `--runtime` flag.
 * @param {object|null}           [options.config] Validated runtime block (from loadRuntimeConfig).
 * @param {NodeJS.ProcessEnv}     [options.env]    Env override (defaults to process.env).
 * @returns {object} Resolved adapter instance.
 * @throws {RuntimeConfigError} if the flag or env var specifies an unknown adapter name.
 */
export function resolveRuntime({ flag, config, env } = {}) {
  const envMap = env ?? process.env;

  // 1. Explicit --runtime flag. `--runtime custom` is a valid way to select
  // the repo's configured custom runtime — it is only an error when no
  // custom config block exists to satisfy it.
  if (flag != null && flag !== '') {
    if (String(flag).toLowerCase() === 'custom' && config?.agent === 'custom') {
      return adapterFromConfig(config);
    }
    return adapterFromName(flag, 'CLI --runtime flag');
  }

  // 2. .kbexplorer.json runtime block
  if (config != null) {
    return adapterFromConfig(config);
  }

  // 3. KBEXPLORER_RUNTIME env var (only reachable with no config block, so
  // "custom" here is always an error — there is no config to satisfy it).
  const envVal = envMap[RUNTIME_ENV];
  if (envVal != null && envVal !== '') {
    return adapterFromName(envVal, `${RUNTIME_ENV} env var`);
  }

  // 4. Default: copilot
  return copilotAdapter;
}

/**
 * Apply runtime-config defaults onto already-built runtime options.
 * CLI flags win; config fills gaps. Currently threads `timeoutMs` — a
 * validated-but-unapplied config field would otherwise be silently ignored.
 *
 * @param {object} runtimeOptions  Options built from CLI args.
 * @param {object|null} config     Validated runtime block (or null).
 * @returns {object} runtimeOptions with config-supplied defaults applied.
 */
export function applyRuntimeConfigDefaults(runtimeOptions = {}, config = null) {
  if (config?.timeoutMs != null && runtimeOptions.timeoutMs == null) {
    return { ...runtimeOptions, timeoutMs: config.timeoutMs };
  }
  return runtimeOptions;
}

/**
 * Resolve a named adapter ("copilot" | "claude" | "custom").
 * "custom" without a config block is rejected — a config is required.
 *
 * @param {string} name
 * @param {string} source  Human-readable source for error messages.
 * @returns {object}
 * @throws {RuntimeConfigError}
 */
function adapterFromName(name, source) {
  switch (String(name).toLowerCase()) {
    case 'copilot':
      return copilotAdapter;
    case 'claude':
      return claudeAdapter;
    case 'custom':
      throw new RuntimeConfigError(
        `"custom" requires a runtime block in .kbexplorer.json (${source} specified "custom" but no config was provided).`,
      );
    default:
      throw new RuntimeConfigError(
        `Unknown runtime adapter "${name}" (from ${source}). Valid values: "copilot", "claude", "custom".`,
      );
  }
}
