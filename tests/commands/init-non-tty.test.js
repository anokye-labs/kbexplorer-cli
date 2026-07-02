import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = resolve(ROOT, 'bin', 'cli.js');

/** Self-hosted repo (name `kbexplorer`) so init skips the networked template install. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-init-ntty-'));
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ name: 'kbexplorer', version: '0.0.0' }, null, 2) + '\n',
    'utf-8',
  );
  return dir;
}

describe('init without --yes on a non-interactive stdin', () => {
  it('exits cleanly with a --yes hint instead of hanging (regression for the exit-13 hang)', () => {
    const dir = makeRepo();
    try {
      // Empty stdin closes immediately (as `kbx init < /dev/null` or a CI step
      // with no here-doc). Before the fix this hung on the first readline
      // prompt and Node exited 13; a hard timeout guards against regressing to
      // that hang.
      const r = spawnSync(process.execPath, [CLI, 'init'], {
        cwd: dir,
        input: '',
        encoding: 'utf-8',
        timeout: 30_000,
      });
      assert.equal(r.signal, null, `init should not hang/time out (signal=${r.signal})`);
      assert.equal(r.status, 1, `expected clean exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--yes/, 'error must tell the user to pass --yes');
      assert.match(r.stderr, /not a TTY|interactive terminal/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
