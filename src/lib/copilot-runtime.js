import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

/**
 * Programmatic runtime adapters for fuzzy tasks.
 *
 * Public API:
 *   - createCopilotAdapter(), createClaudeAdapter(), createCustomAdapter()
 *   - runRuntimeTask(options)
 *   - runCopilot(options) // backward-compatible alias
 *   - resolveBinary(), isAdapterAvailable(), isCopilotAvailable()
 *   - RuntimeAdapterError / CopilotRuntimeError / RuntimeErrorCode
 */

export const DEFAULT_COPILOT_BINARY = 'copilot';
export const DEFAULT_CLAUDE_BINARY = 'claude';

/** Environment variable that, when set, overrides the resolved Copilot binary path. */
export const COPILOT_BIN_ENV = 'KBX_COPILOT_BIN';
/** Environment variable that, when set, overrides the resolved Claude binary path. */
export const CLAUDE_BIN_ENV = 'KBX_CLAUDE_BIN';

/** Default time budget for a single programmatic run (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Stable error codes attached to runtime errors. */
export const RuntimeErrorCode = Object.freeze({
  BINARY_MISSING: 'COPILOT_BINARY_MISSING',
  TIMEOUT: 'COPILOT_TIMEOUT',
  NONZERO_EXIT: 'COPILOT_NONZERO_EXIT',
  SPAWN_FAILED: 'COPILOT_SPAWN_FAILED',
  INVALID_INPUT: 'COPILOT_INVALID_INPUT',
});

