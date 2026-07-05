/**
 * kbx command surface — the single source of truth mapping CLI verbs to plugin
 * commands (PE1-F2 / #146).
 *
 * The plugin packages every kbx CLI verb as a Copilot/Claude **plugin command**
 * so a user never needs to drop to the terminal. Each command:
 *   - maps 1:1 to a `kbx <verb>` invocation,
 *   - surfaces the verb's arguments/options as help text,
 *   - carries a *scoped tool allowlist* (least privilege) expressed in the same
 *     `shell(...)`/`view`/`edit`/`write` grammar the runtime adapter consumes
 *     (see src/lib/copilot-runtime.js and anokye-labs/kbexplorer-cli#20).
 *
 * `COMMAND_SURFACE` is the canonical map. `renderCommandMarkdown()` renders one
 * entry into the Markdown command file shipped under src/assets/commands/. The
 * rendering is fully deterministic so a drift gate can re-render and compare
 * against the committed bytes (mirrors the `derive --check` pattern).
 *
 * This module is pure mapping + rendering: it contains no graph, provider, or
 * engine logic, and it never invokes a command — it only describes the surface.
 */

/**
 * Tool-allowlist tokens, in the runtime adapter's grammar. Re-exported so tests
 * and the doctor share one vocabulary.
 *   shell(<scope>)  → a scoped shell invocation (maps to Bash in Claude)
 *   view            → read files
 *   edit            → edit files in place
 *   write           → create/overwrite files
 */
export const ALLOW = Object.freeze({
  shell: (scope: string) => `shell(${scope})`,
  view: 'view',
  edit: 'edit',
  write: 'write',
});

interface CommandOption {
  flag: string;
  desc: string;
}

