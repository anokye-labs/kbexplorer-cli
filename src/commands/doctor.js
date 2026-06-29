/**
 * kbx doctor — diagnose local runtime, MCP, template setup, and adoption readiness.
 *
 * Sections:
 *   1. Runtime   — which adapter is selected and why, binary path, availability, version.
 *   2. MCP       — per-server check for each required/optional server in the config.
 *   3. Template  — .kbx.json source record, .gitmodules agreement, pinned ref vs latest tag.
 *   4. Adoption readiness — structured content visibility, local/remote parity, template capabilities.
 *   5. Environment — node version, git/gh on PATH, content dir, manifest freshness.
 *
 * Output: human-readable with ✅/⚠️/❌ per check, grouped by section.
 *         --json emits a machine-readable document.
 * Exit code: 0 when all checks pass or are warnings; non-zero when any check fails.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig, resolveRuntime, RUNTIME_ENV } from '../lib/runtime-config.js';
import { detectConfiguredMcpServers } from '../lib/mcp-preflight.js';
import { readSourceRecord, SOURCE_FILE, classifyRef } from '../lib/source.js';
import { isAdapterAvailable, resolveBinary } from '../lib/copilot-runtime.js';
import { getSubmoduleUrl, getAppRoot } from '../lib/detect-repo.js';
import { manifestOutPath } from './dev.js';
import { parseDoctorArgs } from '../lib/args.js';
import { loadKbEnv } from '../lib/frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Status symbols ────────────────────────────────────────────────────────────

const PASS = '✅';
const WARN = '⚠️ ';
const FAIL = '❌';

const STATUS = { pass: PASS, warn: WARN, fail: FAIL };

const DEFAULT_STRUCTURED_CONTENT_PATH = 'content-model';
const STRUCTURED_CONTENT_ENV = 'VITE_KB_CONTENT_MODEL';
const ADOPTION_DOC = 'docs/deploy-to-a-work-repo.md#3-author-the-work-graph-yaml';
const TEMPLATE_ISSUES = [
  'anokye-labs/kbexplorer-template#416',
  'anokye-labs/kbexplorer-template#265',
  'anokye-labs/kbexplorer-template#417',
  'anokye-labs/kbexplorer-template#418',
];
const COMMON_STRUCTURED_CONTENT_PATHS = [
  'content-model',
  'content-models',
  'content_model',
  'structured-content',
  'structured_content',
  'work-graph',
  'workgraph',
  'content/model',
];
const STRUCTURED_INGESTION_CAPABILITIES = [
  'structured-content',
  'structured-content-ingestion',
  'structured-content-rendering',
  'content-model',
  'content-model-ingestion',
  'remote-content-model-ingestion',
  'contentModel',
  'contentModelIngestion',
  'structuredContent',
  'structuredContentIngestion',
];
const CONFIGURABLE_STRUCTURED_PATH_CAPABILITIES = [
  'structured-content-path',
  'structured-content-config',
  'configurable-structured-content-path',
  'content-model-path',
  'configurable-content-model-path',
  'contentModelPath',
  'structuredContentPath',
];

// ── Build check objects ───────────────────────────────────────────────────────

function pass(id, message) { return { id, status: 'pass', message }; }
function warn(id, message) { return { id, status: 'warn', message }; }
function fail(id, message) { return { id, status: 'fail', message }; }

// ── Runtime section ───────────────────────────────────────────────────────────

/**
 * Determine the human-readable source of the adapter selection.
 *
 * @param {string|null} flag
 * @param {object|null} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ source: string, adapterName: string }}
 */
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

/**
 * Try to capture the binary version via `<binary> --version`.
 *
 * @param {string} binary
 * @param {object} [opts]
 * @param {Function} [opts.spawnSync]
 * @returns {string|null}
 */
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
    // First non-empty line, limited to 80 chars
    const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    return line.slice(0, 80) || null;
  } catch {
    return null;
  }
}