/** Error thrown by runtime adapters. */
export class RuntimeAdapterError extends Error {
  constructor(message, { code = RuntimeErrorCode.SPAWN_FAILED, exitCode = null, result = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeAdapterError';
    this.code = code;
    this.exitCode = exitCode;
    this.result = result;
  }
}

/** Backwards-compatible alias for existing callers/tests. */
export class CopilotRuntimeError extends RuntimeAdapterError {
  constructor(message, info) {
    super(message, info);
    this.name = 'CopilotRuntimeError';
  }
}

/** Map of new env var names to their deprecated predecessors. */
const LEGACY_ENV_MAP = {
  KBX_COPILOT_BIN: 'KBEXPLORER_COPILOT_BIN',
  KBX_CLAUDE_BIN: 'KBEXPLORER_CLAUDE_BIN',
};

export function resolveBinary(options = {}) {
  const env = options.env ?? process.env;
  const envVar = options.envVar;
  let envVal = envVar ? env[envVar] : undefined;
  if (!envVal && envVar && LEGACY_ENV_MAP[envVar]) {
    const legacyVar = LEGACY_ENV_MAP[envVar];
    const legacyVal = env[legacyVar];
    if (legacyVal) {
      process.stderr.write(`[kbx] ${legacyVar} is deprecated; rename to ${envVar}\n`);
      envVal = legacyVal;
    }
  }
  return options.binary || envVal || options.defaultBinary || DEFAULT_COPILOT_BINARY;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Build argv for `copilot -p`.
 *
 * @param {object} [options]
 * @param {string} options.prompt
 * @param {string|string[]} [options.allowTools]
 * @param {string|string[]} [options.denyTools]
 * @param {boolean} [options.allowAllTools=false]
 * @param {boolean} [options.allowAll=false]
 * @param {string} [options.model]
 * @param {string} [options.outputFormat]
 * @param {boolean} [options.silent=false]
 * @param {boolean} [options.noColor=true]
 * @param {string|string[]} [options.addDirs]
 * @param {string} [options.logLevel]
 * @param {string|string[]} [options.extraArgs]
 * @returns {string[]}
 */
export function buildCopilotArgs(options = {}) {
  const {
    prompt,
    allowTools,
    denyTools,
    allowAllTools = false,
    allowAll = false,
    model,
    outputFormat,
    silent = false,
    noColor = true,
    addDirs,
    logLevel,
    extraArgs,
  } = options;

  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new CopilotRuntimeError('A non-empty `prompt` is required to build copilot args.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }

  const args = ['-p', prompt];
  if (allowAll) args.push('--allow-all');
  if (allowAllTools) args.push('--allow-all-tools');
  for (const spec of asArray(allowTools)) args.push(`--allow-tool=${spec}`);
  for (const spec of asArray(denyTools)) args.push(`--deny-tool=${spec}`);
  if (model) args.push('--model', model);
  if (outputFormat) args.push('--output-format', outputFormat);
  if (silent) args.push('-s');
  if (noColor) args.push('--no-color');
  for (const dir of asArray(addDirs)) args.push('--add-dir', dir);
  if (logLevel) args.push('--log-level', logLevel);
  for (const extra of asArray(extraArgs)) args.push(extra);
  return args;
}

function normalizeClaudeTool(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return null;
  const match = text.match(/^([a-z_]+)(?:\((.*)\))?$/i);
  const kind = (match?.[1] ?? text).toLowerCase();
  const scope = match?.[2];
  const mapped = {
    shell: 'Bash',
    write: 'Write',
    edit: 'Edit',
    create: 'Write',
    view: 'Read',
    read: 'Read',
    rg: 'Grep',
    grep: 'Grep',
    glob: 'Glob',
    web_fetch: 'WebFetch',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
  }[kind] ?? kind;
  if (!scope) return mapped;
  if (mapped === 'Bash') {
    // Copilot scope semantics are prefix-oriented (shell(git)); Claude Bash scopes
    // are command patterns, so widen to prefix pattern form (Bash(git:*)).
    return scope.includes(':') ? `${mapped}(${scope})` : `${mapped}(${scope}:*)`;
  }
  return `${mapped}(${scope})`;
}

export function buildClaudeArgs(options = {}) {
  const {
    prompt,
    allowTools,
    denyTools,
    allowAllTools = false,
    allowAll = false,
    model,
    addDirs,
    extraArgs,
  } = options;

  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new RuntimeAdapterError('A non-empty `prompt` is required to build claude args.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }

  const args = ['-p', prompt, '--output-format', 'json'];
  // Claude has real equivalents for copilot's permission flags — map rather
  // than refuse: `--allow-all-tools`/`--allow-all` → --dangerously-skip-permissions,
  // `--deny-tool` → --disallowedTools. derive's default runtime options set
  // allowAllTools, so refusing here would make the adapter unusable.
  if (allowAll || allowAllTools) args.push('--dangerously-skip-permissions');
  const allowedTools = asArray(allowTools).map(normalizeClaudeTool).filter(Boolean);
  if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  const disallowedTools = asArray(denyTools).map(normalizeClaudeTool).filter(Boolean);
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));
  if (model) args.push('--model', model);
  for (const dir of asArray(addDirs)) args.push('--add-dir', dir);
  for (const extra of asArray(extraArgs)) args.push(extra);
  return args;
}

function interpolateTemplate(token, values) {
  return String(token).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => (values[key] ?? ''));
}

export function buildCustomArgs(options = {}) {
  const {
    prompt,
    argsTemplate = ['{prompt}'],
    allowTools,
    denyTools,
    allowAllTools = false,
    allowAll = false,
  } = options;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new RuntimeAdapterError('A non-empty `prompt` is required to build custom runtime args.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (allowAllTools || allowAll) {
    throw new RuntimeAdapterError(`Custom adapter does not support \`${allowAllTools ? 'allowAllTools' : 'allowAll'}\`.`, {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (asArray(allowTools).filter(Boolean).length > 0) {
    throw new RuntimeAdapterError('Custom adapter does not support `allowTools`.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (asArray(denyTools).filter(Boolean).length > 0) {
    throw new RuntimeAdapterError('Custom adapter does not support `denyTools`.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  return asArray(argsTemplate).map((token) => interpolateTemplate(token, options));
}

export function parseJsonl(text) {
  if (!text) return [];
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return events;
}

function pickText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content?.text === 'string') return value.content.text;
    if (typeof value.content === 'string') return value.content;
    // Claude `--output-format json` terminal payload includes `type: "result"` + `result`.
    if (typeof value.result === 'string') return value.result;
    if (value.content != null) return pickText(value.content);
    if (value.delta != null) return pickText(value.delta);
    if (value.message != null) return pickText(value.message);
  }
  return '';
}

export function extractResponseText(events, rawStdout = '') {
  const parts = [];
  for (const ev of events ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type ?? ev.event ?? ev.role ?? '').toLowerCase();
    const looksAssistant =
      type.includes('assistant') ||
      type.includes('response') ||
      type.includes('message') ||
      type.includes('completion') ||
      type.includes('text') ||
      type.includes('delta') ||
      type === 'result';
    if (!looksAssistant) continue;
    const text = pickText(ev.text ?? ev.content ?? ev.message ?? ev.delta ?? ev.result ?? ev);
    if (text) parts.push(text);
  }
  const joined = parts.join('').trim();
  return joined || String(rawStdout ?? '').trim();
}

function defaultParseOutput(stdout, _stderr, options = {}) {
  const format = options.outputFormat;
  const wantsJsonl = format === 'json' || format === 'jsonl' || format === 'stream-json';
  const events = wantsJsonl ? parseJsonl(stdout) : [];
  return { response: extractResponseText(events, stdout), events };
}

function parseClaudeOutput(stdout, stderr, task = {}) {
  // Keep stream-json parsing for compatibility with callers that still request it.
  if (task.outputFormat === 'stream-json') {
    return defaultParseOutput(stdout, stderr, { ...task, outputFormat: 'stream-json' });
  }

  const text = String(stdout ?? '').trim();
  if (!text) return { response: '', events: [] };
  try {
    const parsed = JSON.parse(text);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    return { response: extractResponseText(events, stdout), events };
  } catch {
    return defaultParseOutput(stdout, stderr, { ...task, outputFormat: 'jsonl' });
  }
}

export function createCopilotAdapter() {
  return {
    name: 'copilot',
    defaultBinary: DEFAULT_COPILOT_BINARY,
    binaryEnv: COPILOT_BIN_ENV,
    installUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
    buildArgs: (task) => buildCopilotArgs(task),
    parseOutput: (stdout, stderr, task) => defaultParseOutput(stdout, stderr, task),
    isAvailable: (options = {}) =>
      probeBinary({
        ...options,
        envVar: COPILOT_BIN_ENV,
        defaultBinary: DEFAULT_COPILOT_BINARY,
      }),
    capabilities: Object.freeze({
      toolAllowlist: true,
      toolDenylist: true,
      allowAllTools: true,
      allowAll: true,
      structuredOutput: true,
      stdinInput: true,
    }),
  };
}

export function createClaudeAdapter() {
  return {
    name: 'claude',
    defaultBinary: DEFAULT_CLAUDE_BINARY,
    binaryEnv: CLAUDE_BIN_ENV,
    installUrl: 'https://claude.ai/code',
    buildArgs: (task) => buildClaudeArgs(task),
    parseOutput: (stdout, stderr, task) => parseClaudeOutput(stdout, stderr, { ...task, outputFormat: 'json' }),
    isAvailable: (options = {}) =>
      probeBinary({
        ...options,
        envVar: CLAUDE_BIN_ENV,
        defaultBinary: DEFAULT_CLAUDE_BINARY,
      }),
    // denyTools → --disallowedTools; allowAllTools/allowAll →
    // --dangerously-skip-permissions (see buildClaudeArgs).
    capabilities: Object.freeze({
      toolAllowlist: true,
      toolDenylist: true,
      allowAllTools: true,
      allowAll: true,
      structuredOutput: true,
      stdinInput: false,
    }),
  };
}

export function createCustomAdapter(config = {}) {
  const outputFormat = config.outputFormat ?? 'text';
  return {
    name: config.name || 'custom',
    defaultBinary: config.defaultBinary,
    binaryEnv: config.binaryEnv,
    buildArgs: (task) => buildCustomArgs({ argsTemplate: config.argsTemplate, ...task }),
    parseOutput: (stdout, stderr, task) =>
      defaultParseOutput(stdout, stderr, { ...task, outputFormat: task?.outputFormat ?? outputFormat }),
    isAvailable: (options = {}) =>
      probeBinary({
        ...options,
        envVar: config.binaryEnv,
        defaultBinary: config.defaultBinary,
      }),
    capabilities: Object.freeze({
      toolAllowlist: false,
      toolDenylist: false,
      allowAllTools: false,
      allowAll: false,
      structuredOutput: outputFormat === 'jsonl',
      stdinInput: false,
    }),
  };
}

export const copilotAdapter = createCopilotAdapter();
export const claudeAdapter = createClaudeAdapter();

export function isAdapterAvailable(adapter, options = {}) {
  if (!adapter || typeof adapter !== 'object') return false;
  if (typeof adapter.isAvailable === 'function') return adapter.isAvailable(options);
  return probeBinary({
    ...options,
    envVar: adapter.binaryEnv,
    defaultBinary: adapter.defaultBinary || adapter.name,
  });
}

export function isCopilotAvailable(options = {}) {
  return isAdapterAvailable(copilotAdapter, options);
}

function probeBinary(options = {}) {
  const spawnSyncImpl = options.spawnSync ?? nodeSpawnSync;
  const binary = resolveBinary(options);
  try {
    const res = spawnSyncImpl(binary, options.probeArgs ?? ['--version'], {
      stdio: 'ignore',
      timeout: options.timeoutMs ?? 10_000,
      shell: false,
    });
    return !!res && !res.error;
  } catch {
    return false;
  }
}

function quoteForDisplay(token) {
  return /[\s"'()]/.test(token) ? JSON.stringify(token) : token;
}

/** Extensions that require the platform shell to launch on Windows (EINVAL under shell:false). */
const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat']);
/** Extensions that Windows cannot exec directly and must be run through `node` (EFTYPE under shell:false). */
const NODE_SCRIPT_EXTENSIONS = new Set(['.mjs', '.js']);

/**
 * Quote a single argv token for cmd.exe when re-invoking through the shell.
 *
 * Node's `shell:true` path on Windows does no escaping of its own — it just
 * joins `[file, ...args]` with spaces before handing the line to cmd.exe — so
 * any token containing whitespace or a cmd.exe metacharacter must be neutralized
 * here or it will be split/interpreted (a CVE-2024-27980-shaped command
 * injection on any `.cmd`/`.bat` shim).
 *
 * Strategy (two layers, because two parsers see the line):
 *   1. **Arg boundary / the child's CommandLineToArgvW parser** — wrap in
 *      double quotes when the token has whitespace or a quote. Inside `"…"`,
 *      cmd treats `& | < > ( ) ^` LITERALLY, so wrapping already neutralizes
 *      them. Embedded quotes are doubled (`""`, the msvcrt/cmd convention), and
 *      a run of backslashes immediately before the closing quote is doubled so
 *      a trailing `\` can't escape the quote and merge with the next token.
 *   2. **cmd's own expansion — `%…%` and `!…!`** — cmd expands these even inside
 *      double quotes, so they can't be neutralized by wrapping. They are pulled
 *      OUT of the quoted segments and caret-escaped (`^%`, `^!`), which is the
 *      only escape cmd honors for them (and only outside quotes).
 *
 * SECURITY (residual, CVE-2024-27980): `^%` is best-effort. cmd performs `%VAR%`
 * expansion in an EARLIER parse phase than caret-stripping, so no command-line
 * escape fully neutralizes `%` — a determined `%`-payload can still probe the
 * environment on a Windows host. Breaking `%VAR%` into `"…"^%"…"` defeats the
 * common case, not every case. The robust mitigation is to never route
 * attacker-controlled args through cmd.exe: kbx deploys to Azure/Linux, where
 * this branch is never taken (see `resolveSpawnPlan`: win32 + `.cmd`/`.bat`
 * only). Backslash-immediately-before-an-embedded-quote (e.g. `a\"b`) is a
 * known residual of the `""` convention and is not among the launch payloads.
 */
export function quoteCmdArg(token) {
  const text = String(token ?? '');
  if (text === '') return '""';
  // Fast path: no whitespace and no cmd-relevant metacharacter → verbatim.
  if (!/[\s"^&|<>()%!]/.test(text)) return text;

  let out = '';
  let segment = '';
  const flushSegment = () => {
    if (segment === '') return;
    // Double the run of backslashes before the closing quote (CommandLineToArgvW
    // treats `\` as special only immediately before a `"`), then double embedded
    // quotes. Wrapping neutralizes cmd's `& | < > ( ) ^` for this segment.
    const trailingBackslashes = (segment.match(/\\+$/)?.[0].length) ?? 0;
    const body = segment.replace(/"/g, '""') + '\\'.repeat(trailingBackslashes);
    out += `"${body}"`;
    segment = '';
  };
  for (const ch of text) {
    if (ch === '%' || ch === '!') {
      // Pull cmd-expanded chars out of the quotes and caret-escape them.
      flushSegment();
      out += `^${ch}`;
    } else {
      segment += ch;
    }
  }
  flushSegment();
  return out;
}

/**
 * Decide how to actually invoke `binary`/`args` for the given platform.
 *
 * Pure and side-effect free (platform/execPath are injectable) so the
 * dispatch decision can be unit-tested from any host OS without touching a
 * real spawn call. See issue #66: `shell:false` cannot exec `.cmd`/`.bat`
 * shims (EINVAL) or a bare `.mjs`/`.js` file (EFTYPE) on Windows.
 *
 *   - `.cmd` / `.bat` on win32  → re-invoke via the shell (`shell: true`),
 *     with every argument pre-quoted for cmd.exe (see `quoteCmdArg`).
 *   - `.mjs` / `.js` on win32   → re-invoke as `process.execPath <script> …`.
 *   - everything else (incl. all non-win32 platforms) → unchanged.
 *
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function resolveSpawnPlan(binary, args, { platform = process.platform, execPath = process.execPath } = {}) {
  const plainArgs = asArray(args);

  if (platform !== 'win32') {
    return { command: binary, args: plainArgs, shell: false };
  }

  const ext = String(binary ?? '').match(/\.[^./\\]+$/)?.[0]?.toLowerCase() ?? '';

  if (WINDOWS_SHELL_EXTENSIONS.has(ext)) {
    return {
      command: quoteCmdArg(binary),
      args: plainArgs.map(quoteCmdArg),
      shell: true,
    };
  }

  if (NODE_SCRIPT_EXTENSIONS.has(ext)) {
    return { command: execPath, args: [binary, ...plainArgs], shell: false };
  }

  return { command: binary, args: plainArgs, shell: false };
}

/**
 * @typedef {object} RuntimeResult
 * @property {boolean} ok
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} response
 * @property {object[]} events
 * @property {string} binary
 * @property {string[]} args
 * @property {string} command
 * @property {number} durationMs
 * @property {string} adapter
 */

/**
 * Shared runtime execution path for all adapters.
 *
 * @param {object} options
 * @param {object} options.adapter
 * @returns {Promise<RuntimeResult>}
 */
export function runRuntimeTask(options = {}) {
  const {
    adapter = copilotAdapter,
    binary: binaryOverride,
    binaryArgs = [],
    cwd = process.cwd(),
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    input,
    throwOnError = true,
    spawn: spawnImpl = nodeSpawn,
    onEvent,
    errorClass = RuntimeAdapterError,
    platform = process.platform,
    ...task
  } = options;

  if (!adapter || typeof adapter.buildArgs !== 'function') {
    throw new RuntimeAdapterError('A valid runtime `adapter` with buildArgs() is required.', {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  assertTaskCapabilities(adapter, task, errorClass);

  const binary = resolveBinary({
    binary: binaryOverride,
    env,
    envVar: task.binaryEnv ?? adapter.binaryEnv,
    defaultBinary: task.defaultBinary ?? adapter.defaultBinary ?? adapter.name,
  });
  const runtimeArgs = adapter.buildArgs(task);
  const args = [...asArray(binaryArgs), ...runtimeArgs];
  const command = [binary, ...args].map(quoteForDisplay).join(' ');
  const startedAt = Date.now();
  // What actually gets spawned may differ from `binary`/`args` above (e.g. a
  // `.cmd` shim re-invoked via the shell, or a `.mjs` wrapped with `node`) —
  // see resolveSpawnPlan(). The display `command` and result fields still
  // reflect the logical binary/args so logs/errors read naturally.
  const spawnPlan = resolveSpawnPlan(binary, args, { platform });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(spawnPlan.command, spawnPlan.args, {
        cwd,
        env: env ?? process.env,
        shell: spawnPlan.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(toSpawnError(err, { binary, command, adapter, errorClass, envVar: task.binaryEnv ?? adapter.binaryEnv }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }

        finish(
          reject,
          new errorClass(
            `${titleCase(adapter.name)} run timed out after ${timeoutMs}ms: ${command}`,
            {
              code: RuntimeErrorCode.TIMEOUT,
              exitCode: null,
              result: {
                ok: false,
                exitCode: null,
                signal: 'SIGTERM',
                timedOut: true,
                stdout,
                stderr,
                response: String(stdout).trim(),
                events: [],
                binary,
                args,
                command,
                durationMs: Date.now() - startedAt,
                adapter: adapter.name,
              },
            },
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(reject, toSpawnError(err, { binary, command, adapter, errorClass, envVar: task.binaryEnv ?? adapter.binaryEnv }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;

      const parsed =
        typeof adapter.parseOutput === 'function'
          ? adapter.parseOutput(stdout, stderr, task)
          : defaultParseOutput(stdout, stderr, task);
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      if (typeof onEvent === 'function') {
        for (const ev of events) {
          try {
            onEvent(ev);
          } catch {
            /* ignore listener failures */
          }
        }
      }

      const result = {
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        response: typeof parsed?.response === 'string' ? parsed.response : extractResponseText(events, stdout),
        events,
        binary,
        args,
        command,
        durationMs: Date.now() - startedAt,
        adapter: adapter.name,
      };

      if (code !== 0 && throwOnError) {
        const detail = (stderr || stdout).trim();
        finish(
          reject,
          new errorClass(
            `${titleCase(adapter.name)} exited with code ${code}.${detail ? `\n${detail}` : ''}`,
            { code: RuntimeErrorCode.NONZERO_EXIT, exitCode: code, result },
          ),
        );
        return;
      }

      finish(resolve, result);
    });

    if (input != null && child.stdin) child.stdin.end(input);
    else if (child.stdin) child.stdin.end();
  });
}

/**
 * Backward-compatible Copilot entrypoint.
 *
 * @param {object} [options]
 * @returns {Promise<RuntimeResult>}
 */
export function runCopilot(options = {}) {
  return runRuntimeTask({
    adapter: copilotAdapter,
    errorClass: CopilotRuntimeError,
    ...options,
  });
}

function hasNonEmpty(values) {
  return asArray(values).map((v) => String(v ?? '').trim()).filter(Boolean).length > 0;
}

function assertTaskCapabilities(adapter, task, errorClass) {
  const capabilities = adapter.capabilities ?? {};
  if (task.allowAllTools && !capabilities.allowAllTools) {
    throw new errorClass(`${titleCase(adapter.name)} adapter does not support \`allowAllTools\`.`, {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (task.allowAll && !capabilities.allowAll) {
    throw new errorClass(`${titleCase(adapter.name)} adapter does not support \`allowAll\`.`, {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (hasNonEmpty(task.allowTools) && !capabilities.toolAllowlist) {
    throw new errorClass(`${titleCase(adapter.name)} adapter does not support \`allowTools\`.`, {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
  if (hasNonEmpty(task.denyTools) && !capabilities.toolDenylist) {
    throw new errorClass(`${titleCase(adapter.name)} adapter does not support \`denyTools\`.`, {
      code: RuntimeErrorCode.INVALID_INPUT,
    });
  }
}

function toSpawnError(err, { binary, command, adapter, errorClass, envVar }) {
  if (err && err.code === 'ENOENT') {
    const installHint = adapter?.installUrl ?? null;
    const envHint = envVar ? `, or set ${envVar} to its full path.` : '.';
    return new errorClass(
      `${titleCase(adapter?.name ?? 'Runtime')} CLI not found (tried "${binary}").` +
        (installHint ? ` Install it from ${installHint}` : '') +
        ` Ensure it is on your PATH${envHint}`,
      { code: RuntimeErrorCode.BINARY_MISSING, cause: err },
    );
  }
  return new errorClass(
    `Failed to start ${titleCase(adapter?.name ?? 'runtime')} CLI: ${err?.message ?? err}\n  command: ${command}`,
    { code: RuntimeErrorCode.SPAWN_FAILED, cause: err },
  );
}

export function titleCase(s) {
  const text = String(s ?? 'runtime');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
