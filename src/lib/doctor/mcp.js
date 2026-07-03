import { detectConfiguredMcpServers } from '../mcp-config-preflight.js';
import { runMcpServerPreflight } from '../../mcp/server-preflight.js';

function pass(id, message) { return { id, status: 'pass', message }; }
function warn(id, message) { return { id, status: 'warn', message }; }
function fail(id, message) { return { id, status: 'fail', message }; }

export function checkMcp({ adapter, config, cwd, env }) {
  const checks = [];

  const provider = runMcpServerPreflight({});
  if (provider.ok) {
    checks.push(pass('mcp.server', `kbx mcp server available (${provider.toolCount} affordance tools)`));
  } else {
    checks.push(warn('mcp.server', `kbx mcp server not ready: ${provider.errors.join('; ')}`));
  }

  const mcp = config?.mcp;
  if (!mcp || (!mcp.required?.length && !mcp.optional?.length)) {
    checks.push(pass('mcp.declared', 'No MCP servers declared in runtime config'));
    return checks;
  }

  const required = mcp.required ?? [];
  const optional = mcp.optional ?? [];

  if (!adapter) {
    checks.push(warn('mcp.skipped', 'MCP check skipped (runtime adapter not resolved)'));
    return checks;
  }

  const { servers, sources, undetectable } = detectConfiguredMcpServers(adapter, cwd, { env });
  if (undetectable) {
    for (const server of required) {
      checks.push(warn(`mcp.required.${server}`, `Required server "${server}": unverifiable for custom adapter`));
    }
    for (const server of optional) {
      checks.push(warn(`mcp.optional.${server}`, `Optional server "${server}": unverifiable for custom adapter`));
    }
    return checks;
  }

  const sourceNote = sources.length > 0 ? ` (from ${sources.join(', ')})` : '';

  for (const server of required) {
    if (servers.has(server)) {
      checks.push(pass(`mcp.required.${server}`, `Required server "${server}": configured${sourceNote}`));
    } else {
      checks.push(fail(`mcp.required.${server}`, `Required server "${server}": NOT configured for ${adapter.name}`));
    }
  }

  for (const server of optional) {
    if (servers.has(server)) {
      checks.push(pass(`mcp.optional.${server}`, `Optional server "${server}": configured${sourceNote}`));
    } else {
      checks.push(warn(`mcp.optional.${server}`, `Optional server "${server}": not configured (non-fatal)`));
    }
  }

  return checks;
}
