/**
 * Deterministic JSON-LD emission (T8.2).
 *
 * Normalizes a fuzzy extraction intermediate ({ entities, relationships }) into
 * committed `*.jsonld` that conforms to Epic 1 / F1's node-type contract
 * (kbexplorer-template #148):
 *
 *   • `@id`     — the entity's identity URN `kg://<type>/<slug>`, REUSED as the
 *                 node identity and NEVER derived from a file path.
 *   • `@type`   — the open entity-kind key (e.g. 'person'), NEVER derived from path.
 *   • `@context`— defaults to schema.org.
 *   • relations — mapped onto the 6-relation taxonomy
 *                 leads | staffs | reports-to | structural | derived | deprecated.
 *   • payload   — aligns with KBNode's `entityType` + `jsonld` + `data` shape, plus
 *                 an open `source: { type:'structured', entityType, ref }` so the
 *                 mapping is reversible to the originating document (supports F5).
 *
 * Everything here is PURE and CANONICAL: identical input → byte-identical output
 * (sorted keys, no timestamps), which is what makes re-derivation idempotent and
 * the drift check meaningful (T8.3).
 *
 * ── Public API ──
 *   KNOWN_RELATIONS / RELATION_SYNONYMS
 *   slugify(s)                              -> string
 *   buildId(type, key)                      -> 'kg://<type>/<slug>'
 *   mapRelation(raw)                        -> { relation, raw }
 *   normalizeExtraction(intermediate, opts) -> { nodes[], edges[], graph[] }
 *   buildArtifact({ source, intermediate, ... }) -> artifact object
 *   canonicalStringify(value)               -> string (stable, +trailing \n)
 *   validateArtifact(artifact)              -> { ok, errors[] }
 *   toKBNode(member) / sourceRefOf(member)  reversibility helpers
 *   ARTIFACT_SCHEMA_VERSION
 */

import {
  KNOWN_RELATIONS,
  RELATION_SYNONYMS,
  slugify,
  normalizeType,
  buildId,
  buildEdgeId,
  stripScheme,
  mapRelation,
  ID_RE,
  TYPE_RE,
} from '@anokye-labs/kbexplorer-core';
import { normalizeAccessLabel, mergeAccessLabels } from './access-label.js';

/**
 * Identity + relation primitives come from the shared contract package
 * `@anokye-labs/kbexplorer-core` and are re-exported here so existing
 * `../lib/jsonld.js` imports keep working unchanged. They are pure and
 * canonical: identical input → byte-identical output, which is what keeps
 * re-derivation idempotent and the drift check meaningful.
 */
export {
  KNOWN_RELATIONS,
  RELATION_SYNONYMS,
  slugify,
  normalizeType,
  buildId,
  buildEdgeId,
  mapRelation,
};

export const ARTIFACT_SCHEMA_VERSION = 1;

export const DEFAULT_CONTEXT = 'https://schema.org';

export const GENERATOR = '@anokye-labs/kbx derive';


function isScalar(v) {
  return v == null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** Build the flat LD-property bag (only scalar props are promoted to LD). */
function ldProperties(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'name') continue; // emitted explicitly
    if (isScalar(v)) out[k] = v;
  }
  return out;
}

/**
 * Normalize an extraction intermediate into nodes/edges/graph.
 *
 * @param {{ entities: object[], relationships: object[] }} intermediate
 * @param {object} options
 * @param {string}   options.sourceRef            Source path used in `source.ref` (e.g. 'docs/org.docx').
 * @param {JsonLd['@context']} [options.context]  Override `@context` (default schema.org).
 * @returns {{ nodes: object[], edges: object[], graph: object[] }}
 */
