/**
 * Minimal zero-dependency frontmatter parser tuned for kbexplorer content files.
 *
 * Supports a deliberate subset of YAML — id, title, emoji, cluster, parent,
 * image, sprite, and a list of {to, description} connections. This is NOT a
 * general YAML parser: multi-line strings, anchors, inline objects/arrays,
 * and escaped quoted special characters are NOT supported. Anything more
 * exotic is preserved in `extra` (raw string) for round-tripping.
 *
 * Returns:
 *   { ok: true,  frontmatter: {...}, body, raw } on success
 *   { ok: false, error: "...",       body, raw } on parse error
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Load `.env.kbexplorer` from the given cwd and return the parsed keys.
 * Minimal parser: `KEY=value` lines, ignores blanks and `#`-comments.
 * Does NOT mutate `process.env`. Returns `{}` if the file is missing.
 */
export function loadKbEnv(cwd) {
  const envPath = resolve(cwd, '.env.kbexplorer');
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
 * Resolve the kbexplorer content directory for a given cwd.
 * Priority: explicit override → process.env.VITE_KB_PATH → .env.kbexplorer → 'content'.
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

function stripQuotes(value) {
  if (value == null) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, error: 'no frontmatter block found', frontmatter: null, body: raw, raw };
  }

  const yaml = match[1];
  const body = match[2] ?? '';
  const lines = yaml.split(/\r?\n/);

  const fm = { connections: [] };
  let inConnections = false;
  let currentConn = null;
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Inline empty array — connections: []
    const emptyConn = line.match(/^connections:\s*\[\s*\]\s*$/);
    if (emptyConn) {
      if (currentConn) fm.connections.push(currentConn);
      currentConn = null;
      inConnections = false;
      continue;
    }

    // Begin connections block
    if (/^connections:\s*$/.test(line)) {
      if (currentConn) fm.connections.push(currentConn);
      currentConn = null;
      inConnections = true;
      continue;
    }

    if (inConnections) {
      const toMatch = line.match(/^\s+-\s+to:\s*(.+?)\s*$/);
      const descMatch = line.match(/^\s+description:\s*(.+?)\s*$/);
      if (toMatch) {
        if (currentConn) fm.connections.push(currentConn);
        currentConn = { to: stripQuotes(toMatch[1]), description: '' };
        continue;
      }
      if (descMatch && currentConn) {
        currentConn.description = stripQuotes(descMatch[1]);
        continue;
      }
      // Top-level key encountered — end of connections block
      if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) {
        if (currentConn) fm.connections.push(currentConn);
        currentConn = null;
        inConnections = false;
        // fall through to the kv parser below
      } else {
        continue;
      }
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) {
      return {
        ok: false,
        error: `line ${lineNum}: unparseable "${line}"`,
        frontmatter: null,
        body,
        raw,
      };
    }
    const [, key, value] = kv;
    fm[key] = stripQuotes(value);
  }

  if (currentConn) fm.connections.push(currentConn);

  return { ok: true, frontmatter: fm, body, raw };
}

export function readContentFile(absPath) {
  const raw = readFileSync(absPath, 'utf-8');
  return { ...parseFrontmatter(raw), path: absPath };
}

const CITATION_LINKED_RE = /\[([^\]\s]+):(\d+)(?:-L?\d+)?\]\(([^)]+)\)/g;
const CITATION_LOCAL_RE = /\(([\w./-]+?):(\d+)(?:-\d+)?\)/g;

/**
 * Extract file path citations from a markdown body. Recognises both the
 * remote `[path:line](url)` and the local `(path:line)` formats documented
 * in the kb-architect / kb-writer agents.
 *
 * Returns an array of unique file paths (no line numbers).
 */
export function extractCitedFiles(body) {
  const files = new Set();

  for (const m of body.matchAll(CITATION_LINKED_RE)) {
    files.add(m[1]);
  }
  for (const m of body.matchAll(CITATION_LOCAL_RE)) {
    // Filter out anchors/URLs/version-looking things
    const path = m[1];
    if (path.includes('/') || /\.[A-Za-z0-9]+$/.test(path)) files.add(path);
  }

  // Also pick up explicit Source comments: <!-- Source: path:line -->
  for (const m of body.matchAll(/<!--\s*Sources?:\s*([^>]+?)\s*-->/g)) {
    for (const ref of m[1].split(/[,;]\s*/)) {
      const p = ref.split(':')[0]?.trim();
      if (p && (p.includes('/') || /\.[A-Za-z0-9]+$/.test(p))) files.add(p);
    }
  }

  return [...files];
}
