/**
 * MCP preflight checker for kbx.
 *
 * Before any fuzzy (LLM) phase runs, this module verifies that MCP servers
 * declared in the `runtime.mcp` config block are actually configured for the
 * active adapter. Detection is filesystem-only — no process spawning.
 *
 * Detection locations by adapter:
 *
 *   claude:
 *     1. <cwd>/.mcp.json              — repo-local Claude Code MCP config
 *        Reads the top-level "mcpServers" object; keys are server names.
 *     2. ~/.claude.json               — user-level Claude Code config
 *        Reads "projects[*].mcpServers" for entries matching the current
 *        working directory path. This is the format written by
 *        `claude mcp add --scope project`.
 *
 *   copilot:
 *     ~/.copilot/mcp-config.json       — Copilot CLI's MCP config (the file
 *        `copilot` actually reads; verified against a live install). Reads the
 *        top-level "mcpServers" object; keys are server names. A "servers" key
 *        is accepted as a fallback for schema drift. Copilot CLI has no
 *        repo-local MCP config file today, so none is checked.
 *
 *   custom:
 *     Detection is not possible — the CLI has no knowledge of how a custom
 *     adapter resolves MCP servers. All declared servers are reported as
 *     unverifiable (a warning, not a failure).
 *
 * Failure messages are actionable: they name the missing server, the file
 * the adapter expects it in, and a one-line example entry.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Internal helpers ─────────────────────────────────────────────────────────

function tryReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Return the set of configured MCP server names from Claude's config files.
 *
 * @param {string} cwd  Repo root directory.
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]  Process env (for HOME override in tests).
 * @returns {{ servers: Set<string>, sources: string[] }}
 */
function detectClaudeServers(cwd, { env } = {}) {
  const servers = new Set();
  const sources = [];

  // 1. Repo-local .mcp.json
  const repoMcpPath = join(cwd, '.mcp.json');
  const repoMcp = tryReadJson(repoMcpPath);
  if (repoMcp && typeof repoMcp.mcpServers === 'object' && repoMcp.mcpServers !== null && !Array.isArray(repoMcp.mcpServers)) {
    for (const key of Object.keys(repoMcp.mcpServers)) {
      servers.add(key);
    }
    sources.push(repoMcpPath);
  }

  // 2. User-level ~/.claude.json
  const home = (env && (env.HOME || env.USERPROFILE)) || homedir();
  const userClaudeJsonPath = join(home, '.claude.json');
  const userClaude = tryReadJson(userClaudeJsonPath);
  if (userClaude && typeof userClaude.projects === 'object' && userClaude.projects !== null) {
    const projects = userClaude.projects;
    // projects is an object keyed by absolute path
    for (const [projectPath, projectData] of Object.entries(projects)) {
      const normalizedProject = resolve(projectPath);
      const normalizedCwd = resolve(cwd);
      if (normalizedProject === normalizedCwd) {
        if (
          projectData &&
          typeof projectData.mcpServers === 'object' &&
          projectData.mcpServers !== null &&
          !Array.isArray(projectData.mcpServers)
        ) {
          for (const key of Object.keys(projectData.mcpServers)) {
            servers.add(key);
          }
          if (!sources.includes(userClaudeJsonPath)) {
            sources.push(userClaudeJsonPath);
          }
        }
      }
    }
  }

  return { servers, sources };
}

/**
 * Return the set of configured MCP server names from Copilot's config files.
 *
 * @param {string} cwd  Repo root directory.
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]  Process env (for HOME override in tests).
 * @returns {{ servers: Set<string>, sources: string[] }}
 */
function detectCopilotServers(cwd, { env } = {}) {
  const servers = new Set();
  const sources = [];

  // Copilot CLI reads ~/.copilot/mcp-config.json (top-level "mcpServers",
  // verified against a live install). It has no repo-local MCP config file
  // today. Accept a "servers" key as a fallback for schema drift.
  const home = (env && (env.HOME || env.USERPROFILE)) || homedir();
  const userMcpPath = join(home, '.copilot', 'mcp-config.json');
  const userMcp = tryReadJson(userMcpPath);
  const serverMap = pickServerMap(userMcp);
  if (serverMap) {
    for (const key of Object.keys(serverMap)) {
      servers.add(key);
    }
    sources.push(userMcpPath);
  }

  return { servers, sources };
}

