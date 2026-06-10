/**
 * Copilot programmatic-mode runtime adapter.
 *
 * A thin, zero-dependency wrapper around GitHub Copilot CLI's non-interactive
 * mode (`copilot -p "<prompt>"`). It is the single substrate through which the
 * kbexplorer CLI runs *fuzzy* (LLM / agentic) work — complementing the
 * deterministic transform path. It assembles a scoped command, spawns the
 * `copilot` binary, captures stdout/stderr/exit code, and turns failures
 * (missing binary, timeout, non-zero exit) into actionable errors.
 *
 * ── Public API (the reusable surface other features, e.g. F8, build on) ──
 *   Constants:
 *     DEFAULT_COPILOT_BINARY  — the binary name resolved by default ("copilot").
 *     COPILOT_BIN_ENV         — env var that overrides the binary path.
 *     RuntimeErrorCode        — frozen map of error codes (see below).
 *   Errors:
 *     CopilotRuntimeError     — Error subclass carrying `.code` (RuntimeErrorCode)
 *                               and, when available, `.exitCode` / `.result`.
 *   Functions:
 *     resolveBinary(opts)        -> string         resolve the binary to invoke.
 *     buildCopilotArgs(opts)     -> string[]       pure argv assembly (no binary).
 *     isCopilotAvailable(opts)   -> boolean        is the binary runnable?
 *     parseJsonl(text)           -> object[]       parse JSONL (--output-format json).
 *     extractResponseText(ev,raw)-> string         best-effort final assistant text.
 *     runCopilot(opts)           -> Promise<Result> spawn + capture + structure.
 *
 * `runCopilot` accepts an injectable `spawn` implementation so the test suite is
 * fully hermetic (no live LLM, no network), and a `binaryArgs` seam so a mock
 * executable can be exercised through the *real* child_process path.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

export const DEFAULT_COPILOT_BINARY = 'copilot';

/** Environment variable that, when set, overrides the resolved binary path. */
export const COPILOT_BIN_ENV = 'KBEXPLORER_COPILOT_BIN';

/** Default time budget for a single programmatic run (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Stable error codes attached to {@link CopilotRuntimeError}. */
export const RuntimeErrorCode = Object.freeze({
  /** The `copilot` binary could not be found / is not executable. */
  BINARY_MISSING: 'COPILOT_BINARY_MISSING',
  /** The run exceeded its time budget and was terminated. */
  TIMEOUT: 'COPILOT_TIMEOUT',
  /** The process exited with a non-zero status code. */
  NONZERO_EXIT: 'COPILOT_NONZERO_EXIT',
  /** The process failed to spawn for a reason other than a missing binary. */
  SPAWN_FAILED: 'COPILOT_SPAWN_FAILED',
  /** Required input (e.g. a prompt) was not supplied. */
  INVALID_INPUT: 'COPILOT_INVALID_INPUT',
});

/**
 * Error thrown by the runtime. Carries a stable `code` plus, where relevant,
 * the `exitCode` and the partial {@link RuntimeResult}.
 */
