/**
 * kbx plugin — install or share the kbx Copilot plugin bundle.
 *
 * Subcommands:
 *   install [--scope project|user|session]   Assemble the bundle at a scope root.
 *   share                                    Validate + print the gist-share payload.
 *   resolve                                  Report where each component resolves.
 *
 * The bundle aggregates the kbx command surface, agents, the kbx skill, and the
 * kbexplorer canvas extension into one installable plugin. This command is pure
 * packaging — it adds no graph, provider, or engine behavior.
 */

import {
  SCOPES,
  PLUGIN_NAME,
  resolveScopeRoot,
  resolveBundle,
  assembleBundle,
  gistShareManifest,
} from '../lib/plugin-bundle.ts';
import { parsePluginArgs as parseSharedPluginArgs } from '../lib/args.ts';

function parsePluginArgs(args = []) {
  const out = parseSharedPluginArgs(args);
  return {
    sub: out.sub ?? null,
    scope: out.scope ?? 'project',
    sessionDir: out.sessionDir ?? null,
    json: out.json ?? false,
    help: out.help ?? false,
    _: out._ ?? [],
  };
}

const USAGE = `
  kbx plugin — install or share the kbx Copilot plugin bundle

  Usage: kbx plugin <subcommand> [options]

  Subcommands:
    install            Assemble the bundle at a scope root
    share              Validate + print the gist-share payload (copilot-extension.json)
    resolve            Report where each bundle component resolves

  install options:
    --scope, -s <s>    project | user | session  (default: project)
    --session-dir <d>  Session state dir for --scope session
    --json             Emit machine-readable JSON

  Scopes:
    project   <repo>/.github/plugins/${PLUGIN_NAME}
    user      ~/.copilot/plugins/${PLUGIN_NAME}
    session   <session-dir>/plugins/${PLUGIN_NAME}
`;

export default async function plugin(args, { cwd: cwdOverride, env: envOverride } = {}) {
  const opts = parsePluginArgs(args);
  const cwd = cwdOverride ?? process.cwd();
  const env = envOverride ?? process.env;

  if (opts.help || !opts.sub) {
    console.log(USAGE);
    return;
  }

  if (opts.sub === 'resolve') {
    const { ok, components } = resolveBundle();
    if (opts.json) {
      console.log(JSON.stringify({ ok, components }, null, 2));
    } else {
      for (const c of components) {
        const mark = c.exists ? '✓' : c.required ? '✗' : '○';
        const note = !c.exists && c.pending ? ` (pending ${c.pending})` : '';
        console.log(`  ${mark} ${c.label}${note}`);
      }
    }
    if (!ok) process.exitCode = 1;
    return;
  }

  if (opts.sub === 'share') {
    const result = gistShareManifest();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log('✓ Bundle is shareable via gist (copilot-extension.json valid).\n');
      console.log(JSON.stringify(result.descriptor, null, 2));
    } else {
      console.error('✗ Bundle cannot be shared via gist:');
      for (const e of result.errors) console.error(`  - ${e}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (opts.sub === 'install') {
    const scope = opts.scope;
    if (!SCOPES.includes(scope)) {
      console.error(`Unknown scope "${scope}". Expected one of: ${SCOPES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    let destRoot;
    try {
      destRoot = resolveScopeRoot(scope, {
        cwd,
        home: env.HOME || env.USERPROFILE,
        sessionDir: opts.sessionDir || env.COPILOT_SESSION_STATE_DIR,
      });
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = assembleBundle(destRoot);
    } catch (err) {
      console.error(`✗ Install failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ scope, destRoot, ...result }, null, 2));
    } else {
      console.log(`✓ Installed kbx plugin (${scope} scope) → ${destRoot}`);
      console.log(`  components: ${result.installed.join(', ')}`);
      for (const s of result.skipped) {
        console.log(`  skipped ${s.id} (${s.reason})`);
      }
    }
    return;
  }

  console.error(`Unknown plugin subcommand: ${opts.sub}`);
  console.error('Run "kbx plugin --help" for usage.');
  process.exitCode = 1;
}

export { parsePluginArgs };