export function normalizeExtraction(intermediate, options = {}) {
  const { sourceRef = 'unknown', context = DEFAULT_CONTEXT } = options;
  const entities = Array.isArray(intermediate?.entities) ? intermediate.entities : [];
  const relationships = Array.isArray(intermediate?.relationships) ? intermediate.relationships : [];

  // ── Entities → nodes (deterministic id assignment, dedupe by @id) ──
  const byId = new Map(); // @id -> node
  const aliasToId = new Map(); // lower(name|id|@id) -> @id (for relationship resolution)

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;
    const type = normalizeType(entity.type ?? entity['@type'] ?? 'entity');
    const name = String(entity.name ?? entity.label ?? entity.id ?? 'unknown').trim() || 'unknown';
    const key = entity.id != null && String(entity.id).trim() ? entity.id : name;
    const id = buildId(type, key);

    const props =
      entity.properties && typeof entity.properties === 'object' && !Array.isArray(entity.properties)
        ? entity.properties
        : {};
    const data = { name, ...sortObject(props) };

    // Carry an access label set at the source onto the node (and its LD member).
    // Accept it on the entity itself or inside its properties; absent → unlabeled.
    const entityAccess = normalizeAccessLabel(entity.access ?? props.access);

    const node = byId.get(id) ?? {
      id,
      identity: id,
      entityType: type,
      title: name,
      source: { type: 'structured', entityType: type, ref: `${sourceRef}#${slugify(key)}` },
      jsonld: {
        '@context': context,
        '@id': id,
        '@type': type,
        name,
        ...ldProperties(data),
        ...(entityAccess ? { access: entityAccess } : {}),
      },
      data,
      ...(entityAccess ? { access: entityAccess } : {}),
    };
    // Merge data for duplicate ids (later props win), refresh jsonld scalars.
    if (byId.has(id)) {
      node.data = { ...node.data, ...data };
      // Combine duplicate-id labels most-restrictively (never broaden).
      const merged = mergeAccessLabels([node.access, entityAccess]);
      if (merged) node.access = merged;
      else delete node.access;
      node.jsonld = {
        ...node.jsonld,
        name: node.data.name,
        ...ldProperties(node.data),
        ...(node.access ? { access: node.access } : {}),
      };
      if (!node.access) delete node.jsonld.access;
    }
    byId.set(id, node);

    for (const alias of [entity.id, name, id]) {
      if (alias != null && String(alias).trim()) aliasToId.set(String(alias).trim().toLowerCase(), id);
    }
  }

  const nodes = [...byId.values()];

  // ── Relationships → edges (resolve endpoints, map taxonomy, dedupe) ──
  const resolve = (ref) => {
    if (ref == null) return null;
    const key = String(ref).trim().toLowerCase();
    if (aliasToId.has(key)) return aliasToId.get(key);
    // tolerate a raw kg:// id we haven't seen as an entity alias
    if (key.startsWith('kg://') && byId.has(String(ref).trim())) return String(ref).trim();
    return null;
  };

  const edgeById = new Map();
  for (const rel of relationships) {
    if (!rel || typeof rel !== 'object') continue;
    const fromId = resolve(rel.from ?? rel.source ?? rel.subject);
    const toId = resolve(rel.to ?? rel.target ?? rel.object);
    if (!fromId || !toId || fromId === toId) continue; // drop dangling / self edges

    const { relation, raw } = mapRelation(rel.type ?? rel.relation ?? rel.kind ?? rel.label);
    const id = buildEdgeId(fromId, relation, toId);
    if (edgeById.has(id)) continue;

    const edge = { id, source: fromId, target: toId, relation };
    if (raw && raw !== relation) edge.relationRaw = raw;
    if (rel.label && String(rel.label).trim()) edge.label = String(rel.label).trim();
    const edgeAccess = normalizeAccessLabel(rel.access);
    if (edgeAccess) edge.access = edgeAccess;
    edgeById.set(id, edge);
  }
  const edges = [...edgeById.values()];

  // ── Combined JSON-LD @graph (entities as LD nodes + relationships as LD) ──
  const graph = [
    ...nodes.map((n) => ({ ...n.jsonld })),
    ...edges.map((e) => ({
      '@id': e.id,
      '@type': 'Relationship',
      relation: e.relation,
      from: { '@id': e.source },
      to: { '@id': e.target },
      ...(e.label ? { name: e.label } : {}),
      ...(e.access ? { access: e.access } : {}),
    })),
  ];

  return { nodes, edges, graph };
}

/**
 * Build the full committed artifact object (NOT yet stringified). The object is
 * intentionally timestamp-free so {@link canonicalStringify} yields byte-identical
 * output for identical inputs (idempotency / drift, T8.3).
 *
 * @param {object} options
 * @param {object}   options.source         { path, format, sha256, bytes } from ingest.
 * @param {object}   options.intermediate   Extraction intermediate (embedded for reversibility).
 * @param {JsonLd['@context']} [options.context]
 * @param {string}   [options.title]
 * @returns {object} artifact
 */
export function buildArtifact(options = {}) {
  const { source, intermediate, context = DEFAULT_CONTEXT, title } = options;
  if (!source || !source.path) throw new Error('buildArtifact requires source.path.');
  const { nodes, edges, graph } = normalizeExtraction(intermediate, {
    sourceRef: source.path,
    context,
  });

  return {
    '@context': context,
    '@graph': graph,
    '@edges': graph.filter((m) => m['@type'] === 'Relationship'),
    kbx: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      generator: GENERATOR,
      title: title ?? source.title ?? source.path,
      source: {
        path: source.path,
        format: source.format ?? null,
        sha256: source.sha256 ?? null,
        bytes: source.bytes ?? null,
      },
      nodes,
      edges,
      // Embedded intermediate makes the artifact self-contained: enables
      // idempotent re-emit (reuse without re-calling the LLM) and reversibility.
      extraction: {
        entities: intermediate?.entities ?? [],
        relationships: intermediate?.relationships ?? [],
      },
    },
  };
}

