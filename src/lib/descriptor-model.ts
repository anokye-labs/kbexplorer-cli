/**
 * Deterministic, LLM-free, auth-free validation for the `content-model/`
 * descriptor tree (person / team / workstream / priority / system-of-record).
 *
 * `audit.js` only covers `content/*.md`. This module is the standalone gate for
 * the structured org-layer descriptors that `kbx audit` never sees — the
 * data the template's manifest build consumes. It enforces, per kind:
 *
 *   • required/optional field contracts (extra fields pass through, never error)
 *   • FK edge resolution, failing on dangling refs:
 *       person.manager           → person            (reports-to)
 *       team.lead                → person (alias|id) (leads)
 *       team.members             → person[]          (staffs)
 *       team.workstreams         → workstream[]      (owns)
 *       workstream.priority      → priority          (has-priority)
 *       workstream.team          → team              (structural)
 *       workstream.systems-of-record → system-of-record[] (tracked-in)
 *   • the 6-relation taxonomy (leads|staffs|reports-to|structural|derived|
 *     deprecated) on any explicitly-declared `relations:` entries
 *   • unique id per kind
 *   • `reports-to` (person.manager) cycle detection
 *
 * Everything is PURE and DETERMINISTIC: identical trees → identical findings.
 * The CLI command exits 1 when any `error`-severity finding is present.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, basename, extname, relative, sep } from 'node:path';
import { KNOWN_RELATIONS } from './jsonld.ts';

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

/**
 * Directory (immediately under the content-model root) → entity kind.
 * The directory is the primary source of truth for a descriptor's kind; a
 * descriptor's own `@type` must agree with it.
 */
export const KIND_DIRS = Object.freeze({
  people: 'person',
  teams: 'team',
  workstreams: 'workstream',
  priorities: 'priority',
  'systems-of-record': 'system-of-record',
});

export const KNOWN_KINDS = Object.freeze(Object.values(KIND_DIRS));

/**
 * Per-kind field contract.
 *   required — every descriptor of this kind must carry a non-empty value.
 *   fks      — foreign-key fields: { field, target, array, alias }.
 *
 * `optional` is intentionally NOT enforced: descriptors are passthrough, so any
 * additional field is allowed and never produces a finding.
 */