/**
 * Build checks for the Runtime section.
 *
 * @param {object} opts
 * @param {string|null} opts.flag         --runtime flag value
 * @param {object|null} opts.config       validated runtime config
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {Function} [opts.spawnSync]
 * @returns {{ checks: object[], adapter: object, config: object|null }}
 */
function checkRuntime({ flag, config, env, spawnSync: spawnSyncImpl = spawnSync }) {
  const checks = [];

  // Resolve the adapter
  let adapter;
  try {
    adapter = resolveRuntime({ flag, config, env });
  } catch (err) {
    checks.push(fail('runtime.resolve', `Failed to resolve runtime adapter: ${err.message}`));
    return { checks, adapter: null, config };
  }

  const { source, adapterName } = resolveRuntimeSource(flag, config, env);
  checks.push(pass('runtime.selected', `Adapter: ${adapterName} (source: ${source})`));

  // Binary path
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

  // Availability + version
  const available = isAdapterAvailable(adapter, { env: envMap, spawnSync: spawnSyncImpl });
  if (available) {
    const version = captureVersion(binary, { spawnSync: spawnSyncImpl });
    checks.push(
      pass('runtime.available', `Binary available${version ? `: ${version}` : ''}`),
    );
  } else if (adapterName === 'custom') {
    checks.push(
      warn('runtime.available', `Custom adapter binary "${binary}" not found on PATH — ensure it is installed`),
    );
  } else {
    const installUrl = adapter.installUrl ?? null;
    checks.push(
      fail(
        'runtime.available',
        `Binary "${binary}" not found on PATH` +
          (installUrl ? ` — install from ${installUrl}` : ''),
      ),
    );
  }

  // Custom adapter: MCP unverifiable notice
  if (adapterName === 'custom') {
    checks.push(
      warn('runtime.custom', 'Custom adapter selected — MCP server detection is not possible'),
    );
  }

  return { checks, adapter, config };
}

// ── MCP section ───────────────────────────────────────────────────────────────

/**
 * Build checks for the MCP section.
 *
 * @param {object} opts
 * @param {object|null} opts.adapter
 * @param {object|null} opts.config
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @returns {object[]} checks
 */
