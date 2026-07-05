import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolvePackageAssetsDir(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDir, '..', 'assets'),
    resolve(moduleDir, '..', 'src', 'assets'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
