import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = resolve(ROOT, 'bin', 'cli.js');

/**
 * A repo whose package.json name is `kbexplorer` is treated as "self-hosted":
 * init skips the (networked) template install and the npm install step, so the
 * scaffold-writing path runs fully offline and hermetically.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-inityes-'));
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ name: 'kbexplorer', version: '0.0.0' }, null, 2) + '\n',
    'utf-8',
  );
  return dir;
}

function runInit(dir, args, stdin) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd: dir,
    input: stdin ?? '',
    encoding: 'utf-8',
  });
}

/**
 * Drive the interactive prompts reliably by answering one line at a time, only
 * once the child has actually printed a prompt (a line ending with ": "). Bulk
 * piping all answers up-front races readline and drops lines, so we respond
 * per-prompt instead.
 */
function runInteractive(dir, answers) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, 'init'], { cwd: dir });
    let output = '';
    let buf = '';
    let idx = 0;
    const feed = () => {
      while (idx < answers.length && /: $/.test(buf)) {
        child.stdin.write(answers[idx++] + '\n');
        buf = '';
      }
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      output += s;
      buf += s;
      feed();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('close', (status) => resolvePromise({ status, output }));
  });
}

function readScaffold(dir) {
  const envPath = resolve(dir, '.env.kbx');
  const recPath = resolve(dir, '.kbx.json');
  return {
    env: existsSync(envPath) ? readFileSync(envPath, 'utf-8') : null,
    record: existsSync(recPath) ? readFileSync(recPath, 'utf-8') : null,
  };
}

describe('init --yes (non-interactive onboarding)', () => {
  it('produces a scaffold identical to the interactive run with the same answers', async () => {
    // Interactive answers, in prompt order:
    //   owner, repo, branch, title, content-mode(2=authored), content-dir,
    //   visual(1=emoji), theme(1=dark), runtime(2=claude)
    const answers = ['acme', 'widgets', 'main', 'Acme KB', '2', 'content', '1', '1', '2'];

    const interactiveDir = makeRepo();
    const headlessDir = makeRepo();
    try {
      const ri = await runInteractive(interactiveDir, answers);
      assert.equal(ri.status, 0, ri.output);

      const rh = runInit(headlessDir, [
        '--yes',
        '--owner', 'acme',
        '--repo', 'widgets',
        '--kb-branch', 'main',
        '--title', 'Acme KB',
        '--content-mode', 'authored',
        '--content', 'content',
        '--visual', 'emoji',
        '--theme', 'dark',
        '--runtime', 'claude',
      ]);
      assert.equal(rh.status, 0, rh.stdout + rh.stderr);

      const a = readScaffold(interactiveDir);
      const b = readScaffold(headlessDir);

      // The headless scaffold must be byte-identical to the interactive one.
      assert.equal(b.env, a.env, 'headless .env.kbx differs from interactive');
      assert.equal(b.record, a.record, 'headless .kbx.json differs from interactive');

      // And the concrete expected content.
      assert.equal(
        a.env,
        ['VITE_KB_OWNER=acme', 'VITE_KB_REPO=widgets', 'VITE_KB_BRANCH=main', 'VITE_KB_TITLE=Acme KB', 'VITE_KB_PATH=content'].join('\n') + '\n',
      );
      assert.ok(a.record && JSON.parse(a.record).runtime.agent === 'claude');
    } finally {
      rmSync(interactiveDir, { recursive: true, force: true });
      rmSync(headlessDir, { recursive: true, force: true });
    }
  });

  it('defaults match interactive defaults (repo content-mode → no VITE_KB_PATH, no runtime block)', () => {
    const dir = makeRepo();
    try {
      const r = runInit(dir, [
        '--yes', '--owner', 'acme', '--repo', 'widgets', '--kb-branch', 'main',
      ]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const { env, record } = readScaffold(dir);
      assert.equal(
        env,
        ['VITE_KB_OWNER=acme', 'VITE_KB_REPO=widgets', 'VITE_KB_BRANCH=main', 'VITE_KB_TITLE=widgets Knowledge Base'].join('\n') + '\n',
      );
      assert.doesNotMatch(env, /VITE_KB_PATH/);
      assert.equal(record, null, 'copilot/default runtime must not write a runtime block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads defaults from a --config JSON file (flags override config)', () => {
    const dir = makeRepo();
    try {
      writeFileSync(
        resolve(dir, 'kb.json'),
        JSON.stringify({ owner: 'fromcfg', repo: 'widgets', branch: 'dev', title: 'Cfg KB', runtime: { agent: 'claude' } }),
        'utf-8',
      );
      const r = runInit(dir, ['--yes', '--config', 'kb.json', '--owner', 'flagwins']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const { env, record } = readScaffold(dir);
      assert.match(env, /VITE_KB_OWNER=flagwins/); // flag overrides config
      assert.match(env, /VITE_KB_REPO=widgets/);
      assert.match(env, /VITE_KB_BRANCH=dev/);
      assert.ok(record && JSON.parse(record).runtime.agent === 'claude');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with a clear error when a required value is missing and undetectable', () => {
    const dir = makeRepo(); // no git remote, no --owner/--repo
    try {
      const r = runInit(dir, ['--yes']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /owner is required/);
      assert.match(r.stderr, /repo is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid enum value (content-mode) with a clear error', () => {
    const dir = makeRepo();
    try {
      const r = runInit(dir, ['--yes', '--owner', 'a', '--repo', 'b', '--content-mode', 'bogus']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /content-mode must be one of/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid --mode', () => {
    const dir = makeRepo();
    try {
      const r = runInit(dir, ['--yes', '--owner', 'a', '--repo', 'b', '--mode', 'nonsense']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Invalid --mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

