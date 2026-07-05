import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadKbEnv } from '../kb-env.ts';
import { readSourceRecord, SOURCE_FILE } from '../source.ts';
import { getAppRoot } from '../detect-repo.ts';
import { manifestOutPath } from '../../commands/dev.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

function pass(id, message) { return { id, status: 'pass', message }; }
function warn(id, message) { return { id, status: 'warn', message }; }
function fail(id, message) { return { id, status: 'fail', message }; }

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
  const summary = { exists: existsSync(rootDir), count: 0, errors: [] };
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
    return raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
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
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readTemplateCompatibility(appRoot) {
  if (!appRoot) return { installed: false, metadata: null, metadataSource: null, capabilities: [] };

  const pkgPath = resolve(appRoot, 'package.json');
  const pkg = readJsonIfPresent(pkgPath);
  const sidecar = readJsonIfPresent(resolve(appRoot, 'kbx-template.json')) ?? readJsonIfPresent(resolve(appRoot, '.kbx-template.json'));
  const candidate = firstObjectCandidate([
    { value: sidecar, source: 'kbx-template.json' },
    { value: pkg?.kbx, source: 'package.json kbx' },
    { value: pkg?.kbexplorer, source: 'package.json kbexplorer' },
    { value: pkg?.kbExplorer, source: 'package.json kbExplorer' },
    { value: pkg?.kbexplorerTemplate, source: 'package.json kbexplorerTemplate' },
  ]);
  const metadata = candidate?.value ?? null;
  const rawCapabilities = metadata?.capabilities ?? metadata?.templateCapabilities ?? metadata?.features ?? pkg?.kbxCapabilities;

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

export function checkAdoption({ cwd, env }) {
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
    checks.push(pass('adoption.structured-path', `Structured-content path: ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}); ${structuredSummary.count} YAML ${descriptorLabel} found`));
  } else if (structuredSummary.exists) {
    pushOptional(checks, required, 'adoption.structured-path', `Structured-content path exists at ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}) but contains no .yaml/.yml descriptors`);
  } else {
    pushOptional(checks, required, 'adoption.structured-path', `No structured-content directory found at ${formatPathForMessage(pathInfo.path)} (${pathInfo.source}) — add ${DEFAULT_STRUCTURED_CONTENT_PATH}/ or configure structuredContent.path when template support lands; see ${ADOPTION_DOC}`);
  }

  if (structuredSummary.errors.length > 0) {
    pushOptional(checks, required, 'adoption.structured-read', `Could not read all structured-content files under ${formatPathForMessage(pathInfo.path)}: ${structuredSummary.errors.slice(0, 2).join('; ')}`);
  }

  const alternates = !structuredSummary.exists ? findStructuredContentCandidates(cwd, pathInfo.path) : [];
  for (const candidate of alternates.slice(0, 3)) {
    checks.push(warn(`adoption.structured-candidate.${candidate.path.replace(/[^a-z0-9]+/gi, '-')}`, `Found possible structured content at ${formatPathForMessage(candidate.path)} (${candidate.count} YAML descriptors), but doctor/build currently look at ${formatPathForMessage(pathInfo.path)}`));
  }

  if (pathInfo.sourceKind === 'env' || pathInfo.sourceKind === 'env-file') {
    checks.push(warn('adoption.path-parity', `Structured-content path comes from ${pathInfo.source}; set the same value in CI/hosting or move it into committed ${SOURCE_FILE} config once template #416 lands`));
  } else if (isAbsolute(pathInfo.path)) {
    checks.push(warn('adoption.path-parity', `Structured-content path is absolute (${pathInfo.path}); remote builds usually need a repo-relative path`));
  } else {
    checks.push(pass('adoption.path-parity', `Structured-content path is repo-relative (${formatPathForMessage(pathInfo.path)}), so local and remote builds can use the same layout`));
  }

  const derivedSummary = summarizeFiles(resolve(cwd, 'content', 'derived'), ['.jsonld']);
  if (derivedSummary.count > 0) {
    checks.push(pass('adoption.derived-jsonld', `Derived JSON-LD artifacts: ${derivedSummary.count} file${derivedSummary.count === 1 ? '' : 's'} in content/derived/`));
  }

  const appRoot = getAppRoot(cwd);
  const compatibility = readTemplateCompatibility(appRoot);
  const hasStructuredInput = structuredSummary.count > 0 || derivedSummary.count > 0 || alternates.length > 0;
  const advertisesStructured = hasAnyCapability(compatibility.capabilities, STRUCTURED_INGESTION_CAPABILITIES);
  const advertisesConfigurablePath = hasAnyCapability(compatibility.capabilities, CONFIGURABLE_STRUCTURED_PATH_CAPABILITIES);

  if (!compatibility.installed) {
    checks.push(warn('adoption.template-installed', 'Template app is not installed at .kbx/ — run kbx init before verifying local rendering'));
  } else {
    checks.push(pass('adoption.template-installed', `Template app installed${compatibility.packageName ? ` (${compatibility.packageName}${compatibility.packageVersion ? `@${compatibility.packageVersion}` : ''})` : ''}`));
    if (!compatibility.manifestScript) {
      checks.push(warn('adoption.template-manifest', 'Template manifest script is missing; CLI fallback manifests do not advertise structured-content ingestion'));
    }
  }

  if (!compatibility.metadata) {
    checks.push(warn('adoption.template-capabilities', `Template compatibility/capabilities are not advertised yet — cannot confirm content-model ingestion, diagram rendering, or edge semantics (${TEMPLATE_ISSUES.join(', ')})`));
  } else if (compatibility.capabilities.length === 0) {
    checks.push(warn('adoption.template-capabilities', `Template metadata is present (${compatibility.metadataSource}) but no capabilities are advertised yet`));
  } else {
    checks.push(pass('adoption.template-capabilities', `Template capabilities advertised (${compatibility.metadataSource}): ${compatibility.capabilities.join(', ')}`));
  }

  const cliVersion = readCliVersion();
  if (compatibility.protocolVersion) {
    checks.push(pass('adoption.template-protocol', `Template protocol version: ${compatibility.protocolVersion}`));
  }
  if (cliVersion && compatibility.minCliVersion) {
    const cmp = compareSemver(cliVersion, compatibility.minCliVersion);
    if (cmp != null && cmp < 0) {
      checks.push(warn('adoption.cli-version', `CLI ${cliVersion} is older than template minimum ${compatibility.minCliVersion}; update @anokye-labs/kbx`));
    } else {
      checks.push(pass('adoption.cli-version', `CLI ${cliVersion} satisfies template minimum ${compatibility.minCliVersion}`));
    }
  }
  if (cliVersion && compatibility.maxCliVersion) {
    const cmp = compareSemver(cliVersion, compatibility.maxCliVersion);
    if (cmp != null && cmp > 0) {
      checks.push(warn('adoption.cli-version-max', `CLI ${cliVersion} is newer than template maximum ${compatibility.maxCliVersion}; run kbx update or pin compatible versions`));
    }
  }

  if (hasStructuredInput && !compatibility.installed) {
    checks.push(warn('adoption.visibility', 'Structured content appears present, but local rendering cannot be checked until .kbx/ is installed'));
  } else if (hasStructuredInput && !advertisesStructured) {
    checks.push(warn('adoption.visibility', 'Structured content appears present, but the installed template does not advertise structured-content ingestion; local/remote builds may omit those nodes'));
  } else if (hasStructuredInput) {
    checks.push(pass('adoption.visibility', 'Structured-content ingestion is advertised by the installed template'));
  }

  if (hasStructuredInput && pathInfo.path !== DEFAULT_STRUCTURED_CONTENT_PATH && !advertisesConfigurablePath) {
    checks.push(warn('adoption.configurable-path', `Structured content uses ${formatPathForMessage(pathInfo.path)}, but the template does not advertise configurable-path support yet (track anokye-labs/kbexplorer-template#416)`));
  }

  checks.push(pass('adoption.guidance', `Adoption runbook: ${ADOPTION_DOC}; related template issues: ${TEMPLATE_ISSUES.join(', ')}`));

  return checks;
}
