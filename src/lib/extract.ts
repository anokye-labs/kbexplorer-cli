/**
 * Fuzzy extraction (T8.1).
 *
 * Turns an ingested {@link module:lib/ingest~Document} into a structured
 * *extraction intermediate* — `{ entities[], relationships[] }` — by prompting
 * GitHub Copilot through the F7 programmatic-mode runtime
 * ({@link module:lib/copilot-runtime~runCopilot}). The LLM does the fuzzy work
 * (recognizing people, teams, systems and how they relate in prose / docx); a
 * deterministic step ({@link module:lib/jsonld}) then normalizes and validates
 * the result into F1-contract JSON-LD.
 *
 * The runtime is injectable (`run`) so the whole path is hermetically testable
 * with no live LLM — the default is `runCopilot`.
 *
 * ── Public API ──
 *   RELATION_VOCABULARY                          the 6-relation taxonomy hint.
 *   buildExtractionPrompt(document, opts?) -> string
 *   parseExtraction(text)                  -> { entities[], relationships[] }
 *   extractEntities(opts)                  -> Promise<{ entities[], relationships[], raw }>
 *   ExtractionError                              actionable error with `.code`.
 */

import { runRuntimeTask, copilotAdapter } from './copilot-runtime.ts';

/** The 6-relation taxonomy the model is asked to map relationships onto. */
export const RELATION_VOCABULARY = Object.freeze([
  'leads',
  'staffs',
  'reports-to',
  'structural',
  'derived',
  'deprecated',
]);

export const ExtractionErrorCode = Object.freeze({
  EMPTY_RESPONSE: 'EXTRACT_EMPTY_RESPONSE',
  INVALID_JSON: 'EXTRACT_INVALID_JSON',
  INVALID_SHAPE: 'EXTRACT_INVALID_SHAPE',
});

/** Error thrown when the model output cannot be turned into a valid intermediate. */
export class ExtractionError extends Error {
  constructor(message, { code = ExtractionErrorCode.INVALID_SHAPE, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

/**
 * Build the extraction prompt. Instructs the model to emit a single strict JSON
 * object describing entities and their relationships — and nothing else — so the
 * downstream parser is robust.
 *
 * @param {object} document  An ingested Document (see lib/ingest).
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function buildExtractionPrompt(document, options = {}) {
  const maxChars = options.maxChars ?? 24_000;
  const text = String(document?.text ?? '');
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;

  return [
    'You are a precise information-extraction engine. Read the SOURCE DOCUMENT',
    'below and extract the entities (people, teams, systems, components,',
    'documents, concepts) and the relationships between them.',
    '',
    'Respond with EXACTLY ONE JSON object and NOTHING else — no prose, no code',
    'fences. The object MUST match this shape:',
    '{',
    '  "entities": [',
    '    { "id": "<stable kebab-case id>", "type": "<kind e.g. person|team|system|component|document|concept>",',
    '      "name": "<display name>", "properties": { "<key>": "<value>", ... } }',
    '  ],',
    '  "relationships": [',
    '    { "from": "<entity id or name>", "to": "<entity id or name>",',
    `      "type": "<one of: ${RELATION_VOCABULARY.join(' | ')}>", "label": "<optional human label>" }`,
    '  ]',
    '}',
    '',
    'Rules:',
    `- "type" on relationships MUST be one of: ${RELATION_VOCABULARY.join(', ')}.`,
    '  Use "structural" for generic part-of / contains / association links.',
    '- "type" on entities is an open lowercase kebab-case kind; NEVER derive it from a file path.',
    '- Prefer reusing a short stable "id"; if unsure, omit "id" and a slug of "name" is used.',
    '- Only include entities/relationships actually supported by the text. Omit empty arrays members.',
    '- Do not invent identifiers, emails, or titles that are not present.',
    '',
    `SOURCE DOCUMENT (title: ${document?.title ?? 'untitled'}, format: ${document?.format ?? 'text'}):`,
    '"""',
    body,
    '"""',
  ].join('\n');
}

/**
 * Tolerantly parse the model's response into an extraction intermediate.
 * Handles code fences and surrounding prose by extracting the outermost JSON
 * object. Validates the coarse shape and normalizes to arrays.
 *
 * @param {string} text
 * @returns {{ entities: object[], relationships: object[] }}
 * @throws {ExtractionError} EMPTY_RESPONSE | INVALID_JSON | INVALID_SHAPE
 */
export function parseExtraction(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    throw new ExtractionError('Extraction produced an empty response.', {
      code: ExtractionErrorCode.EMPTY_RESPONSE,
    });
  }

  const candidate = extractJsonObject(raw);
  if (candidate == null) {
    throw new ExtractionError(
      `Extraction response did not contain a JSON object.\n--- response ---\n${raw.slice(0, 500)}`,
      { code: ExtractionErrorCode.INVALID_JSON },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new ExtractionError(`Extraction response was not valid JSON: ${err.message}`, {
      code: ExtractionErrorCode.INVALID_JSON,
      cause: err,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtractionError('Extraction JSON must be an object with entities/relationships.', {
      code: ExtractionErrorCode.INVALID_SHAPE,
    });
  }

  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relationships = Array.isArray(parsed.relationships)
    ? parsed.relationships
    : Array.isArray(parsed.edges)
      ? parsed.edges
      : [];

  if (entities.length === 0) {
    throw new ExtractionError(
      'Extraction produced no entities. The source may lack recognizable entities, ' +
        'or the model output was malformed.',
      { code: ExtractionErrorCode.INVALID_SHAPE },
    );
  }

  return { entities, relationships };
}

/** Strip ```json fences and isolate the first balanced top-level {...} object. */
function extractJsonObject(text) {
  let s = text.trim();
  const fence = s.match(/```(?:json|jsonld)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Run fuzzy extraction over an ingested document via the Copilot runtime.
 *
 * @param {object} options
 * @param {object}   options.document               Ingested Document (lib/ingest).
 * @param {Function} [options.run=runRuntimeTask]   Runtime fn returning a RuntimeResult.
 *        Injected in tests to avoid a live LLM.
 * @param {object}   [options.runtimeOptions]       Extra options merged into the run call
 *        (model, timeoutMs, allowTools, cwd, binary/binaryArgs/spawn for tests…).
 * @param {number}   [options.maxChars]             Prompt truncation budget.
 * @returns {Promise<{ entities: object[], relationships: object[], raw: string }>}
 */
export async function extractEntities(options = {}) {
  const { document, run = runRuntimeTask, runtimeOptions = {}, maxChars } = options;
  if (!document || typeof document.text !== 'string') {
    throw new ExtractionError('extractEntities requires an ingested document with text.', {
      code: ExtractionErrorCode.INVALID_SHAPE,
    });
  }

  const prompt = buildExtractionPrompt(document, { maxChars });
  const { adapter = copilotAdapter, ...runtime } = runtimeOptions;
  const result = await run({
    adapter,
    prompt,
    outputFormat: 'json',
    silent: true,
    noColor: true,
    ...runtime,
  });

  const responseText = pickResponseText(result);
  const intermediate = parseExtraction(responseText);
  return { ...intermediate, raw: responseText };
}

/** Pull the assistant text out of a RuntimeResult (or accept a bare string). */
function pickResponseText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.response === 'string' && result.response.trim()) return result.response;
    if (typeof result.stdout === 'string') return result.stdout;
  }
  return '';
}