interface CommandEntry {
  name: string;
  summary: string;
  argumentHint?: string;
  run: string;
  needsCopilot: boolean;
  options?: CommandOption[];
  allowedTools: string[];
  notes?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * The eleven CLI verbs exposed as plugin commands, in a stable, documented
 * order. Each entry is the contract for one command file.
 *
 * Fields:
 *   name         command + verb name (file becomes <name>.md)
 *   summary      one-line description (command frontmatter `description`)
 *   argumentHint short `argument-hint` shown by the command palette
 *   run          the `kbx` invocation template (uses $ARGUMENTS passthrough)
 *   needsCopilot whether the verb shells out to `copilot -p` (fuzzy phase)
 *   options      [{ flag, desc }] surfaced as a help table in the body
 *   allowedTools the scoped tool allowlist (least privilege)
 *   notes        optional extra guidance appended to the body
 */
export const COMMAND_SURFACE = Object.freeze([
  {
    name: 'init',
    summary: 'Bootstrap kbx in this repo: install the .kbx explorer, agents/skills, and config.',
    argumentHint: '[--vendor] [--ref <branch>] [--yes]',
    run: 'kbx init $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '--template, -t <url>', desc: 'Install from a custom template repo' },
      { flag: '--ref, --branch <ref>', desc: 'Install a specific template tag or branch' },
      { flag: '--vendor, --no-submodule', desc: 'One-time copy instead of a git submodule' },
      { flag: '--yes, -y', desc: 'Non-interactive onboarding (CI / templated)' },
    ],
    allowedTools: [ALLOW.shell('kbx init'), ALLOW.shell('git'), ALLOW.write, ALLOW.edit, ALLOW.view],
    notes:
      'One-time setup. Safe to re-run; pre-fills every prompt from the git remote and branch.',
  },
  {
    name: 'generate',
    summary: 'Run the content-generation pipeline (architect → transform → writer) into content/.',
    argumentHint: '[--refresh] [--no-agent] [--dry-run]',
    run: 'kbx generate $ARGUMENTS',
    needsCopilot: true,
    options: [
      { flag: '--prompt, -p <text>', desc: 'Override the architect prompt sent to copilot' },
      { flag: '--model <model>', desc: 'Model to use (copilot --model)' },
      { flag: '--allow-tool <spec>', desc: "Scoped tool permission, repeatable (e.g. 'shell(git)')" },
      { flag: '--no-agent', desc: 'Skip the copilot step; only transform an existing catalogue' },
      { flag: '--refresh, --force', desc: 'Re-run the agent even if catalogue.json exists' },
      { flag: '--dry-run', desc: 'Print the assembled copilot command and exit' },
    ],
    allowedTools: [ALLOW.shell('kbx generate'), ALLOW.view, ALLOW.edit, ALLOW.write],
    notes:
      'Fuzzy phase: shells out to `copilot -p`. Preview the exact argv first with `--dry-run`.',
  },
  {
    name: 'derive',
    summary: 'Extract entities/relationships from .docx/prose into committed content/derived/*.jsonld.',
    argumentHint: '<source...> [--refresh] [--check]',
    run: 'kbx derive $ARGUMENTS',
    needsCopilot: true,
    options: [
      { flag: '<source...>', desc: 'One or more .docx/.md/.markdown/.txt sources' },
      { flag: '--out, -o <dir>', desc: 'Output directory for *.jsonld (default content/derived)' },
      { flag: '--check', desc: 'Drift check: non-zero exit if a committed artifact is stale' },
      { flag: '--refresh, --force', desc: 'Re-run fuzzy extraction even if a fresh artifact exists' },
      { flag: '--dry-run', desc: 'Print the assembled copilot command + planned outputs' },
    ],
    allowedTools: [ALLOW.shell('kbx derive'), ALLOW.view, ALLOW.write],
    notes:
      'Idempotent: re-emitting an unchanged source is byte-identical and never calls the LLM. ' +
      'Pass the source files (never the .jsonld outputs) to `--check`.',
  },
  {
    name: 'scaffold',
    summary: 'Create one new content/<slug>.md page with valid frontmatter.',
    argumentHint: '<slug> --cluster <id> [--parent <id>] [--title <text>]',
    run: 'kbx scaffold $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '<slug>', desc: 'Page slug (becomes content/<slug>.md)' },
      { flag: '--cluster <id>', desc: 'Cluster the new node belongs to (required)' },
      { flag: '--parent <id>', desc: 'Parent node id for hierarchy' },
      { flag: '--title <text>', desc: 'Human-readable page title' },
    ],
    allowedTools: [ALLOW.shell('kbx scaffold'), ALLOW.write, ALLOW.view],
    notes: 'Writes a skeleton only; edit the body by hand or hand off to a writer playbook.',
  },
  {
    name: 'audit',
    summary: 'CI-grade structural lint: duplicate ids, broken parents, cycles, dead connections.',
    argumentHint: '[--json]',
    run: 'kbx audit $ARGUMENTS',
    needsCopilot: false,
    options: [{ flag: '--json', desc: 'Emit machine-readable JSON for CI' }],
    allowedTools: [ALLOW.shell('kbx audit'), ALLOW.view],
    notes: 'Exits non-zero on structural errors. Deterministic — never calls Copilot.',
  },
  {
    name: 'affected',
    summary: 'Map a git diff to the content nodes that cite the changed files.',
    argumentHint: '<git-ref> [--json]',
    run: 'kbx affected $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '<git-ref>', desc: 'Git ref to diff against (e.g. HEAD~1)' },
      { flag: '--json', desc: 'Emit machine-readable JSON for tooling' },
    ],
    allowedTools: [ALLOW.shell('kbx affected'), ALLOW.shell('git'), ALLOW.view],
    notes: 'Tells you which pages to refresh after a code change.',
  },
  {
    name: 'links',
    summary: 'Soft graph-health report: orphans, weak clusters, coverage gaps (advisory).',
    argumentHint: '[--json]',
    run: 'kbx links $ARGUMENTS',
    needsCopilot: false,
    options: [{ flag: '--json', desc: 'Emit machine-readable JSON' }],
    allowedTools: [ALLOW.shell('kbx links'), ALLOW.view],
    notes: 'Advisory only — does not fail the build.',
  },
  {
    name: 'search',
    summary: 'Semantic search over the knowledge graph.',
    argumentHint: '<query> [--json]',
    run: 'kbx search $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '<query>', desc: 'Free-text query' },
      { flag: '--json', desc: 'Emit machine-readable JSON' },
    ],
    allowedTools: [ALLOW.shell('kbx search'), ALLOW.view],
    notes: 'Requires search artifacts; build them first with `kbx search-index`.',
  },
  {
    name: 'dev',
    summary: 'Start the kbx dev server in local mode (regenerates the manifest, then Vite).',
    argumentHint: '[--no-watch] [--host] [--port <n>]',
    run: 'kbx dev $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '--no-watch', desc: "Don't watch host content for changes (one-shot manifest)" },
      { flag: '(passthrough)', desc: 'Other args are forwarded to Vite (e.g. --host, --port)' },
    ],
    allowedTools: [ALLOW.shell('kbx dev')],
    notes: 'Long-running. Requires `.kbx/` (run the init command first).',
  },
  {
    name: 'build',
    summary: 'Production build of the knowledge base into dist/kb/.',
    argumentHint: '[--base <path>]',
    run: 'kbx build $ARGUMENTS',
    needsCopilot: false,
    options: [{ flag: '--base <path>', desc: 'Public base path for the built site' }],
    allowedTools: [ALLOW.shell('kbx build'), ALLOW.view],
    notes: 'Requires `.kbx/` (run the init command first).',
  },
  {
    name: 'doctor',
    summary: 'Diagnose runtime, MCP, template setup, plugin bundle, and adoption readiness.',
    argumentHint: '[--runtime <name>] [--json] [--offline]',
    run: 'kbx doctor $ARGUMENTS',
    needsCopilot: false,
    options: [
      { flag: '--runtime <name>', desc: 'Check a specific adapter ("copilot" | "claude" | "custom")' },
      { flag: '--json', desc: 'Emit machine-readable JSON' },
      { flag: '--offline', desc: 'Skip network-dependent checks (latest tag lookup)' },
    ],
    allowedTools: [ALLOW.shell('kbx doctor'), ALLOW.view],
    notes: 'Read-only diagnostics — safe to run anytime.',
  },
]);