export const KIND_CONTRACTS = Object.freeze({
  person: {
    required: ['@type', 'id', 'name'],
    fks: [{ field: 'manager', target: 'person', array: false }],
  },
  team: {
    required: ['@type', 'id', 'name'],
    fks: [
      { field: 'lead', target: 'person', array: false, alias: true },
      { field: 'members', target: 'person', array: true },
      { field: 'workstreams', target: 'workstream', array: true },
    ],
  },
  workstream: {
    required: ['@type', 'id', 'name'],
    fks: [
      { field: 'priority', target: 'priority', array: false },
      { field: 'team', target: 'team', array: false },
      { field: 'systems-of-record', target: 'system-of-record', array: true },
    ],
  },
  priority: {
    required: ['@type', 'id', 'name'],
    fks: [],
  },
  'system-of-record': {
    required: ['@type', 'id', 'name'],
    fks: [],
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Minimal descriptor YAML parser
//
// Tuned for the content-model descriptor subset (see docs/templates/*.yaml):
// top-level scalars (quoted or bare), block lists (`- item`), and folded/literal
// block scalars (`>`/`|`). Inline `# comments` after bare scalars and list items
// are stripped. This is NOT a general YAML parser (no nested maps, anchors, or
// flow collections); inline `{ ... }` list entries are preserved verbatim and
// skipped for FK resolution.
// ──────────────────────────────────────────────────────────────────────────

function leadingSpaces(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

function stripQuotes(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Strip a trailing ` # comment` from a bare (unquoted) scalar or list item. */
function stripInlineComment(value) {
  const s = value.trimStart();
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0];
    const close = s.indexOf(quote, 1);
    if (close >= 0) return s.slice(0, close + 1);
    return s;
  }
  const m = s.match(/\s+#/);
  if (m) return s.slice(0, m.index);
  return s;
}

/** Coerce a bare scalar: integers → Number, everything else → trimmed string. */
function coerceScalar(value) {
  const unquoted = stripQuotes(value);
  if (typeof unquoted === 'string' && /^-?\d+$/.test(unquoted.trim())) {
    return Number(unquoted.trim());
  }
  return unquoted;
}

/**
 * Parse a single descriptor file's YAML text.
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function parseDescriptor(raw) {
  const lines = String(raw).split(/\r?\n/);
  const data = {};
  let i = 0;

  const isSkippable = (line) => {
    const t = line.trim();
    return t === '' || t.startsWith('#');
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isSkippable(line)) {
      i++;
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent > 0) {
      // A stray indented line with no owning top-level key.
      return { ok: false, error: `line ${i + 1}: unexpected indentation "${line.trim()}"` };
    }

    const content = line.slice(indent);
    const colon = content.indexOf(':');
    if (colon < 0) {
      return { ok: false, error: `line ${i + 1}: expected "key: value" but found "${content}"` };
    }

    const key = stripQuotes(content.slice(0, colon).trim());
    if (key === '') {
      return { ok: false, error: `line ${i + 1}: empty key` };
    }
    let rest = content.slice(colon + 1).trim();
    i++;

    // Folded (`>`) or literal (`|`) block scalar.
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const literal = rest.startsWith('|');
      const collected = [];
      while (i < lines.length) {
        if (lines[i].trim() === '') {
          collected.push('');
          i++;
          continue;
        }
        if (leadingSpaces(lines[i]) === 0) break;
        collected.push(lines[i].trim());
        i++;
      }
      const joined = literal
        ? collected.join('\n').replace(/\n+$/, '')
        : collected.join(' ').replace(/\s+/g, ' ').trim();
      data[key] = joined;
      continue;
    }

    // Block list (`key:` with empty value, followed by indented `- ` items).
    if (rest === '') {
      const items = [];
      let sawItem = false;
      while (i < lines.length) {
        if (isSkippable(lines[i])) {
          i++;
          continue;
        }
        if (leadingSpaces(lines[i]) === 0) break;
        const itemContent = lines[i].trim();
        if (!itemContent.startsWith('- ') && itemContent !== '-') {
          // Indented non-list content under an empty key — unsupported nesting.
          return {
            ok: false,
            error: `line ${i + 1}: expected a "- " list item under "${key}" but found "${itemContent}"`,
          };
        }
        const itemRaw = itemContent === '-' ? '' : itemContent.slice(2);
        sawItem = true;
        const trimmed = itemRaw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          items.push(trimmed); // inline collection — preserved verbatim
        } else {
          items.push(coerceScalar(stripInlineComment(itemRaw)));
        }
        i++;
      }
      data[key] = sawItem ? items : [];
      continue;
    }

    // Scalar value.
    data[key] = coerceScalar(stripInlineComment(rest));
  }

  return { ok: true, data };
}

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

function listDescriptorFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && ['.yaml', '.yml'].includes(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Derive the kind for a descriptor from its directory (preferred) or @type. */
function kindForFile(file, rootDir, data) {
  const rel = relative(rootDir, file);
  const parts = rel.split(sep);
  const topDir = parts.length > 1 ? parts[0] : null;
  if (topDir && KIND_DIRS[topDir]) return { kind: KIND_DIRS[topDir], source: 'dir', dir: topDir };
  const declared = data && typeof data['@type'] === 'string' ? data['@type'] : null;
  if (declared && KNOWN_KINDS.includes(declared)) return { kind: declared, source: 'type', dir: topDir };
  return { kind: null, source: null, dir: topDir, declared };
}

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asRefList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim())
    .filter((v) => v !== '' && !v.startsWith('{') && !v.startsWith('['));
}

function detectReportsToCycles(people) {
  // people: array of { id, manager, file }
  const byId = new Map(people.map((p) => [p.id, p]));
  const cycles = [];
  const seenCycleKeys = new Set();
  for (const start of people) {
    const seen = new Set([start.id]);
    const trail = [start.id];
    let cursor = start.manager;
    while (cursor) {
      trail.push(cursor);
      if (seen.has(cursor)) {
        const key = [...trail].sort().join('|');
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push({ id: start.id, file: start.file, cycle: trail.slice() });
        }
        break;
      }
      seen.add(cursor);
      const next = byId.get(cursor);
      if (!next) break; // dangling manager handled separately as broken-ref
      cursor = next.manager;
    }
  }
  return cycles;
}

/**
 * Validate a content-model descriptor tree.
 *
 * @param {object} options
 * @param {string} options.rootDir   Absolute path to the content-model directory.
 * @returns {{ findings: Array, summary: object, exists: boolean }}
 */
export function validateContentModel({ rootDir }) {
  const findings = [];
  const push = (f) => findings.push(f);
  const exists = existsSync(rootDir);
  const files = listDescriptorFiles(rootDir);

  // ── Parse every descriptor, assign a kind ──────────────────────────────
  const descriptors = []; // { file, kind, data }
  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch (err) {
      push({ severity: SEVERITY.ERROR, rule: 'read-error', file, message: `cannot read file: ${err.message}` });
      continue;
    }
    const parsed = parseDescriptor(raw);
    if (!parsed.ok) {
      push({ severity: SEVERITY.ERROR, rule: 'malformed-yaml', file, message: parsed.error });
      continue;
    }
    const { kind, source, dir, declared } = kindForFile(file, rootDir, parsed.data);
    if (!kind) {
      push({
        severity: SEVERITY.ERROR,
        rule: 'unknown-kind',
        file,
        message: declared
          ? `unknown kind: @type "${declared}" is not one of ${KNOWN_KINDS.join(', ')}`
          : `cannot determine kind: file is not under a known kind directory (${Object.keys(KIND_DIRS).join(', ')}) and has no valid @type`,
      });
      continue;
    }
    // Directory-derived kind must agree with a declared @type.
    if (source === 'dir' && typeof parsed.data['@type'] === 'string' && parsed.data['@type'] !== kind) {
      push({
        severity: SEVERITY.ERROR,
        rule: 'type-mismatch',
        file,
        message: `@type "${parsed.data['@type']}" does not match directory kind "${kind}" (dir "${dir}")`,
      });
    }
    descriptors.push({ file, kind, data: parsed.data });
  }

  // ── Required fields ─────────────────────────────────────────────────────
  for (const d of descriptors) {
    const contract = KIND_CONTRACTS[d.kind];
    for (const field of contract.required) {
      if (isEmpty(d.data[field])) {
        push({
          severity: SEVERITY.ERROR,
          rule: 'missing-required-field',
          file: d.file,
          kind: d.kind,
          field,
          message: `${d.kind} descriptor missing required field "${field}"`,
        });
      }
    }
  }

  // ── Index ids per kind (+ person aliases for alias-FK resolution) ───────
  const idsByKind = new Map(KNOWN_KINDS.map((k) => [k, new Set()]));
  const seenByKind = new Map(KNOWN_KINDS.map((k) => [k, new Map()])); // id -> [files]
  const personAliases = new Set();
  const people = [];
  for (const d of descriptors) {
    const id = typeof d.data.id === 'string' || typeof d.data.id === 'number' ? String(d.data.id).trim() : '';
    if (id) {
      idsByKind.get(d.kind).add(id);
      const seen = seenByKind.get(d.kind);
      if (!seen.has(id)) seen.set(id, []);
      seen.get(id).push(d.file);
    }
    if (d.kind === 'person') {
      if (id) people.push({ id, manager: emptyToNull(strOrNull(d.data.manager)), file: d.file });
      if (typeof d.data.alias === 'string' && d.data.alias.trim()) personAliases.add(d.data.alias.trim());
    }
  }

  // ── Duplicate ids (per kind) ────────────────────────────────────────────
  for (const [kind, seen] of seenByKind) {
    for (const [id, paths] of seen) {
      if (paths.length > 1) {
        push({
          severity: SEVERITY.ERROR,
          rule: 'duplicate-id',
          kind,
          id,
          files: paths.slice(),
          message: `duplicate ${kind} id "${id}" declared in ${paths.length} files`,
        });
      }
    }
  }

  // ── FK resolution (dangling refs) ───────────────────────────────────────
  for (const d of descriptors) {
    const contract = KIND_CONTRACTS[d.kind];
    for (const fk of contract.fks) {
      const value = d.data[fk.field];
      if (isEmpty(value)) continue;
      const refs = fk.array ? asRefList(value) : asRefList(value).slice(0, 1);
      const targetIds = idsByKind.get(fk.target);
      for (const ref of refs) {
        const resolved =
          targetIds.has(ref) || (fk.alias && fk.target === 'person' && personAliases.has(ref));
        if (!resolved) {
          push({
            severity: SEVERITY.ERROR,
            rule: 'broken-ref',
            file: d.file,
            kind: d.kind,
            field: fk.field,
            ref,
            target: fk.target,
            message: `${d.kind}.${fk.field} → "${ref}" does not resolve to a ${fk.target}`,
          });
        }
      }
    }
  }

  // ── Explicit relation taxonomy (only when a `relations:` block is present) ─
  for (const d of descriptors) {
    const rels = d.data.relations;
    if (!Array.isArray(rels)) continue;
    for (const entry of rels) {
      if (typeof entry !== 'string') continue; // structured relation maps are out of subset
      const rel = stripInlineComment(entry).trim().toLowerCase();
      if (!rel) continue;
      if (!KNOWN_RELATIONS.includes(rel)) {
        push({
          severity: SEVERITY.ERROR,
          rule: 'off-taxonomy-relation',
          file: d.file,
          kind: d.kind,
          relation: rel,
          message: `relation "${rel}" is not in the taxonomy (${KNOWN_RELATIONS.join(', ')})`,
        });
      }
    }
  }

  // ── reports-to cycles (person.manager chain) ────────────────────────────
  for (const c of detectReportsToCycles(people)) {
    push({
      severity: SEVERITY.ERROR,
      rule: 'reports-to-cycle',
      file: c.file,
      id: c.id,
      cycle: c.cycle,
      message: `reports-to chain forms a cycle: ${c.cycle.join(' → ')}`,
    });
  }

  const errors = findings.filter((f) => f.severity === SEVERITY.ERROR).length;
  const warnings = findings.filter((f) => f.severity === SEVERITY.WARNING).length;
  const summary = {
    exists,
    files: files.length,
    descriptors: descriptors.length,
    byKind: descriptors.reduce((acc, d) => {
      acc[d.kind] = (acc[d.kind] || 0) + 1;
      return acc;
    }, {}),
    errors,
    warnings,
    byRule: findings.reduce((acc, f) => {
      acc[f.rule] = (acc[f.rule] || 0) + 1;
      return acc;
    }, {}),
  };

  return { findings, summary, exists };
}

function strOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : null;
}

function emptyToNull(v) {
  return v == null || v === '' ? null : v;
}

export const _internal = {
  leadingSpaces,
  stripInlineComment,
  coerceScalar,
  kindForFile,
  detectReportsToCycles,
  listDescriptorFiles,
  asRefList,
};