function checkMcp({ adapter, config, cwd, env }) {
  const checks = [];
  const mcp = config?.mcp;

  if (!mcp || (!mcp.required?.length && !mcp.optional?.length)) {
    checks.push(pass('mcp.declared', 'No MCP servers declared in runtime config'));
    return checks;
  }

  const required = mcp.required ?? [];
  const optional = mcp.optional ?? [];

  if (!adapter) {
    // Runtime resolution failed — can't check MCP
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

  const sourceNote = sources.length > 0
    ? ` (from ${sources.join(', ')})`
    : '';

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

// ── Template section ──────────────────────────────────────────────────────────

/**
 * Build checks for the Template section.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {boolean} opts.offline         Skip network-dependent checks
 * @param {Function} [opts.getLatestTag] Injected for tests (avoids network)
 * @returns {object[]} checks
 */
function checkTemplate({ cwd, offline, getLatestTag: getLatestTagImpl }) {
  const checks = [];

  const sourceFilePath = resolve(cwd, SOURCE_FILE);
  if (!existsSync(sourceFilePath)) {
    checks.push(warn('template.source-record', `${SOURCE_FILE} not found — run kbx init to create it`));
    return checks;
  }

  const record = readSourceRecord(cwd);
  if (!record) {
    checks.push(fail('template.source-record', `${SOURCE_FILE} exists but could not be parsed`));
    return checks;
  }

  checks.push(pass('template.source-record', `${SOURCE_FILE} present (mode: ${record.mode ?? 'unknown'}, template: ${record.template ?? 'unknown'})`));

  // Check .gitmodules agreement when mode is submodule
  if (record.mode === 'submodule') {
    const gmUrl = getSubmoduleUrl(cwd);
    if (!gmUrl) {
      checks.push(warn('template.gitmodules', '.gitmodules not found or does not contain a .kbx entry'));
    } else if (record.template && gmUrl !== record.template) {
      checks.push(
        warn(
          'template.gitmodules',
          `.gitmodules url (${gmUrl}) differs from ${SOURCE_FILE} template (${record.template}) — reconcile to avoid updating from the wrong remote`,
        ),
      );
    } else {
      checks.push(pass('template.gitmodules', `.gitmodules url agrees with ${SOURCE_FILE}`));
    }
  }

  // Pinned ref vs latest tag
  const refType = record.refType || classifyRef(record.ref);
  if (refType === 'tag') {
    checks.push(pass('template.ref', `Template pinned to tag: ${record.ref}`));
    // Optionally check latest tag if not offline
    if (!offline && getLatestTagImpl && record.template) {
      try {
        const latest = getLatestTagImpl(record.template);
        if (latest && latest !== record.ref) {
          checks.push(
            warn('template.latest', `A newer release tag exists: ${record.ref} → ${latest} (run kbx update)`),
          );
        } else if (latest) {
          checks.push(pass('template.latest', `Template is on the latest release tag (${latest})`));
        }
      } catch {
        checks.push(warn('template.latest', 'Could not fetch latest tag from remote (network unavailable?)'));
      }
    } else if (offline) {
      checks.push(warn('template.latest', 'Latest tag check skipped (--offline)'));
    }
  } else if (refType === 'branch') {
    checks.push(
      warn('template.ref', `Template tracks branch "${record.ref}" — consider pinning to a release tag for reproducibility`),
    );
  } else {
    // release tracking (ref is null, tracking latest)
    checks.push(pass('template.ref', 'Template tracking latest release'));
    if (!offline && getLatestTagImpl && record.template) {
      try {
        const latest = getLatestTagImpl(record.template);
        if (latest) {
          checks.push(pass('template.latest', `Latest release tag: ${latest}`));
        } else {
          checks.push(warn('template.latest', 'Could not determine latest release tag'));
        }
      } catch {
        checks.push(warn('template.latest', 'Could not fetch latest tag from remote (network unavailable?)'));
      }
    } else if (offline) {
      checks.push(warn('template.latest', 'Latest tag check skipped (--offline)'));
    }
  }

  return checks;
}

// ── Adoption readiness section ────────────────────────────────────────────────

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathSetting(value) {
  if (typeof value !== 'string') return null;
  let out = value.trim();
  if (!out) return null;
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  out = out.replace(/[\\/]+$/, '');
  return out || null;
}

function formatPathForMessage(value) {
  const normalized = normalizePathSetting(value) ?? value;
  return String(normalized).replace(/\\/g, '/') + '/';
}

function resolveStructuredContentPath({ record, env, envFile }) {
  const candidates = [
    { value: record?.structuredContent?.path, source: `${SOURCE_FILE} structuredContent.path`, sourceKind: 'config' },
    { value: record?.structuredContentPath, source: `${SOURCE_FILE} structuredContentPath`, sourceKind: 'config' },
    { value: record?.structuredContentDir, source: `${SOURCE_FILE} structuredContentDir`, sourceKind: 'config' },
    { value: record?.contentModel?.path, source: `${SOURCE_FILE} contentModel.path`, sourceKind: 'config' },
    { value: record?.contentModelPath, source: `${SOURCE_FILE} contentModelPath`, sourceKind: 'config' },
    { value: record?.contentModelDir, source: `${SOURCE_FILE} contentModelDir`, sourceKind: 'config' },
    { value: env?.[STRUCTURED_CONTENT_ENV], source: `${STRUCTURED_CONTENT_ENV} env var`, sourceKind: 'env' },
    { value: envFile?.[STRUCTURED_CONTENT_ENV], source: `.env.kbx ${STRUCTURED_CONTENT_ENV}`, sourceKind: 'env-file' },
  ];

  for (const candidate of candidates) {
    const path = normalizePathSetting(candidate.value);
    if (path) return { path, source: candidate.source, sourceKind: candidate.sourceKind };
  }

  return {
    path: DEFAULT_STRUCTURED_CONTENT_PATH,
    source: 'default convention',
    sourceKind: 'default',
  };
}

function structuredContentRequired(record) {
  const candidates = [
    record?.structuredContent?.required,
    record?.contentModel?.required,
    record?.adoption?.structuredContentRequired,
    record?.adoption?.structuredContent?.required,
  ];
  return candidates.some((value) => value === true || String(value).toLowerCase() === 'true');
}

function summarizeFiles(rootDir, extensions) {
  const summary = {
    exists: existsSync(rootDir),
    count: 0,
    errors: [],
  };
  if (!summary.exists) return summary;

  const stack = [rootDir];
  const extSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      summary.errors.push(`${dir}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (extSet.has(lower.slice(lower.lastIndexOf('.')))) {
        summary.count += 1;
      }
    }
  }

  return summary;
}

function findStructuredContentCandidates(cwd, selectedPath) {
  const selected = normalizePathSetting(selectedPath);
  const results = [];
  for (const candidatePath of COMMON_STRUCTURED_CONTENT_PATHS) {
    if (candidatePath === selected) continue;
    const summary = summarizeFiles(resolve(cwd, candidatePath), ['.yaml', '.yml']);
    if (summary.count > 0) {
      results.push({ path: candidatePath, count: summary.count });
    }
  }
  return results;
}

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstObjectCandidate(candidates) {
  for (const candidate of candidates) {
    if (isObject(candidate.value)) {
      return { value: candidate.value, source: candidate.source };
    }
  }
  return null;
}

function normalizeCapabilityList(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
  }
  if (typeof raw === 'string') {
    return raw.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (isObject(raw)) {
    return Object.entries(raw)
      .filter(([, value]) => value === true || value === 'true' || value === 1)
      .map(([key]) => key);
  }
  return [];
}

function normalizeCapabilityName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasAnyCapability(capabilities, aliases) {
  const available = new Set(capabilities.map(normalizeCapabilityName));
  return aliases.some((alias) => available.has(normalizeCapabilityName(alias)));
}

function parseSemver(value) {
  const match = String(value ?? '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1, 4).map((n) => Number.parseInt(n, 10));
}

function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] < bv[i]) return -1;
    if (av[i] > bv[i]) return 1;
  }
  return 0;
}

function readCliVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readTemplateCompatibility(appRoot) {
  if (!appRoot) return { installed: false, metadata: null, metadataSource: null, capabilities: [] };

  const pkgPath = resolve(appRoot, 'package.json');
  const pkg = readJsonIfPresent(pkgPath);
  const sidecar = readJsonIfPresent(resolve(appRoot, 'kbx-template.json'))
    ?? readJsonIfPresent(resolve(appRoot, '.kbx-template.json'));
  const candidate = firstObjectCandidate([
    { value: sidecar, source: 'kbx-template.json' },
    { value: pkg?.kbx, source: 'package.json kbx' },
    { value: pkg?.kbexplorer, source: 'package.json kbexplorer' },
    { value: pkg?.kbExplorer, source: 'package.json kbExplorer' },
    { value: pkg?.kbexplorerTemplate, source: 'package.json kbexplorerTemplate' },
  ]);
  const metadata = candidate?.value ?? null;
  const rawCapabilities = metadata?.capabilities
    ?? metadata?.templateCapabilities
    ?? metadata?.features
    ?? pkg?.kbxCapabilities;

  return {
    installed: true,
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    manifestScript: existsSync(resolve(appRoot, 'scripts', 'generate-manifest.js')),
    metadata,
    metadataSource: candidate?.source ?? null,
    capabilities: normalizeCapabilityList(rawCapabilities),
    protocolVersion: metadata?.protocolVersion ?? metadata?.templateProtocolVersion ?? metadata?.protocol ?? null,
    minCliVersion: metadata?.minCliVersion ?? metadata?.cli?.minVersion ?? metadata?.requires?.kbxCli ?? null,
    maxCliVersion: metadata?.maxCliVersion ?? metadata?.cli?.maxVersion ?? null,
  };
}

function pushOptional(checks, required, id, message) {
  checks.push(required ? fail(id, message) : warn(id, message));
}

/**
 * Build checks for the Adoption readiness section.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @returns {object[]} checks
 */
function checkAdoption({ cwd, env }) {
  const checks = [];
  const record = readSourceRecord(cwd);
  const required = structuredContentRequired(record);
  let envFile = {};

  try {
    envFile = loadKbEnv(cwd);
  } catch (err) {
    checks.push(warn('adoption.env-file', `.env.kbx could not be parsed: ${err.message}`));
  }

  const pathInfo = resolveStructuredContentPath({ record, env, envFile });
  const structuredRoot = isAbsolute(pathInfo.path) ? pathInfo.path : resolve(cwd, pathInfo.path);
  const structuredSummary = summarizeFiles(structuredRoot, ['.yaml', '.yml']);
  const descriptorLabel = structuredSummary.count === 1 ? 'descriptor' : 'descriptors';

  if (structuredSummary.exists && structuredSummary.count > 0) {
    checks.push(pass(
      'adoption.structured-path',
      `Structured-content path: ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}); ${structuredSummary.count} YAML ${descriptorLabel} found`,
    ));
  } else if (structuredSummary.exists) {
    pushOptional(
      checks,
      required,
      'adoption.structured-path',
      `Structured-content path exists at ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}) but contains no .yaml/.yml descriptors`,
    );
  } else {
    pushOptional(
      checks,
      required,
      'adoption.structured-path',
      `No structured-content directory found at ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}) — add ${DEFAULT_STRUCTURED_CONTENT_PATH}/ or configure structuredContent.path when template support lands; see ${ADOPTION_DOC}`,
    );
  }

  if (structuredSummary.errors.length > 0) {
    pushOptional(
      checks,
      required,
      'adoption.structured-read',
      `Could not read all structured-content files under ${formatPathForMessage(pathInfo.path)}: ${structuredSummary.errors.slice(0, 2).join('; ')}`,
    );
  }

  const alternates = !structuredSummary.exists
    ? findStructuredContentCandidates(cwd, pathInfo.path)
    : [];
  for (const candidate of alternates.slice(0, 3)) {
    checks.push(warn(
      `adoption.structured-candidate.${candidate.path.replace(/[^a-z0-9]+/gi, '-')}`,
      `Found possible structured content at ${formatPathForMessage(candidate.path)} (${candidate.count} YAML descriptors), but doctor/build currently look at ${formatPathForMessage(pathInfo.path)}`,
    ));
  }

  if (pathInfo.sourceKind === 'env' || pathInfo.sourceKind === 'env-file') {
    checks.push(warn(
      'adoption.path-parity',
      `Structured-content path comes from ${pathInfo.source}; set the same value in CI/hosting or move it into committed ${SOURCE_FILE} config once template #416 lands`,
    ));
  } else if (isAbsolute(pathInfo.path)) {
    checks.push(warn(
      'adoption.path-parity',
      `Structured-content path is absolute (${pathInfo.path}); remote builds usually need a repo-relative path`,
    ));
  } else {
    checks.push(pass(
      'adoption.path-parity',
      `Structured-content path is repo-relative (${formatPathForMessage(pathInfo.path)}), so local and remote builds can use the same layout`,
    ));
  }

  const derivedSummary = summarizeFiles(resolve(cwd, 'content', 'derived'), ['.jsonld']);
  if (derivedSummary.count > 0) {
    checks.push(pass(
      'adoption.derived-jsonld',
      `Derived JSON-LD artifacts: ${derivedSummary.count} file${derivedSummary.count === 1 ? '' : 's'} in content/derived/`,
    ));
  }

  const appRoot = getAppRoot(cwd);
  const compatibility = readTemplateCompatibility(appRoot);
  const hasStructuredInput = structuredSummary.count > 0 || derivedSummary.count > 0 || alternates.length > 0;
  const advertisesStructured = hasAnyCapability(compatibility.capabilities, STRUCTURED_INGESTION_CAPABILITIES);
  const advertisesConfigurablePath = hasAnyCapability(
    compatibility.capabilities,
    CONFIGURABLE_STRUCTURED_PATH_CAPABILITIES,
  );

  if (!compatibility.installed) {
    checks.push(warn('adoption.template-installed', 'Template app is not installed at .kbx/ — run kbx init before verifying local rendering'));
  } else {
    checks.push(pass(
      'adoption.template-installed',
      `Template app installed${compatibility.packageName ? ` (${compatibility.packageName}${compatibility.packageVersion ? `@${compatibility.packageVersion}` : ''})` : ''}`,
    ));
    if (!compatibility.manifestScript) {
      checks.push(warn(
        'adoption.template-manifest',
        'Template manifest script is missing; CLI fallback manifests do not advertise structured-content ingestion',
      ));
    }
  }

  if (!compatibility.metadata) {
    checks.push(warn(
      'adoption.template-capabilities',
      `Template compatibility/capabilities are not advertised yet — cannot confirm content-model ingestion, diagram rendering, or edge semantics (${TEMPLATE_ISSUES.join(', ')})`,
    ));
  } else if (compatibility.capabilities.length === 0) {
    checks.push(warn(
      'adoption.template-capabilities',
      `Template metadata is present (${compatibility.metadataSource}) but no capabilities are advertised yet`,
    ));
  } else {
    checks.push(pass(
      'adoption.template-capabilities',
      `Template capabilities advertised (${compatibility.metadataSource}): ${compatibility.capabilities.join(', ')}`,
    ));
  }

  const cliVersion = readCliVersion();
  if (compatibility.protocolVersion) {
    checks.push(pass('adoption.template-protocol', `Template protocol version: ${compatibility.protocolVersion}`));
  }
  if (cliVersion && compatibility.minCliVersion) {
    const cmp = compareSemver(cliVersion, compatibility.minCliVersion);
    if (cmp != null && cmp < 0) {
      checks.push(warn(
        'adoption.cli-version',
        `CLI ${cliVersion} is older than template minimum ${compatibility.minCliVersion}; update @anokye-labs/kbx`,
      ));
    } else {
      checks.push(pass('adoption.cli-version', `CLI ${cliVersion} satisfies template minimum ${compatibility.minCliVersion}`));
    }
  }
  if (cliVersion && compatibility.maxCliVersion) {
    const cmp = compareSemver(cliVersion, compatibility.maxCliVersion);
    if (cmp != null && cmp > 0) {
      checks.push(warn(
        'adoption.cli-version-max',
        `CLI ${cliVersion} is newer than template maximum ${compatibility.maxCliVersion}; run kbx update or pin compatible versions`,
      ));
    }
  }

  if (hasStructuredInput && !compatibility.installed) {
    checks.push(warn(
      'adoption.visibility',
      'Structured content appears present, but local rendering cannot be checked until .kbx/ is installed',
    ));
  } else if (hasStructuredInput && !advertisesStructured) {
    checks.push(warn(
      'adoption.visibility',
      'Structured content appears present, but the installed template does not advertise structured-content ingestion; local/remote builds may omit those nodes',
    ));
  } else if (hasStructuredInput) {
    checks.push(pass('adoption.visibility', 'Structured-content ingestion is advertised by the installed template'));
  }

  if (
    hasStructuredInput &&
    pathInfo.path !== DEFAULT_STRUCTURED_CONTENT_PATH &&
    !advertisesConfigurablePath
  ) {
    checks.push(warn(
      'adoption.configurable-path',
      `Structured content uses ${formatPathForMessage(pathInfo.path)}, but the template does not advertise configurable-path support yet (track anokye-labs/kbexplorer-template#416)`,
    ));
  }

  checks.push(pass(
    'adoption.guidance',
    `Adoption runbook: ${ADOPTION_DOC}; related template issues: ${TEMPLATE_ISSUES.join(', ')}`,
  ));

  return checks;
}