/** Look up a single command entry by name. Returns undefined if not present. */
export function getCommand(name: string): CommandEntry | undefined {
  return COMMAND_SURFACE.find((c) => c.name === name);
}

/** The canonical command names, in surface order. */
export function commandNames() {
  return COMMAND_SURFACE.map((c) => c.name);
}

/**
 * Validate one command entry's shape and allowlist. Returns { valid, errors }.
 * Enforced invariants:
 *   - every entry has a name, summary, run template and a non-empty allowlist,
 *   - the run template invokes the verb it is named after,
 *   - the allowlist scopes a `shell(kbx <name>)` token (least-privilege anchor),
 *   - every allow token is a recognized grammar token.
 */
const ALLOW_TOKEN_RE = /^(?:shell\([^)]+\)|view|edit|write)$/;

export function validateCommand(entry: unknown): ValidationResult {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['entry is not an object'] };
  }
  const command = entry as Partial<CommandEntry>;
  for (const field of ['name', 'summary', 'run']) {
    const value = command[field as keyof CommandEntry];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`missing or empty required field: ${field}`);
    }
  }
  if (typeof command.run === 'string' && typeof command.name === 'string') {
    if (!command.run.startsWith(`kbx ${command.name}`)) {
      errors.push(`run template "${command.run}" must invoke "kbx ${command.name}"`);
    }
  }
  const allow = Array.isArray(command.allowedTools) ? command.allowedTools : [];
  if (allow.length === 0) {
    errors.push('allowedTools must be a non-empty scoped allowlist');
  }
  for (const tok of allow) {
    if (!ALLOW_TOKEN_RE.test(tok)) errors.push(`unrecognized allow token: ${tok}`);
  }
  if (typeof command.name === 'string' && !allow.includes(`shell(kbx ${command.name})`)) {
    errors.push(`allowlist must anchor on shell(kbx ${command.name})`);
  }
  return { valid: errors.length === 0, errors };
}

/** Validate the whole surface. Returns { valid, errors }. */
export function validateSurface(surface: readonly CommandEntry[] = COMMAND_SURFACE): ValidationResult {
  const errors = [];
  const seen = new Set();
  for (const entry of surface) {
    if (seen.has(entry.name)) errors.push(`duplicate command name: ${entry.name}`);
    seen.add(entry.name);
    const v = validateCommand(entry);
    if (!v.valid) errors.push(...v.errors.map((e) => `${entry.name}: ${e}`));
  }
  return { valid: errors.length === 0, errors };
}

// ── Markdown rendering ───────────────────────────────────────────────────────────

function yamlList(items: string[]): string {
  return items.map((i: string) => `  - ${i}`).join('\n');
}

/**
 * Render one command entry into its Markdown command file. Deterministic: the
 * same entry always yields byte-identical output (LF line endings, trailing
 * newline) so it can be diff-checked against the committed asset.
 */
export function renderCommandMarkdown(entry: CommandEntry): string {
  const v = validateCommand(entry);
  if (!v.valid) {
    throw new Error(`cannot render invalid command "${entry?.name}": ${v.errors.join('; ')}`);
  }

  const fm = [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.summary}`,
    `argument-hint: ${entry.argumentHint ?? ''}`,
    'allowed-tools:',
    yamlList(entry.allowedTools),
    '---',
  ].join('\n');

  const optionRows = (entry.options ?? [])
    .map((o: CommandOption) => `| \`${o.flag}\` | ${o.desc} |`)
    .join('\n');

  const body = [
    `# /${entry.name}`,
    '',
    entry.summary,
    '',
    `Runs \`${entry.run}\`, forwarding any arguments you provide. ` +
      (entry.needsCopilot
        ? 'This verb shells out to `copilot -p` for its fuzzy phase.'
        : 'This verb is deterministic and never calls Copilot.'),
    '',
    '## Arguments',
    '',
    '| Argument | Description |',
    '| --- | --- |',
    optionRows || '| _(none)_ | This command takes no arguments. |',
    '',
    '## Allowed tools',
    '',
    'This command runs under a scoped, least-privilege tool allowlist:',
    '',
    ...entry.allowedTools.map((t: string) => `- \`${t}\``),
  ];

  if (entry.notes) {
    body.push('', '## Notes', '', entry.notes);
  }

  body.push('', '## Run', '', '```sh', entry.run, '```');

  return `${fm}\n\n${body.join('\n')}\n`;
}

/** Render every command. Returns [{ name, file, content }]. */
export function renderAllCommands(surface: readonly CommandEntry[] = COMMAND_SURFACE) {
  return surface.map((entry: CommandEntry) => ({
    name: entry.name,
    file: `${entry.name}.md`,
    content: renderCommandMarkdown(entry),
  }));
}
