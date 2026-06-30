/**
 * Tests for the kbx command surface (PE1-F2 / #146).
 *
 * Validates the CLI-verb → plugin-command map, the scoped tool allowlists, the
 * deterministic Markdown rendering, and that the committed src/assets/commands/
 * files are in sync with the surface (drift gate, mirrors `derive --check`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  COMMAND_SURFACE,
  ALLOW,
  getCommand,
  commandNames,
  validateCommand,
  validateSurface,
  renderCommandMarkdown,
  renderAllCommands,
} = await import('../../src/lib/command-surface.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS_DIR = resolve(ROOT, 'src', 'assets', 'commands');

// The eleven verbs the issue requires exposing as plugin commands.
const REQUIRED_VERBS = [
  'init',
  'generate',
  'derive',
  'scaffold',
  'audit',
  'affected',
  'links',
  'search',
  'dev',
  'build',
  'doctor',
];

describe('command surface coverage', () => {
  it('exposes exactly the eleven required CLI verbs', () => {
    assert.deepEqual([...commandNames()].sort(), [...REQUIRED_VERBS].sort());
  });

  it('maps every command 1:1 to its kbx verb', () => {
    for (const c of COMMAND_SURFACE) {
      assert.ok(c.run.startsWith(`kbx ${c.name}`), `${c.name} run template`);
      assert.ok(c.run.includes('$ARGUMENTS'), `${c.name} forwards arguments`);
    }
  });

  it('flags only generate and derive as Copilot-backed (fuzzy) verbs', () => {
    const fuzzy = COMMAND_SURFACE.filter((c) => c.needsCopilot).map((c) => c.name).sort();
    assert.deepEqual(fuzzy, ['derive', 'generate']);
  });

  it('looks up a command by name', () => {
    assert.equal(getCommand('audit').name, 'audit');
    assert.equal(getCommand('nope'), undefined);
  });
});

describe('scoped tool allowlists', () => {
  it('every command anchors on its own scoped shell token (least privilege)', () => {
    for (const c of COMMAND_SURFACE) {
      assert.ok(
        c.allowedTools.includes(ALLOW.shell(`kbx ${c.name}`)),
        `${c.name} must allow shell(kbx ${c.name})`
      );
    }
  });

  it('read-only analysis verbs do not request write/edit', () => {
    for (const name of ['audit', 'links', 'affected', 'doctor', 'search', 'dev', 'build']) {
      const tools = getCommand(name).allowedTools;
      assert.ok(!tools.includes('write'), `${name} should not allow write`);
      assert.ok(!tools.includes('edit'), `${name} should not allow edit`);
    }
  });

  it('mutating verbs request write access', () => {
    for (const name of ['init', 'generate', 'derive', 'scaffold']) {
      assert.ok(getCommand(name).allowedTools.includes('write'), `${name} should allow write`);
    }
  });

  it('only init and affected reach for git', () => {
    const withGit = COMMAND_SURFACE.filter((c) => c.allowedTools.includes('shell(git)'))
      .map((c) => c.name)
      .sort();
    assert.deepEqual(withGit, ['affected', 'init']);
  });

  it('rejects an entry whose allowlist is missing its anchor', () => {
    const v = validateCommand({ name: 'audit', summary: 's', run: 'kbx audit', allowedTools: ['view'] });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('anchor on shell(kbx audit)')));
  });

  it('rejects an unrecognized allow token', () => {
    const v = validateCommand({
      name: 'audit',
      summary: 's',
      run: 'kbx audit',
      allowedTools: ['shell(kbx audit)', 'network'],
    });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('unrecognized allow token')));
  });

  it('the whole surface validates', () => {
    const v = validateSurface();
    assert.deepEqual(v.errors, []);
    assert.equal(v.valid, true);
  });
});

describe('Markdown rendering', () => {
  it('emits frontmatter with name, description, argument-hint and allowed-tools', () => {
    const md = renderCommandMarkdown(getCommand('derive'));
    assert.match(md, /^---\nname: derive\n/);
    assert.match(md, /description: .+/);
    assert.match(md, /argument-hint: <source\.\.\.>/);
    assert.match(md, /allowed-tools:\n {2}- shell\(kbx derive\)/);
  });

  it('surfaces the argument table and the run block', () => {
    const md = renderCommandMarkdown(getCommand('scaffold'));
    assert.match(md, /## Arguments/);
    assert.match(md, /--cluster <id>/);
    assert.match(md, /```sh\nkbx scaffold \$ARGUMENTS\n```/);
  });

  it('is deterministic — same entry yields byte-identical output', () => {
    const a = renderCommandMarkdown(getCommand('audit'));
    const b = renderCommandMarkdown(getCommand('audit'));
    assert.equal(a, b);
    assert.ok(a.endsWith('\n'));
  });

  it('refuses to render an invalid entry', () => {
    assert.throws(() => renderCommandMarkdown({ name: 'x' }), /cannot render invalid command/);
  });
});

describe('shipped command assets (drift gate)', () => {
  it('ships exactly one .md per command and nothing extra', () => {
    assert.ok(existsSync(COMMANDS_DIR), 'commands dir exists');
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md')).sort();
    assert.deepEqual(files, COMMAND_SURFACE.map((c) => `${c.name}.md`).sort());
  });

  it('every committed file matches the deterministic render (no drift)', () => {
    for (const { file, content } of renderAllCommands()) {
      const path = join(COMMANDS_DIR, file);
      assert.ok(existsSync(path), `${file} present`);
      assert.equal(readFileSync(path, 'utf-8'), content, `${file} is up to date`);
    }
  });
});
