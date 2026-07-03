export { parseArgs, parseInitArgs, parseGenerateArgs, parseDeriveArgs, parseUpdateArgs, parseDoctorArgs } from './args.ts';
import { parseArgs } from './args.ts';

export function parseAffectedArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { json: false, ref: 'HEAD', content: null, graph: null, since: 'HEAD', unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'graph', aliases: ['--graph'], type: 'value' },
       { name: 'since', aliases: ['--since'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.ref = out.positionals[0] ?? out.ref;
  return out;
}

export function parseAuditArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, content: null, unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'content', aliases: ['--content'], type: 'value' },
     ],
   },
   args,
  );
}

export function parseBuildArgs(args = []) {
  return parseArgs(
   {
     defaults: { base: null, unknown: [] },
     options: [{ name: 'base', aliases: ['--base'], type: 'value' }],
   },
   args,
  );
}

export function parseConnectArgs(args = []) {
  const out = { check: false, help: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) out.unknown.push(arg);
  }
  return out;
}

export function parseDevArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { noWatch: false, viteArgs: [], unknown: [] },
     options: [{ name: 'noWatch', aliases: ['--no-watch'], type: 'boolean' }],
     collectUnknown: false,
   },
   args,
  );
  out.viteArgs = args.filter((arg) => arg !== '--no-watch');
  return out;
}

export function parseLinksArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, unknown: [] },
     options: [{ name: 'json', aliases: ['--json'], type: 'boolean' }],
   },
   args,
  );
}

export function parseManifestArgs(args = []) {
  return parseArgs({ defaults: { unknown: [] }, options: [] }, args);
}

export function parseMcpArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { help: false, allow: false, skipPreflight: false, name: undefined, unknown: [] },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'allow', aliases: ['--allow'], type: 'boolean' },
       { name: 'skipPreflight', aliases: ['--skip-preflight'], type: 'boolean' },
       { name: 'name', aliases: ['--name'], type: 'value' },
     ],
   },
   args,
  );
  out.name = out.name ?? undefined;
  return out;
}

export function parsePluginArgs(args = []) {
  const out = parseArgs(
   {
     defaults: { sub: null, scope: 'project', sessionDir: null, json: false, help: false, unknown: [] },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'scope', aliases: ['--scope', '-s'], type: 'value' },
       { name: 'sessionDir', aliases: ['--session-dir'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.sub = out.positionals[0] ?? null;
  out._ = out.positionals.slice(1);
  return out;
}

export function parseScaffoldArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       slug: null,
       cluster: null,
       parent: null,
       title: null,
       emoji: null,
       content: null,
       force: false,
       unknown: [],
     },
     options: [
       { name: 'cluster', aliases: ['--cluster'], type: 'value' },
       { name: 'parent', aliases: ['--parent'], type: 'value' },
       { name: 'title', aliases: ['--title'], type: 'value' },
       { name: 'emoji', aliases: ['--emoji'], type: 'value' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'force', aliases: ['--force', '-f'], type: 'boolean' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.slug = out.positionals[0] ?? null;
  return out;
}

export function parseSearchIndexArgs(args = []) {
  return parseArgs(
   {
     defaults: {
       check: false,
       dryRun: false,
       help: false,
       json: false,
       dir: null,
       provider: null,
       model: null,
       content: null,
       batchSize: null,
       unknown: [],
     },
     options: [
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'dryRun', aliases: ['--dry-run'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'dir', aliases: ['--dir'], type: 'value' },
       { name: 'provider', aliases: ['--provider'], type: 'value' },
       { name: 'model', aliases: ['--model'], type: 'value' },
       { name: 'content', aliases: ['--content'], type: 'value' },
       { name: 'batchSize', aliases: ['--batch-size'], type: 'number' },
     ],
   },
   args,
  );
}

export function parseSearchArgs(args = []) {
  const out = parseArgs(
   {
     defaults: {
       query: null,
       help: false,
       json: false,
       limit: null,
       cluster: null,
       entityType: null,
       minScore: null,
       dir: null,
       provider: null,
       model: null,
       unknown: [],
     },
     options: [
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'limit', aliases: ['--limit'], type: 'number' },
       { name: 'cluster', aliases: ['--cluster'], type: 'value' },
       { name: 'entityType', aliases: ['--entity-type'], type: 'value' },
       { name: 'minScore', aliases: ['--min-score'], type: 'number' },
       { name: 'dir', aliases: ['--dir'], type: 'value' },
       { name: 'provider', aliases: ['--provider'], type: 'value' },
       { name: 'model', aliases: ['--model'], type: 'value' },
     ],
     positionals: 'positionals',
   },
   args,
  );
  out.query = out.positionals.join(' ') || null;
  return out;
}

export function parseSyncArgs(args = []) {
  return parseArgs(
   {
     defaults: { check: false, json: false, graph: '.kbx/connection/composite-graph.json', since: 'HEAD', against: null, help: false, unknown: [] },
     options: [
       { name: 'check', aliases: ['--check'], type: 'boolean' },
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'graph', aliases: ['--graph'], type: 'value' },
       { name: 'since', aliases: ['--since'], type: 'value' },
       { name: 'against', aliases: ['--against'], type: 'value' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
     ],
   },
   args,
  );
}

export function parseValidateArgs(args = []) {
  return parseArgs(
   {
     defaults: { json: false, dir: null, help: false, unknown: [] },
     options: [
       { name: 'json', aliases: ['--json'], type: 'boolean' },
       { name: 'help', aliases: ['--help', '-h'], type: 'boolean' },
       { name: 'dir', aliases: ['--content-model', '--dir'], type: 'value' },
     ],
   },
   args,
  );
}
