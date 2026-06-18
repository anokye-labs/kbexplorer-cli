import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestFiles } from '../../scripts/run-tests.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TESTS_DIR = join(ROOT, 'tests');

test('collectTestFiles discovers nested *.test.js files recursively', () => {
  const files = collectTestFiles(TESTS_DIR);
  assert.ok(files.length >= 28, `expected >=28 test files, found ${files.length}`);
  assert.ok(
    files.every((f) => f.endsWith('.test.js')),
    'every discovered file should end with .test.js',
  );
});

test('collectTestFiles includes files more than one directory deep', () => {
  // tests/twins/mcp/*.test.js sit two levels below tests/ and were silently
  // skipped by the old `tests/**/*.test.js` glob under POSIX sh.
  const files = collectTestFiles(TESTS_DIR).map((f) => f.replaceAll('\\', '/'));
  assert.ok(
    files.some((f) => f.endsWith('tests/twins/mcp/twin-servers.test.js')),
    'expected a two-level-deep test file to be discovered',
  );
});

test('collectTestFiles returns a stably sorted list', () => {
  const files = collectTestFiles(TESTS_DIR);
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted);
});