/** Return the first of obj.mcpServers / obj.servers that is a plain object. */
function pickServerMap(obj) {
  for (const key of ['mcpServers', 'servers']) {
    const value = obj?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect which MCP servers are configured for the given adapter, using only
 * filesystem reads (no process spawning).
 *
 * For `custom` adapters, detection is not possible — returns an empty Set with
 * `undetectable: true` to signal that all declared servers are unverifiable.
 *
 * @param {object} adapter       A runtime adapter (with a `.name` property).
 * @param {string} cwd           Repo root directory.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Env override (used for HOME resolution in tests).
 * @returns {{ servers: Set<string>, sources: string[], undetectable: boolean }}
 */
export function detectConfiguredMcpServers(adapter, cwd, { env } = {}) {
  const name = String(adapter?.name ?? '').toLowerCase();

  if (name === 'claude') {
    const { servers, sources } = detectClaudeServers(cwd, { env });
    return { servers, sources, undetectable: false };
  }

  if (name === 'copilot') {
    const { servers, sources } = detectCopilotServers(cwd, { env });
    return { servers, sources, undetectable: false };
  }

  // Custom (or unknown) adapter: detection not possible
  return { servers: new Set(), sources: [], undetectable: true };
}

/**
 * Run the MCP preflight check.
 *
 * @param {object} opts
 * @param {object}   opts.adapter   Runtime adapter instance.
 * @param {object}   opts.config    Validated runtime config block (from validateRuntimeBlock).
 * @param {string}   opts.cwd       Repo root directory.
 * @param {NodeJS.ProcessEnv} [opts.env]  Env override.
 * @returns {{ ok: boolean, missing: string[], unverifiable: string[], warnings: string[] }}
 */
export function runMcpPreflight({ adapter, config, cwd, env } = {}) {
  const mcp = config?.mcp;

  // No MCP requirements declared → nothing to check.
  if (!mcp) {
    return { ok: true, missing: [], unverifiable: [], warnings: [] };
  }

  const required = mcp.required ?? [];
  const optional = mcp.optional ?? [];
  const allDeclared = [...required, ...optional];

  if (allDeclared.length === 0) {
    return { ok: true, missing: [], unverifiable: [], warnings: [] };
  }

  const { servers, sources, undetectable } = detectConfiguredMcpServers(adapter, cwd, { env });
  const adapterName = String(adapter?.name ?? 'unknown');

  // Custom adapters: all declared servers are unverifiable
  if (undetectable) {
    const warnings = allDeclared.map(
      (s) =>
        `MCP server "${s}" cannot be verified for custom adapter "${adapterName}" — ` +
        `ensure it is configured before running fuzzy tasks.`,
    );
    return { ok: true, missing: [], unverifiable: allDeclared, warnings };
  }

  const missing = [];
  const warnings = [];
  const unverifiable = [];

  const configFiles = _expectedConfigFiles(adapterName, cwd, env);

  for (const server of required) {
    if (!servers.has(server)) {
      missing.push(server);
    }
  }

  for (const server of optional) {
    if (!servers.has(server)) {
      warnings.push(
        `Optional MCP server "${server}" is not configured for ${adapterName}. ` +
          `Add it to ${configFiles.primary} to enable it.`,
      );
    }
  }

  const ok = missing.length === 0;

  return { ok, missing, unverifiable, warnings };
}

/**
 * Format actionable error messages for missing required MCP servers.
 *
 * @param {string[]} missing       Missing required server names.
 * @param {string}   adapterName   Active adapter name.
 * @param {string}   cwd           Repo root.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}  Lines to print to stderr.
 */
export function formatMcpPreflightErrors(missing, adapterName, cwd, env) {
  if (missing.length === 0) return [];

  const files = _expectedConfigFiles(adapterName, cwd, env);
  const lines = [
    `✗ MCP preflight failed: ${missing.length} required server(s) not configured for ${adapterName}.`,
  ];

  for (const server of missing) {
    lines.push(`  Missing: "${server}"`);
    lines.push(`  Expected in: ${files.primary}`);
    lines.push(`  Example entry:`);
    lines.push(`    { "mcpServers": { "${server}": { "command": "npx", "args": ["-y", "${server}-mcp"] } } }`);
  }

  lines.push(`  Run with --skip-preflight to bypass this check (development only).`);
  return lines;
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Return the primary and secondary config file paths for actionable messages.
 *
 * @param {string} adapterName
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ primary: string, secondary: string }}
 */
function _expectedConfigFiles(adapterName, cwd, env) {
  const home = (env && (env.HOME || env.USERPROFILE)) || homedir();
  if (adapterName === 'claude') {
    return {
      primary: join(cwd, '.mcp.json'),
      secondary: join(home, '.claude.json'),
    };
  }
  if (adapterName === 'copilot') {
    const userConfig = join(home, '.copilot', 'mcp-config.json');
    return {
      primary: userConfig,
      secondary: userConfig,
    };
  }
  return {
    primary: '<adapter-config-file>',
    secondary: '<adapter-config-file>',
  };
}

