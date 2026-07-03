/**
 * kbx environment / content-path resolution helpers.
 *
 * Split out of the former `src/lib/frontmatter.js` grab-bag (removed in
 * kbexplorer-cli#227): `.env.kbx` loading and content-directory resolution
 * are CLI/environment concerns, not frontmatter or Markdown parsing, so they
 * don't belong in the same module as the parser that replaced it
 * (`src/lib/markdown.js`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `.env.kbx` from the given cwd and return the parsed keys.
 * Minimal parser: `KEY=value` lines, ignores blanks and `#`-comments.
 * Does NOT mutate `process.env`. Returns `{}` if the file is missing.
 */
export function loadKbEnv(cwd) {
  const envPath = resolve(cwd, '.env.kbx');
  if (!existsSync(envPath)) return {};
  const out = {};
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Resolve the kbx content directory for a given cwd.
 * Priority: explicit override → process.env.VITE_KB_PATH → .env.kbx → 'content'.
 * Returns `{ contentDir: absolute, contentPath: relative }`.
 */
export function resolveContentDir(cwd, override) {
  const envFile = loadKbEnv(cwd);
  const contentPath = override
    || process.env.VITE_KB_PATH
    || envFile.VITE_KB_PATH
    || 'content';
  return { contentDir: resolve(cwd, contentPath), contentPath };
}