export class CopilotRuntimeError extends Error {
  /**
   * @param {string} message
   * @param {object} [info]
   * @param {string} [info.code]
   * @param {number|null} [info.exitCode]
   * @param {object} [info.result]
   * @param {Error} [info.cause]
   */
  constructor(message, { code = RuntimeErrorCode.SPAWN_FAILED, exitCode = null, result = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CopilotRuntimeError';
    this.code = code;
    this.exitCode = exitCode;
    this.result = result;
  }
}

/**
 * Resolve the binary to invoke. Order of precedence:
 *   1. explicit `options.binary`
 *   2. `KBEXPLORER_COPILOT_BIN` env var
 *   3. {@link DEFAULT_COPILOT_BINARY}
 *
 * @param {{ binary?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveBinary(options = {}) {
  const env = options.env ?? process.env;
  return options.binary || env[COPILOT_BIN_ENV] || DEFAULT_COPILOT_BINARY;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Assemble the argument vector (excluding the binary) for a `copilot -p` run.
 * Pure and deterministic — the same options always yield the same argv, which
 * makes command assembly trivial to unit-test.
 *
 * @param {object} options
 * @param {string}   options.prompt                 Prompt text (required).
 * @param {string[]} [options.allowTools]           Tool specs → `--allow-tool=<spec>` (e.g. 'shell(git)').
 * @param {string[]} [options.denyTools]            Tool specs → `--deny-tool=<spec>`.
 * @param {boolean}  [options.allowAllTools=false]  Add `--allow-all-tools` (required for unattended tool use).
 * @param {boolean}  [options.allowAll=false]       Add `--allow-all` (tools + paths + urls).
 * @param {string}   [options.model]                `--model <model>`.
 * @param {('text'|'json')} [options.outputFormat]  `--output-format <fmt>`.
 * @param {boolean}  [options.silent=false]         `-s` (response only, no stats).
 * @param {boolean}  [options.noColor=true]         `--no-color` (clean capture).
 * @param {string[]} [options.addDirs]              `--add-dir <dir>` (repeatable).
 * @param {string}   [options.logLevel]             `--log-level <level>`.
 * @param {string[]} [options.extraArgs]            Verbatim pass-through (e.g. future flags).
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

/**
 * Check whether the `copilot` binary is present and runnable by invoking
 * `copilot --version`. Never throws.
 *
 * @param {{ binary?: string, env?: NodeJS.ProcessEnv, spawnSync?: Function, timeoutMs?: number }} [options]
 * @returns {boolean}
 */
export function isCopilotAvailable(options = {}) {
  const binary = resolveBinary(options);
  const spawnSyncImpl = options.spawnSync ?? nodeSpawnSync;
  try {
    const res = spawnSyncImpl(binary, ['--version'], {
      stdio: 'ignore',
      timeout: options.timeoutMs ?? 10_000,
      shell: false,
    });
    // `error` is set (e.g. ENOENT) when the binary cannot be spawned at all.
    // A binary that runs but exits non-zero on --version is still "available".
    return !!res && !res.error;
  } catch {
    return false;
  }
}

/**
 * Parse JSONL output (`--output-format json`) into an array of event objects.
 * Lines that are not valid JSON are skipped (defensive — banners, warnings).
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseJsonl(text) {
  if (!text) return [];
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* not a JSON line — ignore */
    }
  }
  return events;
}

function pickText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(pickText).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.content != null) return pickText(value.content);
  }
  return '';
}

/**
 * Best-effort extraction of the final assistant/response text from parsed JSONL
 * events. Falls back to the raw stdout when no structured text is found (e.g.
 * `--output-format text`). Resilient to schema drift across copilot versions.
 *
 * @param {object[]} events
 * @param {string} [rawStdout]
 * @returns {string}
 */
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
      type.includes('text');
    if (!looksAssistant) continue;
    const text = pickText(ev.text ?? ev.content ?? ev.message ?? ev.delta ?? ev);
    if (text) parts.push(text);
  }
  const joined = parts.join('').trim();
  return joined || String(rawStdout ?? '').trim();
}

/**
 * @typedef {object} RuntimeResult
 * @property {boolean} ok            True when the process exited 0.
 * @property {number|null} exitCode  Process exit code (null if killed by signal).
 * @property {string|null} signal    Terminating signal, if any.
 * @property {boolean} timedOut      True when the run hit its time budget.
 * @property {string} stdout         Captured stdout.
 * @property {string} stderr         Captured stderr.
 * @property {string} response       Best-effort assistant text (see extractResponseText).
 * @property {object[]} events       Parsed JSONL events (empty unless outputFormat==='json').
 * @property {string} binary         The binary that was invoked.
 * @property {string[]} args         The full argv passed to the binary.
 * @property {string} command        Human-readable command string (for logs).
 * @property {number} durationMs     Wall-clock duration.
 */