// ── Environment section ───────────────────────────────────────────────────────

/**
 * Build checks for the Environment section.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {Function} [opts.spawnSync]
 * @returns {object[]} checks
 */
function checkEnvironment({ cwd, env, spawnSync: spawnSyncImpl = spawnSync }) {
  const checks = [];

  // Node version
  const nodeVersion = process.version;
  // Read engines.node from package.json if available
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const enginesNode = pkg?.engines?.node;
    if (enginesNode) {
      // Simple check: parse the minimum version from >=X requirement
      const minMatch = enginesNode.match(/>=?\s*(\d+)/);
      const minMajor = minMatch ? parseInt(minMatch[1], 10) : null;
      const curMajor = parseInt(nodeVersion.replace('v', ''), 10);
      if (minMajor && curMajor < minMajor) {
        checks.push(fail('env.node', `Node ${nodeVersion} is below required ${enginesNode}`));
      } else {
        checks.push(pass('env.node', `Node ${nodeVersion} (requires ${enginesNode})`));
      }
    } else {
      checks.push(pass('env.node', `Node ${nodeVersion}`));
    }
  } catch {
    checks.push(pass('env.node', `Node ${nodeVersion}`));
  }

  // git on PATH
  const gitAvailable = probeTool('git', ['--version'], spawnSyncImpl);
  if (gitAvailable.available) {
    checks.push(pass('env.git', `git available${gitAvailable.version ? `: ${gitAvailable.version}` : ''}`));
  } else {
    checks.push(fail('env.git', 'git not found on PATH'));
  }

  // gh on PATH
  const ghAvailable = probeTool('gh', ['--version'], spawnSyncImpl);
  if (ghAvailable.available) {
    checks.push(pass('env.gh', `gh (GitHub CLI) available${ghAvailable.version ? `: ${ghAvailable.version}` : ''}`));
  } else {
    checks.push(warn('env.gh', 'gh (GitHub CLI) not found on PATH — needed for some workflows'));
  }

  // Content dir present
  const contentDir = resolve(cwd, 'content');
  if (existsSync(contentDir)) {
    checks.push(pass('env.content-dir', `content/ directory present`));
  } else {
    checks.push(warn('env.content-dir', `content/ directory not found at ${contentDir}`));
  }

  // Manifest freshness: the generated manifest lives in the template app at
  // <appRoot>/src/generated/repo-manifest.json (see manifestOutPath in dev.js).
  const appRoot = getAppRoot(cwd);
  const manifestPath = appRoot ? manifestOutPath(appRoot) : null;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const generatedAt = manifest?.generatedAt;
      if (!generatedAt) {
        checks.push(warn('env.manifest', 'repo-manifest.json present but has no generatedAt field'));
      } else {
        // Try to get the HEAD commit timestamp
        const headTime = getHeadCommitTime(cwd, spawnSyncImpl);
        if (headTime && generatedAt) {
          const generatedMs = new Date(generatedAt).getTime();
          const headMs = headTime;
          // If manifest is older than HEAD by more than 5 min, warn
          if (headMs - generatedMs > 5 * 60 * 1000) {
            checks.push(
              warn('env.manifest', `repo-manifest.json may be stale (generated ${generatedAt}, HEAD is newer)`),
            );
          } else {
            checks.push(pass('env.manifest', `repo-manifest.json up to date (generated ${generatedAt})`));
          }
        } else {
          checks.push(pass('env.manifest', `repo-manifest.json present (generated ${generatedAt})`));
        }
      }
    } catch {
      checks.push(warn('env.manifest', 'repo-manifest.json present but could not be parsed'));
    }
  }
  // If manifest doesn't exist, no check needed (not an error — user may not have run generate yet)

  return checks;
}

