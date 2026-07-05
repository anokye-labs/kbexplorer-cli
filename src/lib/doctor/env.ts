import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAppRoot } from '../detect-repo.ts';
import { manifestOutPath } from '../../commands/dev.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

type DoctorStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

function pass(id: string, message: string): DoctorCheck { return { id, status: 'pass', message }; }
function warn(id: string, message: string): DoctorCheck { return { id, status: 'warn', message }; }
function fail(id: string, message: string): DoctorCheck { return { id, status: 'fail', message }; }

function probeTool(binary: string, args: string[], spawnSyncImpl: typeof spawnSync) {
  try {
    const res = spawnSyncImpl(binary, args, {
      encoding: 'utf-8',
      timeout: 5000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error || res.status == null) return { available: false };
    const text = (res.stdout || res.stderr || '').trim();
    const line = text.split(/\r?\n/).find((l: string) => l.trim()) ?? '';
    return { available: true, version: line.slice(0, 80) || null };
  } catch {
    return { available: false };
  }
}

function getHeadCommitTime(cwd: string, spawnSyncImpl: typeof spawnSync): number | null {
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

export function checkEnvironment({
  cwd,
  env: _env,
  spawnSync: spawnSyncImpl = spawnSync,
}: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnSync?: typeof spawnSync;
}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.version;
  try {
    const pkgPath = resolve(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { engines?: { node?: string } };
    const enginesNode = pkg.engines?.node;
    if (enginesNode) {
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

  const gitAvailable = probeTool('git', ['--version'], spawnSyncImpl);
  if (gitAvailable.available) {
    checks.push(pass('env.git', `git available${gitAvailable.version ? `: ${gitAvailable.version}` : ''}`));
  } else {
    checks.push(fail('env.git', 'git not found on PATH'));
  }

  const ghAvailable = probeTool('gh', ['--version'], spawnSyncImpl);
  if (ghAvailable.available) {
    checks.push(pass('env.gh', `gh (GitHub CLI) available${ghAvailable.version ? `: ${ghAvailable.version}` : ''}`));
  } else {
    checks.push(warn('env.gh', 'gh (GitHub CLI) not found on PATH — needed for some workflows'));
  }

  const contentDir = resolve(cwd, 'content');
  if (existsSync(contentDir)) {
    checks.push(pass('env.content-dir', 'content/ directory present'));
  } else {
    checks.push(warn('env.content-dir', `content/ directory not found at ${contentDir}`));
  }

  const appRoot = getAppRoot(cwd);
  const manifestPath = appRoot ? manifestOutPath(appRoot) : null;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { generatedAt?: string };
      const generatedAt = manifest.generatedAt;
      if (!generatedAt) {
        checks.push(warn('env.manifest', 'repo-manifest.json present but has no generatedAt field'));
      } else {
        const headTime = getHeadCommitTime(cwd, spawnSyncImpl);
        if (headTime && generatedAt) {
          const generatedMs = new Date(generatedAt).getTime();
          const headMs = headTime;
          if (headMs - generatedMs > 5 * 60 * 1000) {
            checks.push(warn('env.manifest', `repo-manifest.json may be stale (generated ${generatedAt}, HEAD is newer)`));
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

  return checks;
}
