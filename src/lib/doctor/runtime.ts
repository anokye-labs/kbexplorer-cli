import { spawnSync } from 'node:child_process';

import { loadRuntimeConfig, resolveRuntime, RUNTIME_ENV } from '../runtime-config.ts';
import { isAdapterAvailable, resolveBinary } from '../copilot-runtime.ts';

function pass(id, message) { return { id, status: 'pass', message }; }
function warn(id, message) { return { id, status: 'warn', message }; }
function fail(id, message) { return { id, status: 'fail', message }; }

function resolveRuntimeSource(flag, config, env) {
  if (flag != null && flag !== '') {
    return { source: `--runtime flag (${flag})`, adapterName: flag };
  }
  if (config != null) {
    return { source: `.kbx.json runtime block (agent: "${config.agent}")`, adapterName: config.agent };
  }
  const envVal = env[RUNTIME_ENV];
  if (envVal != null && envVal !== '') {
    return { source: `${RUNTIME_ENV} env var (${envVal})`, adapterName: envVal };
  }
  return { source: 'default', adapterName: 'copilot' };
}

function captureVersion(binary, { spawnSync: spawnSyncImpl = spawnSync } = {}) {
  try {
    const res = spawnSyncImpl(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error || res.status == null) return null;
    const text = (res.stdout || res.stderr || '').trim();
    const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    return line.slice(0, 80) || null;
  } catch {
    return null;
  }
}

export function checkRuntime({ flag, config, env, spawnSync: spawnSyncImpl = spawnSync }) {
  const checks = [];

  let adapter;
  try {
    adapter = resolveRuntime({ flag, config, env });
  } catch (err) {
    checks.push(fail('runtime.resolve', `Failed to resolve runtime adapter: ${err.message}`));
    return { checks, adapter: null, config };
  }

  const { source, adapterName } = resolveRuntimeSource(flag, config, env);
  checks.push(pass('runtime.selected', `Adapter: ${adapterName} (source: ${source})`));

  const envMap = env ?? process.env;
  const binaryEnvVar = adapter.binaryEnv;
  const binary = resolveBinary({
    env: envMap,
    envVar: binaryEnvVar,
    defaultBinary: adapter.defaultBinary || adapter.name,
  });
  const overrideNote = binaryEnvVar && envMap[binaryEnvVar]
    ? ` (overridden via ${binaryEnvVar}=${envMap[binaryEnvVar]})`
    : '';
  checks.push(pass('runtime.binary', `Binary: ${binary}${overrideNote}`));

  const available = isAdapterAvailable(adapter, { env: envMap, spawnSync: spawnSyncImpl });
  if (available) {
    const version = captureVersion(binary, { spawnSync: spawnSyncImpl });
    checks.push(pass('runtime.available', `Binary available${version ? `: ${version}` : ''}`));
  } else if (adapterName === 'custom') {
    checks.push(warn('runtime.available', `Custom adapter binary "${binary}" not found on PATH — ensure it is installed`));
  } else {
    const installUrl = adapter.installUrl ?? null;
    checks.push(
      fail(
        'runtime.available',
        `Binary "${binary}" not found on PATH` + (installUrl ? ` — install from ${installUrl}` : ''),
      ),
    );
  }

  if (adapterName === 'custom') {
    checks.push(warn('runtime.custom', 'Custom adapter selected — MCP server detection is not possible'));
  }

  return { checks, adapter, config };
}

export { loadRuntimeConfig };