/**
 * Probe a tool binary and optionally capture version.
 */
function probeTool(binary, args, spawnSyncImpl) {
  try {
    const res = spawnSyncImpl(binary, args, {
      encoding: 'utf-8',
      timeout: 5000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error || res.status == null) return { available: false };
    const text = (res.stdout || res.stderr || '').trim();
    const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    return { available: true, version: line.slice(0, 80) || null };
  } catch {
    return { available: false };
  }
}

/**
 * Get the HEAD commit timestamp in ms (for manifest staleness check).
 */
function getHeadCommitTime(cwd, spawnSyncImpl) {
  try {
    const res = spawnSyncImpl('git', ['log', '-1', '--format=%ci'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error || res.status !== 0) return null;
    const dateStr = (res.stdout || '').trim();
    if (!dateStr) return null;
    const t = new Date(dateStr).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// ── Output formatting ─────────────────────────────────────────────────────────

/**
 * Render a single check line for human output.
 */
function formatCheckLine(check) {
  const icon = STATUS[check.status] ?? '  ';
  return `  ${icon} ${check.message}`;
}

/**
 * Render the full human-readable report.
 */
function formatHumanReport(sections) {
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

/**
 * Build the JSON document.
 */
function buildJsonReport(sections) {
  const hasFailure = sections.some((s) => s.checks.some((c) => c.status === 'fail'));
  return {
    sections: sections.map((s) => ({
      name: s.name,
      checks: s.checks,
    })),
    ok: !hasFailure,
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export default async function doctor(args, {
  cwd: cwdOverride,
  env: envOverride,
  spawnSync: spawnSyncImpl = spawnSync,
  getLatestTag: getLatestTagImpl = null,
  offline: offlineOverride = undefined,
} = {}) {
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

  // Load runtime config (best-effort; errors become fail checks)
  let runtimeConfig = null;
  let configError = null;
  try {
    runtimeConfig = loadRuntimeConfig(cwd);
  } catch (err) {
    configError = err;
  }

  // ── Resolve getLatestTag (injectable seam, falls back to real impl unless offline) ──
  let latestTagFn = getLatestTagImpl;
  if (!latestTagFn && !offline) {
    // Lazy import to avoid top-level import for tests that inject a fake
    const { getLatestTag } = await import('../lib/version.js');
    latestTagFn = getLatestTag;
  }

  // ── Run sections ──────────────────────────────────────────────────────────
  const { checks: runtimeChecks, adapter } = checkRuntime({
    flag: runtimeFlag,
    config: runtimeConfig,
    env,
    spawnSync: spawnSyncImpl,
  });

  // If config had a load error, inject it as a fail check at the start
  if (configError) {
    runtimeChecks.unshift(fail('runtime.config', `Failed to load runtime config: ${configError.message}`));
  }

  const mcpChecks = checkMcp({ adapter, config: runtimeConfig, cwd, env });

  const templateChecks = checkTemplate({ cwd, offline, getLatestTag: latestTagFn });

  const adoptionChecks = checkAdoption({ cwd, env });

  const envChecks = checkEnvironment({ cwd, env, spawnSync: spawnSyncImpl });

  const sections = [
    { name: 'Runtime', checks: runtimeChecks },
    { name: 'MCP', checks: mcpChecks },
    { name: 'Template', checks: templateChecks },
    { name: 'Adoption readiness', checks: adoptionChecks },
    { name: 'Environment', checks: envChecks },
  ];

  // ── Output ────────────────────────────────────────────────────────────────
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

  // Exit non-zero if any check is "fail"
  if (!report.ok) {
    process.exitCode = 1;
  }
}

// Export section runners for testing
export { checkRuntime, checkMcp, checkTemplate, checkAdoption, checkEnvironment };
