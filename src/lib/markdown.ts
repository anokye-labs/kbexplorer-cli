/**
 * kbx content-file parsing — a thin CLI-side adapter over the shared
 * `@anokye-labs/kbexplorer-provider-rich-markdown` YAML-subset engine.
 *
 * This used to be a hand-rolled, zero-dependency parser
 * (the legacy flat frontmatter parser, removed in kbexplorer-cli#227) that only
 * understood a flat scalar subset (id/title/cluster/parent/emoji/image/sprite
 * plus a `connections:` list) and threw on anything richer — nested `access:`
 * blocks included (see the historical note on issue #179). That duplicated
 * parsing logic that already lives in the rich-markdown provider, which the
 * CLI has depended on since #133/#177 but never actually used for its own
 * content pipeline.
 *
 * `parseRichFrontmatter()` from `@anokye-labs/kbexplorer-provider-rich-markdown/lib`
 * is a pure, dependency-free (within that package) YAML-subset parser that
 * preserves *every* key it sees — typed scalars, nested maps, block/flow
 * sequences, and block scalars. This module just adapts its return shape to
 * the one kbx's CLI code paths already expect (`{ ok, frontmatter, body, raw,
 * error }`) so `audit`, `affected`, `graph`, `graph-builder`, and the canvas
 * server didn't need to change their call sites.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

interface RichFrontmatterResult {
  ok: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  bodyOffset: number;
}

interface ParsedContentFile {
  ok: boolean;
  frontmatter: Record<string, unknown> | null;
  body: string;
  raw: string;
  error?: string;
}

const require = createRequire(import.meta.url);
const { parseRichFrontmatter } = require('@anokye-labs/kbexplorer-provider-rich-markdown/lib') as {
  parseRichFrontmatter: (raw: string) => RichFrontmatterResult;
};

/**
 * Parse a kbx content file's frontmatter + body.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, frontmatter: object|null, body: string, raw: string, error?: string }}
 */
export function parseFrontmatter(raw: string): ParsedContentFile {
  const text = String(raw ?? '');
  const result = parseRichFrontmatter(text);

  // `bodyOffset === 0` is how the rich parser signals "no `---` fence found at
  // all" (as opposed to an empty-but-present frontmatter block, which still
  // consumes a nonzero prefix). Preserve the original contract: no fence is a
  // parse failure for kbx content, not an empty-frontmatter document.
  if (result.bodyOffset === 0) {
    return { ok: false, error: 'no frontmatter block found', frontmatter: null, body: text, raw: text };
  }

  if (!result.ok) {
    return {
      ok: false,
      error: 'malformed frontmatter block',
      frontmatter: null,
      body: result.body,
      raw: text,
    };
  }

  return { ok: true, frontmatter: result.frontmatter, body: result.body, raw: text };
}

/**
 * Read a content file from disk and parse its frontmatter + body.
 *
 * @param {string} absPath
 * @returns {{ ok: boolean, frontmatter: object|null, body: string, raw: string, path: string, error?: string }}
 */
export function readContentFile(absPath: string): ParsedContentFile & { path: string } {
  const raw = readFileSync(absPath, 'utf-8');
  return { ...parseFrontmatter(raw), path: absPath };
}
