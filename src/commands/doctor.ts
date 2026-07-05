import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig } from '../lib/runtime-config.ts';
import { parseDoctorArgs } from '../lib/args.ts';
import { readSourceRecord, SOURCE_FILE } from '../lib/source.ts';
import { loadPluginManifest, loadExtensionDescriptor, validatePluginManifest, validateExtensionDescriptor, resolveBundle, resolveScopeRoot } from '../lib/plugin-bundle.ts';
import { checkRuntime } from '../lib/doctor/runtime.ts';
import { checkMcp } from '../lib/doctor/mcp.ts';
import { checkTemplate } from '../lib/doctor/template.ts';
import { checkAdoption } from '../lib/doctor/adoption.ts';
import { checkEnvironment } from '../lib/doctor/env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PASS = '✅';
const WARN = '⚠️ ';
const FAIL = '❌';
type DoctorStatus = 'pass' | 'warn' | 'fail';
type DoctorCheck = { id: string; status: DoctorStatus; message: string };
type DoctorSection = { name: string; checks: DoctorCheck[] };
type DoctorSourceRecord = NonNullable<ReturnType<typeof readSourceRecord>> & {
  sources?: Array<{ sourceId?: string; id?: string; module?: string }>;
  kbx?: {
    sources?: Array<{ sourceId?: string; id?: string; module?: string }>;
  };
};
type DoctorDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnSync?: typeof spawnSync;
  getLatestTag?: ((repoUrl?: string) => string | null) | null;
  offline?: boolean;
};
const STATUS: Record<DoctorStatus, string> = { pass: PASS, warn: WARN, fail: FAIL };

function pass(id: string, message: string): DoctorCheck { return { id, status: 'pass', message }; }
function warn(id: string, message: string): DoctorCheck { return { id, status: 'warn', message }; }
function fail(id: string, message: string): DoctorCheck { return { id, status: 'fail', message }; }

function checkPlugin({ assetsRoot, cwd }: { assetsRoot?: string; cwd?: string } = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const { manifest, error: mErr } = loadPluginManifest(assetsRoot);
  if (mErr) {
    checks.push(fail('plugin.manifest', `Plugin manifest unreadable: ${mErr}`));
  } else {
    const v = validatePluginManifest(manifest);
    if (v.valid) {
      const manifestRecord = manifest as { name?: string; version?: string };
      checks.push(pass('plugin.manifest', `Manifest valid (${manifestRecord.name}@${manifestRecord.version})`));
    } else {
      checks.push(fail('plugin.manifest', `Manifest invalid: ${v.errors.join('; ')}`));
    }
  }

  const { descriptor, error: dErr } = loadExtensionDescriptor(assetsRoot);
  if (dErr) {
    checks.push(fail('plugin.share', `Gist-share descriptor (copilot-extension.json) missing: ${dErr}`));
  } else {
    const v = validateExtensionDescriptor(descriptor);
    if (v.valid) {
      checks.push(pass('plugin.share', 'Gist-share descriptor (copilot-extension.json) valid'));
    } else {
      checks.push(fail('plugin.share', `Gist-share descriptor invalid: ${v.errors.join('; ')}`));
    }
  }

  const { components } = resolveBundle({ assetsRoot });
  for (const c of components) {
    if (c.id === 'manifest' || c.id === 'extension-descriptor' || c.id === 'readme') continue;
    if (c.exists) {
      checks.push(pass(`plugin.${c.id}`, `${c.label} resolves`));
    } else if (c.required) {
      checks.push(fail(`plugin.${c.id}`, `${c.label} missing (${c.source})`));
    } else {
      checks.push(warn(`plugin.${c.id}`, `${c.label} not yet bundled${c.pending ? ` (pending ${c.pending})` : ''}`));
    }
  }

  try {
    const project = resolveScopeRoot('project', { cwd: cwd ?? process.cwd() });
    checks.push(pass('plugin.scope', `Install scopes resolve (project → ${project})`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push(fail('plugin.scope', `Scope resolution failed: ${message}`));
  }

  return checks;
}

function looksLikeInstalledPackageSpecifier(spec: unknown): boolean {
  if (typeof spec !== 'string' || !spec.trim()) return true;
  const s = spec.trim();
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;
  return true;
}

function checkSources({ cwd }: { cwd: string }): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const record = readSourceRecord(cwd) as DoctorSourceRecord | null;
  const sources = record?.sources ?? record?.kbx?.sources;

  if (!Array.isArray(sources) || sources.length === 0) {
    checks.push(pass('sources.none', `No kbx.sources[] configured in ${SOURCE_FILE}`));
    return checks;
  }

  let flagged = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const id = String(source.sourceId ?? source.id ?? '(unnamed)');
    const mod = source.module;
    if (typeof mod !== 'string' || !mod.trim()) continue;
    if (!looksLikeInstalledPackageSpecifier(mod)) {
      flagged++;
      checks.push(warn(`sources.module-specifier.${id.replace(/[^a-z0-9]+/gi, '-')}`, `Source "${id}"'s module "${mod}" is a raw path/URL, not an installed package — loading it dynamic-imports and executes that code with this source's credentials. Treat config edits like dependency changes; see the README "Trust boundary" section.`));
    }
  }
  if (flagged === 0) {
    checks.push(pass('sources.module-specifiers', `All ${sources.length} declared source module(s) look like installed packages`));
  }
  return checks;
}