function quoteForDisplay(token) {
  return /[\s"'()]/.test(token) ? JSON.stringify(token) : token;
}

/**
 * Run Copilot in programmatic mode and capture the result.
 *
 * Resolves to a {@link RuntimeResult}. By default a non-zero exit rejects with a
 * {@link CopilotRuntimeError} (`code === NONZERO_EXIT`); pass `throwOnError:false`
 * to receive the result object instead. A missing binary always rejects with
 * `code === BINARY_MISSING` and an actionable message. A timeout rejects with
 * `code === TIMEOUT`.
 *
 * @param {object} options                       All {@link buildCopilotArgs} options, plus:
 * @param {string}   [options.binary]            Override the binary path.
 * @param {string[]} [options.binaryArgs]        Args inserted *between* the binary and the
 *                                               generated copilot args (e.g. to invoke through
 *                                               a wrapper/runner, or a mock executable in tests).
 * @param {string}   [options.cwd]               Working directory for the run.
 * @param {NodeJS.ProcessEnv} [options.env]      Environment for the child (defaults to process.env).
 * @param {number}   [options.timeoutMs]         Time budget; default {@link DEFAULT_TIMEOUT_MS}.
 * @param {string}   [options.input]             Optional stdin payload.
 * @param {boolean}  [options.throwOnError=true] Reject on non-zero exit when true.
 * @param {Function} [options.spawn]             Injectable spawn (defaults to node:child_process spawn).
 * @param {(event: object) => void} [options.onEvent] Called for each parsed JSONL event (json mode).
 * @returns {Promise<RuntimeResult>}
 */
export function runCopilot(options = {}) {
  const {
    binary: binaryOverride,
    binaryArgs = [],
    cwd = process.cwd(),
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    input,
    throwOnError = true,
    spawn: spawnImpl = nodeSpawn,
    onEvent,
    ...argOptions
  } = options;

  const binary = resolveBinary({ binary: binaryOverride, env });
  const copilotArgs = buildCopilotArgs(argOptions);
  const args = [...asArray(binaryArgs), ...copilotArgs];
  const command = [binary, ...args].map(quoteForDisplay).join(' ');
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, {
        cwd,
        env: env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(toSpawnError(err, { binary, command }));
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
        // Reject immediately rather than waiting for 'close' — a killed child
        // does emit 'close' on every platform, but we must not depend on it.
        finish(
          reject,
          new CopilotRuntimeError(
            `Copilot run timed out after ${timeoutMs}ms: ${command}`,
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
      finish(reject, toSpawnError(err, { binary, command }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      const isJson = argOptions.outputFormat === 'json';
      const events = isJson ? parseJsonl(stdout) : [];
      if (isJson && typeof onEvent === 'function') {
        for (const ev of events) {
          try {
            onEvent(ev);
          } catch {
            /* listener errors must not break the run */
          }
        }
      }

      const exitCode = code;
      /** @type {RuntimeResult} */
      const result = {
        ok: exitCode === 0,
        exitCode,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        response: extractResponseText(events, stdout),
        events,
        binary,
        args,
        command,
        durationMs: Date.now() - startedAt,
      };

      if (exitCode !== 0 && throwOnError) {
        const detail = (stderr || stdout).trim();
        finish(
          reject,
          new CopilotRuntimeError(
            `Copilot exited with code ${exitCode}.${detail ? `\n${detail}` : ''}`,
            { code: RuntimeErrorCode.NONZERO_EXIT, exitCode, result },
          ),
        );
        return;
      }

      finish(resolve, result);
    });

    if (input != null && child.stdin) {
      child.stdin.end(input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

function toSpawnError(err, { binary, command }) {
  if (err && err.code === 'ENOENT') {
    return new CopilotRuntimeError(
      `Copilot CLI not found (tried "${binary}"). Install it from ` +
        'https://docs.github.com/copilot/how-tos/copilot-cli and ensure it is on your PATH, ' +
        `or set ${COPILOT_BIN_ENV} to its full path.`,
      { code: RuntimeErrorCode.BINARY_MISSING, cause: err },
    );
  }
  return new CopilotRuntimeError(
    `Failed to start Copilot CLI: ${err?.message ?? err}\n  command: ${command}`,
    { code: RuntimeErrorCode.SPAWN_FAILED, cause: err },
  );
}
