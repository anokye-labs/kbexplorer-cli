/**
 * Map a set of changed source files to the kbx content nodes that
 * cite them. Pure computation — no LLM, no network.
 *
 * Powers `kbx affected <git-ref>`. The skill's incremental-refresh
 * playbook uses the JSON output of this to drive a focused page-by-page
 * refresh after a code change.
 */

import { execFileSync } from 'node:child_process';
import { readContentFile } from './markdown.ts';
import { extractCitedFiles } from './citations.ts';
import { listMarkdownFiles } from './fs-utils.ts';

type CitationIndex = Map<string, Set<string>>;

interface CitationNode {
  id: string;
  file: string;
  cited: string[];
}

interface AffectedDetail {
  file: string;
  nodes: string[];
}

interface AffectedOptions {
  ref: string;
  contentDir: string;
  cwd: string;
  files?: string[];
}

export function gitChangedFiles(ref: string, cwd: string): string[] {
  const raw = execFileSync('git', ['diff', '--name-only', ref], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a citation index: { citedFile -> Set<nodeId> }.
 *
 * @param {string} contentDir Absolute path to the content directory.
 * @returns {{ index: Map<string, Set<string>>, nodes: Array }}
 */
export function buildCitationIndex(contentDir: string): { index: CitationIndex; nodes: CitationNode[] } {
  const files = listMarkdownFiles(contentDir);
  const index: CitationIndex = new Map();
  const nodes: CitationNode[] = [];

  for (const file of files) {
    const result = readContentFile(file);
    if (!result.ok || !result.frontmatter || typeof result.frontmatter.id !== 'string') continue;
    const id = result.frontmatter.id;
    const cited = extractCitedFiles(result.body || '');
    nodes.push({ id, file, cited });
    for (const cite of cited) {
      if (!index.has(cite)) index.set(cite, new Set());
      index.get(cite)?.add(id);
    }
  }

  return { index, nodes };
}

/**
 * Given a list of changed file paths, return the set of node ids whose
 * content cites at least one of them, plus the mapping of file → ids for
 * detailed reporting.
 */
export function findAffected(changedFiles: string[], citationIndex: CitationIndex): { affected: string[]; detail: AffectedDetail[] } {
  const affected = new Set<string>();
  const detail: AffectedDetail[] = [];

  for (const file of changedFiles) {
    const matched = new Set<string>();

    // Direct match
    const directMatches = citationIndex.get(file);
    if (directMatches) {
      for (const id of directMatches) {
        affected.add(id);
        matched.add(id);
      }
    }

    // Suffix match — citations sometimes use forward slashes and partial paths
    for (const [cite, ids] of citationIndex) {
      if (cite === file) continue;
      if (file.endsWith(cite) || cite.endsWith(file)) {
        for (const id of ids) {
          affected.add(id);
          matched.add(id);
        }
      }
    }

    detail.push({ file, nodes: [...matched] });
  }

  return { affected: [...affected].sort(), detail };
}

/**
 * Resolve the affected nodes for a git ref.
 *
 * @param {object} options
 * @param {string} options.ref          - Git ref (e.g. HEAD~1, main, a SHA).
 * @param {string} options.contentDir   - Absolute path to content directory.
 * @param {string} options.cwd          - Working directory for git diff.
 * @param {string[]} [options.files]    - Pre-computed file list (bypasses git).
 */
export function affected({ ref, contentDir, cwd, files }: AffectedOptions) {
  const changedFiles = files ?? gitChangedFiles(ref, cwd);
  const { index, nodes } = buildCitationIndex(contentDir);
  const { affected: ids, detail } = findAffected(changedFiles, index);
  return {
    ref,
    changedFiles,
    nodeCount: nodes.length,
    affected: ids,
    detail,
    uncited: changedFiles.filter((f) =>
      !detail.find((d) => d.file === f && d.nodes.length > 0),
    ),
  };
}