/**
 * Stable JSON serializer: object keys sorted recursively, 2-space indent, and a
 * trailing newline. Arrays keep insertion order. Guarantees byte-identical
 * output for structurally identical values.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}


/**
 * Validate an artifact against the F1 node-type contract. Returns a list of
 * human-readable errors (empty ⇒ valid).
 *
 * Enforced rules:
 *   - top-level `@context` present; `@graph` is an array.
 *   - each entity LD member: `@id` is a `kg://<type>/<slug>` URN (never a path),
 *     `@type` is an open lowercase key (never a path / file extension), and the
 *     `@id`'s type segment matches `@type`.
 *   - each KBNode mirrors its LD member (`entityType` === `@type`, `data` object,
 *     identity === `@id`) and is reversible (`source.ref` starts with the source path).
 *   - each edge `relation` ∈ KNOWN_RELATIONS.
 *
 * @param {object} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateArtifact(artifact) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, errors: ['artifact is not an object'] };
  }
  if (artifact['@context'] == null) push('missing @context');
  if (!Array.isArray(artifact['@graph'])) push('@graph must be an array');

  const members = Array.isArray(artifact['@graph']) ? artifact['@graph'] : [];
  const ids = new Set();
  for (const m of members) {
    if (!m || typeof m !== 'object') {
      push('@graph member is not an object');
      continue;
    }
    if (m['@type'] === 'Relationship') {
      if (!KNOWN_RELATIONS.includes(m.relation)) {
        push(`relationship "${m['@id']}" has off-taxonomy relation "${m.relation}"`);
      }
      if (!m.from?.['@id'] || !m.to?.['@id']) push(`relationship "${m['@id']}" missing from/to @id`);
      continue;
    }
    const id = m['@id'];
    const type = m['@type'];
    if (typeof id !== 'string' || !ID_RE.test(id)) push(`node @id "${id}" is not a kg://<type>/<slug> URN`);
    if (/\.[a-z0-9]+$|[\\/]/i.test(String(type))) push(`node @type "${type}" looks path-derived`);
    if (typeof type !== 'string' || !TYPE_RE.test(type)) push(`node @type "${type}" is not an open lowercase key`);
    if (typeof id === 'string' && typeof type === 'string' && ID_RE.test(id)) {
      const seg = id.slice('kg://'.length).split('/')[0];
      if (seg !== type) push(`node @id type segment "${seg}" != @type "${type}"`);
    }
    if (ids.has(id)) push(`duplicate node @id "${id}"`);
    ids.add(id);
  }

  // KBNode mirror + reversibility. Accept both 'kbx' (new) and 'kbexplorer' (legacy artifacts).
  const kb = artifact.kbx ?? artifact.kbexplorer;
  const sourcePath = kb?.source?.path;
  for (const node of Array.isArray(kb?.nodes) ? kb.nodes : []) {
    if (node.entityType !== node.jsonld?.['@type']) {
      push(`node "${node.id}" entityType "${node.entityType}" != jsonld @type "${node.jsonld?.['@type']}"`);
    }
    if (node.identity !== node.jsonld?.['@id']) push(`node "${node.id}" identity != jsonld @id`);
    if (!node.data || typeof node.data !== 'object') push(`node "${node.id}" missing data object`);
    if (sourcePath && !String(node.source?.ref ?? '').startsWith(sourcePath)) {
      push(`node "${node.id}" source.ref is not reversible to "${sourcePath}"`);
    }
  }
  for (const edge of Array.isArray(kb?.edges) ? kb.edges : []) {
    if (!KNOWN_RELATIONS.includes(edge.relation)) {
      push(`edge "${edge.id}" has off-taxonomy relation "${edge.relation}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Map a graph entity LD member back to a KBNode-shaped object (the engine's
 * consumption contract). Inverse-friendly: `source.ref` points at the origin.
 * @param {object} member  A non-Relationship `@graph` member.
 * @param {string} [sourceRef]
 * @returns {object} KBNode
 */
export function toKBNode(member, sourceRef) {
  const type = member['@type'];
  const id = member['@id'];
  const data = {};
  for (const [k, v] of Object.entries(member)) {
    if (k.startsWith('@')) continue;
    data[k] = v;
  }
  const slug = stripScheme(id).split('/')[1] ?? '';
  return {
    id,
    identity: id,
    entityType: type,
    title: member.name ?? slug,
    source: { type: 'structured', entityType: type, ref: sourceRef ? `${sourceRef}#${slug}` : undefined },
    jsonld: { ...member },
    data,
  };
}

/** Extract the `{ path, anchor }` a node was derived from (reversibility). */
export function sourceRefOf(node) {
  const ref = node?.source?.ref ?? '';
  const hash = ref.indexOf('#');
  return hash >= 0 ? { path: ref.slice(0, hash), anchor: ref.slice(hash + 1) } : { path: ref, anchor: '' };
}
