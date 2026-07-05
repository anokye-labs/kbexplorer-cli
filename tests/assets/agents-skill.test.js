/**
 * Tests for the bundled agents + kbx skill and their wiring to the affordance
 * do-seam (PE1-F3 / #147).
 *
 * These are content assets, so the suite proves three things that matter:
 *   1. the three kb-* agents and the kbx skill (incl. the new search/canvas
 *      references) are present and structurally valid;
 *   2. they reference ONLY real affordance tools — every `kbx_*` name mentioned
 *      in the assets is grounded against the actual extension-tool adapter
 *      ({@link buildAffordanceTools}), so the docs can't drift from the contract;
 *   3. `assembleBundle` materializes them from the shipped package assets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, '..', '..', 'src', 'assets');
const AGENTS_DIR = join(ASSETS, 'agents');
const SKILL_DIR = join(ASSETS, 'skills', 'kbx');

const { buildAffordanceTools, toolNameFor } = await import('../../src/extension/index.ts');
const { assembleBundle } = await import('../../src/lib/plugin-bundle.ts');

/** Real, host-unique tool names exposed by the merged extension-tool adapter. */
const REAL_TOOL_NAMES = new Set(buildAffordanceTools().map((t) => t.name));

const AGENTS = ['kb-architect', 'kb-writer', 'kb-researcher'];

function readAsset(p) {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/** Collect every distinct `kbx_<snake>` token referenced in a markdown asset. */
function referencedToolNames(text) {
  return new Set(text.match(/kbx_[a-z_]+/g) ?? []);
}

// ── Agents present + valid ──────────────────────────────────────────────────────

describe('bundled kb-* agents', () => {
  for (const name of AGENTS) {
    it(`${name} exists with valid frontmatter`, () => {
      const file = join(AGENTS_DIR, `${name}.md`);
      assert.ok(existsSync(file), `${name}.md is shipped`);
      const text = readAsset(file);
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fm, `${name} has YAML frontmatter`);
      assert.match(fm[1], new RegExp(`name:\\s*${name}\\b`), `${name} declares its name`);
      assert.match(fm[1], /description:\s*\S/, `${name} declares a description`);
    });

    it(`${name} references the affordance do-seam tools`, () => {
      const text = readAsset(join(AGENTS_DIR, `${name}.md`));
      assert.match(text, /Affordance Tools \(the kbx do-seam\)/, `${name} has a do-seam section`);
      const refs = referencedToolNames(text);
      assert.ok(refs.size >= 3, `${name} names several kbx_* tools`);
    });
  }

  it('researcher references read/sample tools but not the write-class derive tool', () => {
    const text = readAsset(join(AGENTS_DIR, 'kb-researcher.md'));
    const refs = referencedToolNames(text);
    assert.ok(refs.has(toolNameFor('search')), 'researcher uses kbx_search');
    assert.ok(refs.has(toolNameFor('graph_neighbors')), 'researcher uses kbx_graph_neighbors');
    assert.match(text, /do \*\*not\*\* use write-class tools/i, 'researcher is told not to mutate');
  });
});

// ── Every referenced tool is a real affordance tool (no drift) ──────────────────

describe('agents/skill reference only real affordance tools', () => {
  const files = [
    ...AGENTS.map((n) => join(AGENTS_DIR, `${n}.md`)),
    join(SKILL_DIR, 'SKILL.md'),
    join(SKILL_DIR, 'references', 'search.md'),
    join(SKILL_DIR, 'references', 'canvas.md'),
  ];

  for (const file of files) {
    it(`${file.split(/[\\/]/).slice(-2).join('/')} names no fabricated kbx_* tool`, () => {
      for (const ref of referencedToolNames(readAsset(file))) {
        assert.ok(
          REAL_TOOL_NAMES.has(ref),
          `${ref} must be a real affordance tool (one of ${[...REAL_TOOL_NAMES].join(', ')})`
        );
      }
    });
  }

  it('the full do-seam surface is documented somewhere in the assets', () => {
    const corpus = files.map(readAsset).join('\n');
    for (const real of REAL_TOOL_NAMES) {
      assert.ok(corpus.includes(real), `${real} is documented in the agents/skill assets`);
    }
  });
});

// ── Skill present + new references wired ────────────────────────────────────────

describe('kbx skill and its new references', () => {
  it('ships SKILL.md with valid frontmatter and an affordance-tools section', () => {
    const text = readAsset(join(SKILL_DIR, 'SKILL.md'));
    assert.match(text, /^---\nname: kbx\b/, 'SKILL.md declares name: kbx');
    assert.match(text, /Affordance tools — when a kbx plugin is installed/);
  });

  it('ships the new search.md and canvas.md references, non-empty', () => {
    for (const ref of ['search.md', 'canvas.md']) {
      const file = join(SKILL_DIR, 'references', ref);
      assert.ok(existsSync(file), `${ref} is shipped`);
      assert.ok(readAsset(file).trim().length > 200, `${ref} has real content`);
    }
  });

  it('wires search.md and canvas.md into the SKILL.md router', () => {
    const text = readAsset(join(SKILL_DIR, 'SKILL.md'));
    assert.match(text, /references\/search\.md/, 'router points to search.md');
    assert.match(text, /references\/canvas\.md/, 'router points to canvas.md');
  });

  it('canvas.md documents the kbexplorer canvas id', () => {
    assert.match(readAsset(join(SKILL_DIR, 'references', 'canvas.md')), /\bkbexplorer\b/);
  });
});

// ── Bundle assembles the agents + skill (incl. new references) ──────────────────

describe('plugin bundle assembles the agents and skill from package assets', () => {
  it('materializes all three agents and the full skill reference set', () => {
    const dest = mkdtempSync(join(tmpdir(), 'kbx-agents-skill-'));
    try {
      const { installed } = assembleBundle(dest);
      assert.ok(installed.includes('agents'), 'agents component installed');
      assert.ok(installed.includes('skill'), 'skill component installed');

      for (const name of AGENTS) {
        assert.ok(existsSync(join(dest, 'agents', `${name}.md`)), `${name} copied`);
      }
      assert.ok(existsSync(join(dest, 'skills', 'kbx', 'SKILL.md')));
      assert.ok(existsSync(join(dest, 'skills', 'kbx', 'references', 'search.md')));
      assert.ok(existsSync(join(dest, 'skills', 'kbx', 'references', 'canvas.md')));
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
