import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const scaffold = (await import('../../src/commands/scaffold.ts')).default;
const { parseFrontmatter } = await import('../../src/lib/markdown.ts');

async function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-scaffold-'));
  const origCwd = process.cwd();
  const origEnv = process.env.VITE_KB_PATH;
  delete process.env.VITE_KB_PATH;
  process.chdir(dir);
  // process.cwd() may differ from `dir` on Windows due to path normalisation —
  // use the post-chdir value as the source of truth.
  const realDir = process.cwd();
  try {
    await fn(realDir);
  } finally {
    process.chdir(origCwd);
    if (origEnv !== undefined) process.env.VITE_KB_PATH = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scaffold command', () => {
  it('creates a valid content file with required frontmatter', async () => {
    await withTempCwd(async (dir) => {
      await scaffold(['my-topic', '--cluster', 'overview']);
      const filePath = resolve(dir, 'content', 'my-topic.md');
      assert.ok(existsSync(filePath));
      const parsed = parseFrontmatter(readFileSync(filePath, 'utf-8'));
      assert.ok(parsed.ok);
      assert.equal(parsed.frontmatter.id, 'my-topic');
      assert.equal(parsed.frontmatter.title, 'My Topic');
      assert.equal(parsed.frontmatter.cluster, 'overview');
      assert.deepEqual(parsed.frontmatter.connections, []);
    });
  });

  it('respects --title, --parent, --emoji', async () => {
    await withTempCwd(async (dir) => {
      await scaffold([
        'auth',
        '--cluster',
        'security',
        '--parent',
        'core',
        '--title',
        'Authentication',
        '--emoji',
        'LockClosed',
      ]);
      const parsed = parseFrontmatter(
        readFileSync(resolve(dir, 'content', 'auth.md'), 'utf-8'),
      );
      assert.equal(parsed.frontmatter.title, 'Authentication');
      assert.equal(parsed.frontmatter.parent, 'core');
      assert.equal(parsed.frontmatter.emoji, 'LockClosed');
    });
  });

  it('infers an emoji from title/cluster keywords when --emoji is omitted', async () => {
    await withTempCwd(async (dir) => {
      await scaffold(['data-model', '--cluster', 'database']);
      const parsed = parseFrontmatter(
        readFileSync(resolve(dir, 'content', 'data-model.md'), 'utf-8'),
      );
      // inferIcon should pick something other than the fallback Document
      assert.notEqual(parsed.frontmatter.emoji, 'Document');
    });
  });

  it('rejects an invalid slug', async () => {
    await withTempCwd(async () => {
      const origExit = process.exit;
      let exitCode = null;
      process.exit = (c) => { exitCode = c; throw new Error('exit'); };
      try {
        await scaffold(['Invalid Slug', '--cluster', 'x']);
      } catch { /* expected */ }
      process.exit = origExit;
      assert.equal(exitCode, 2);
    });
  });

  it('refuses to overwrite without --force', async () => {
    await withTempCwd(async () => {
      await scaffold(['x', '--cluster', 'y']);
      const origExit = process.exit;
      let exitCode = null;
      process.exit = (c) => { exitCode = c; throw new Error('exit'); };
      try {
        await scaffold(['x', '--cluster', 'y']);
      } catch { /* expected */ }
      process.exit = origExit;
      assert.equal(exitCode, 1);
    });
  });
});
