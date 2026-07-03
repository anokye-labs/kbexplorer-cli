/**
 * Test helpers for pointing a runtime adapter at the MCP twins hermetically.
 *
 * These write the adapter-specific MCP config files that `mcp-config-preflight.js`
 * reads (`<cwd>/.mcp.json`, `~/.claude.json`, `~/.copilot/mcp-config.json`),
 * declaring the `ado` and `sharepoint-docs` twins so the preflight sees them as
 * configured. Each writer returns the absolute path it wrote, and produces an
 * `mcpServers` entry that actually launches the corresponding twin via
 * `node twins/mcp/<server>.js` — so the same config a test asserts on is a config
 * that would really start the twin.
 *
 * @module twins/mcp/lib/config-helpers
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `twins/mcp/`. */
export const TWINS_MCP_DIR = join(__dirname, '..');

/** Canonical twin server names, keyed to their entrypoint files. */
export const TWIN_SERVERS = Object.freeze({
  ado: join(TWINS_MCP_DIR, 'ado-server.js'),
  'sharepoint-docs': join(TWINS_MCP_DIR, 'sharepoint-docs-server.js'),
});

/**
 * Build an `mcpServers` map declaring the named twins as stdio servers launched
 * via `node twins/mcp/<server>.js`.
 *
 * @param {string[]} [names]  Twin names to include (defaults to all twins).
 * @returns {Record<string, { command: string, args: string[] }>}
 */
export function buildTwinServerMap(names = Object.keys(TWIN_SERVERS)) {
  const map = {};
  for (const name of names) {
    const entry = TWIN_SERVERS[name];
    if (!entry) throw new Error(`Unknown MCP twin: ${name}`);
    map[name] = { command: process.execPath, args: [entry] };
  }
  return map;
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Write a Claude repo-local `.mcp.json` declaring the twins.
 *
 * @param {string} cwd        Repo root (temp dir in tests).
 * @param {string[]} [names]  Twin names to declare.
 * @returns {string} Absolute path written.
 */
export function writeClaudeRepoConfig(cwd, names) {
  const filePath = join(cwd, '.mcp.json');
  writeJson(filePath, { mcpServers: buildTwinServerMap(names) });
  return filePath;
}

/**
 * Write a Claude user-level `~/.claude.json` declaring the twins under the given
 * project path (matches how `claude mcp add --scope project` records them).
 *
 * @param {string} home       Home dir (temp dir in tests; maps to HOME/USERPROFILE).
 * @param {string} cwd        Project path the servers are scoped to.
 * @param {string[]} [names]  Twin names to declare.
 * @returns {string} Absolute path written.
 */
export function writeClaudeUserConfig(home, cwd, names) {
  const filePath = join(home, '.claude.json');
  writeJson(filePath, {
    projects: { [cwd]: { mcpServers: buildTwinServerMap(names) } },
  });
  return filePath;
}

/**
 * Write a Copilot `~/.copilot/mcp-config.json` declaring the twins.
 *
 * @param {string} home       Home dir (temp dir in tests; maps to HOME/USERPROFILE).
 * @param {string[]} [names]  Twin names to declare.
 * @returns {string} Absolute path written.
 */
export function writeCopilotConfig(home, names) {
  const filePath = join(home, '.copilot', 'mcp-config.json');
  writeJson(filePath, { mcpServers: buildTwinServerMap(names) });
  return filePath;
}
