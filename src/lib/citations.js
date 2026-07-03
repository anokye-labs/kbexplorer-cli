/**
 * Citation extraction — pulls file-path citations out of a content body.
 *
 * Split out of the former `src/lib/frontmatter.js` grab-bag (removed in
 * kbexplorer-cli#227): this is citation-format extraction for the
 * `affected` command, not frontmatter/YAML parsing, so it doesn't belong in
 * `src/lib/markdown.js` (the module that replaced the frontmatter parser).
 */

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