function formatCheckLine(check: DoctorCheck): string {
  const icon = STATUS[check.status] ?? '  ';
  return `  ${icon} ${check.message}`;
}

function formatHumanReport(sections: DoctorSection[]): string {
  const lines = [];
  for (const section of sections) {
    lines.push(`\n${section.name}`);
    lines.push('─'.repeat(section.name.length));
    for (const check of section.checks) {
      lines.push(formatCheckLine(check));
    }
  }
  return lines.join('\n');
}

function buildJsonReport(sections: DoctorSection[]): { sections: DoctorSection[]; ok: boolean } {
  const hasFailure = sections.some((s) => s.checks.some((c) => c.status === 'fail'));
  return {
    sections: sections.map((s) => ({ name: s.name, checks: s.checks })),
    ok: !hasFailure,
  };
}

export default async function doctor(args: string[] = [], {
  cwd: cwdOverride,
  env: envOverride,
  spawnSync: spawnSyncImpl = spawnSync,
  getLatestTag: getLatestTagImpl = null,
  offline: offlineOverride = undefined,
}: DoctorDeps = {}): Promise<void> {
  const opts = parseDoctorArgs(args);

  if (opts.help) {
    console.log(`
  kbx doctor — diagnose local runtime, MCP, template setup, and adoption readiness

  Usage: kbx doctor [options]

  Options:
    --runtime <name>   Check a specific adapter ("copilot" | "claude" | "custom")
    --json             Emit machine-readable JSON instead of human output
    --offline          Skip network-dependent checks (latest tag lookup)
    --help, -h         Show this help message

  Exit code:
    0   All checks pass or produce warnings only
    1   One or more checks fail
`);
    return;
  }

  const cwd = cwdOverride ?? process.cwd();
  const env = envOverride ?? process.env;
  const offline = offlineOverride ?? opts.offline;
  const jsonMode = opts.json;
  const runtimeFlag = opts.runtime;

  let runtimeConfig = null;
  let configError: unknown = null;
  try {
    runtimeConfig = loadRuntimeConfig(cwd);
  } catch (err) {
    configError = err;
  }

  let latestTagFn: DoctorDeps['getLatestTag'] = getLatestTagImpl;
  if (!latestTagFn && !offline) {
    const { getLatestTag } = await import('../lib/version.ts');
    latestTagFn = getLatestTag;
  }

  const { checks: runtimeChecks, adapter } = checkRuntime({
    flag: runtimeFlag,
    config: runtimeConfig,
    env,
    spawnSync: spawnSyncImpl,
  });

  if (configError) {
    const message = configError instanceof Error ? configError.message : String(configError);
    runtimeChecks.unshift(fail('runtime.config', `Failed to load runtime config: ${message}`));
  }

  const mcpChecks = checkMcp({ adapter, config: runtimeConfig, cwd, env });
  const templateChecks = checkTemplate({ cwd, offline, getLatestTag: latestTagFn });
  const adoptionChecks = checkAdoption({ cwd, env });
  const pluginChecks = checkPlugin({ cwd });
  const sourcesChecks = checkSources({ cwd });
  const envChecks = checkEnvironment({ cwd, env, spawnSync: spawnSyncImpl });

  const sections: DoctorSection[] = [
    { name: 'Runtime', checks: runtimeChecks },
    { name: 'MCP', checks: mcpChecks },
    { name: 'Template', checks: templateChecks },
    { name: 'Adoption readiness', checks: adoptionChecks },
    { name: 'Plugin', checks: pluginChecks },
    { name: 'Sources', checks: sourcesChecks },
    { name: 'Environment', checks: envChecks },
  ];

  const report = buildJsonReport(sections);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(sections));
    console.log('');
    if (report.ok) {
      console.log('✅ All checks passed (or warned).');
    } else {
      console.log('❌ One or more checks failed. See ❌ items above.');
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

export { checkRuntime, checkMcp, checkTemplate, checkAdoption, checkPlugin, checkSources, checkEnvironment };
