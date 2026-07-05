/**
 * Template source record (`.kbx.json`).
 *
 * The CLI-owned source of truth for where the explorer template came from and
 * how it was installed. Lives at the host repo root so both submodule and vendor
 * (one-time copy) installs can be updated without relying on `.gitmodules`.
 *
 * Shape:
 *   {
 *     "template": "<git url>",
 *     "ref": "<tag|branch|null>",        // null => track latest release
 *     "refType": "release" | "tag" | "branch",
 *     "resolvedCommit": "<40-char sha|null>",
 *     "mode": "submodule" | "vendor"
 *   }
 */

import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const SOURCE_FILE = '.kbx.json';
const LEGACY_SOURCE_FILE = '.kbexplorer.json';

/**
 * Classify a ref string into an update policy.
 * - no ref           => "release" (track the latest semver release tag)
 * - vX.Y.Z / X.Y.Z   => "tag" (pinned)
 * - anything else     => "branch" (track that branch's HEAD)
 *
 * @param {string|null|undefined} ref
 * @returns {"release"|"tag"|"branch"}
 */
export function classifyRef(ref) {
  if (!ref) return 'release';
  return /^v?\d+\.\d+\.\d+/.test(ref) ? 'tag' : 'branch';
}

/**
 * Read the source record from a host repo. Returns null when absent or invalid.
 * Falls back to the legacy `.kbexplorer.json` name with a deprecation warning.
 * @param {string} cwd
 * @returns {object|null}
 */
export function readSourceRecord(cwd = process.cwd()) {
  let file = resolve(cwd, SOURCE_FILE);
  if (!existsSync(file)) {
    const legacyFile = resolve(cwd, LEGACY_SOURCE_FILE);
    if (existsSync(legacyFile)) {
      process.stderr.write(`[kbx] ${LEGACY_SOURCE_FILE} is deprecated; rename it to ${SOURCE_FILE}\n`);
      file = legacyFile;
    } else {
      return null;
    }
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Write the source record to a host repo.
 * @param {string} cwd
 * @param {object} record
 * @returns {string} the path written
 */
export function writeSourceRecord(cwd, record) {
  const file = resolve(cwd, SOURCE_FILE);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return file;
}

