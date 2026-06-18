#!/usr/bin/env node
// Cross-platform test runner.
//
// `node --test tests/**/*.test.js` is unreliable: the `**` glob is not expanded
// by Node before v21, is never expanded by PowerShell, and under POSIX `sh`
// matches only a single directory level (silently skipping files such as
// tests/twins/mcp/*.test.js). This runner discovers every `*.test.js` under
// tests/ itself and hands the explicit file list to `node --test`, which is
// stable across Node 20+ and every shell.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Recursively collect every `*.test.js` file under `dir`, sorted for stable ordering. */
export function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

/** Run the suite, forwarding any extra args (e.g. --test-name-pattern) to `node --test`. */
export function runTests(passthrough = []) {
  const files = collectTestFiles(join(ROOT, 'tests'));
  if (files.length === 0) {
    console.error('run-tests: no *.test.js files found under tests/');
    return Promise.resolve(1);
  }
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--test', ...passthrough, ...files], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    child.on('error', (err) => {
      console.error('run-tests: failed to start node --test:', err.message);
      res(1);
    });
    child.on('exit', (code, signal) => res(signal ? 1 : (code ?? 1)));
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runTests(process.argv.slice(2)).then((code) => process.exit(code));
}
