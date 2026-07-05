/**
 * MCP **provider** preflight (PE3-F4) — readiness of the `kbx mcp` server itself.
 *
 * There are two, orthogonal "MCP preflights" in this CLI and it is important not
 * to conflate them:
 *
 *   - {@link module:src/lib/mcp-preflight} (the existing one, #46) is the
 *     **consumer** side: before a fuzzy phase runs, it checks that the *upstream*
 *     MCP servers kbx wants to *call* are configured in the active adapter's
 *     config. It is about servers kbx consumes.
 *
 *   - **This module** is the **provider** side: before we start kbx's own MCP
 *     server (the one that *exposes* the affordances to other hosts), it checks
 *     the local environment can actually run it — Node ≥ 22 and a loadable
 *     affordance registry. It spawns nothing and touches no adapter config.
 *
 * Keeping these separate (rather than overloading `runMcpPreflight`) preserves
 * each check's single responsibility; `doctor` surfaces both.
 *
 * @module src/mcp/server-preflight
 */

import { describeAffordances } from '../affordances/index.ts';

type DescribeAffordances = typeof describeAffordances;

interface McpServerPreflightOptions {
  nodeVersion?: string;
  describe?: DescribeAffordances;
}

interface McpServerPreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  toolCount: number;
}

interface FormattableMcpServerPreflightResult {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

/** Minimum Node major the CLI (and thus the server) supports. */
export const MIN_NODE_MAJOR = 22;

/**
 * Run the provider-side readiness check for `kbx mcp`.
 *
 * @param {object} [opts]
 * @param {string} [opts.nodeVersion=process.versions.node]  Node version string.
 * @param {() => Array<object>} [opts.describe=describeAffordances]
 *        Registry catalogue seam (injected for tests).
 * @returns {{ ok: boolean, errors: string[], warnings: string[], toolCount: number }}
 */
export function runMcpServerPreflight({
  nodeVersion = process.versions.node,
  describe = describeAffordances,
}: McpServerPreflightOptions = {}): McpServerPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const major = Number.parseInt(String(nodeVersion), 10);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    errors.push(
      `Node >= ${MIN_NODE_MAJOR} is required to run the kbexplorer MCP server (found ${nodeVersion}).`
    );
  }

  let toolCount = 0;
  try {
    const catalogue = describe();
    toolCount = Array.isArray(catalogue) ? catalogue.length : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`affordance registry failed to load: ${message}`);
  }
  if (toolCount === 0 && errors.length === 0) {
    errors.push('no affordances are registered — nothing to expose over MCP.');
  }

  return { ok: errors.length === 0, errors, warnings, toolCount };
}

/**
 * Format a failed provider preflight into actionable stderr lines.
 *
 * @param {{ ok: boolean, errors: string[], warnings?: string[] }} result
 * @returns {string[]}
 */
export function formatMcpServerPreflight(result: FormattableMcpServerPreflightResult) {
  const lines: string[] = [];
  if (!result || result.ok) {
    for (const w of result?.warnings ?? []) lines.push(`  Warning: ${w}`);
    return lines;
  }
  lines.push(`✗ MCP server preflight failed: ${result.errors.length} problem(s).`);
  for (const e of result.errors) lines.push(`  - ${e}`);
  for (const w of result.warnings ?? []) lines.push(`  Warning: ${w}`);
  lines.push('  Run "kbx mcp --skip-preflight" to bypass this check (development only).');
  return lines;
}
