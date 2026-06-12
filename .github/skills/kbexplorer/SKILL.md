---
name: kbexplorer
description: >-
  This skill should be used when the user mentions "kbexplorer", "knowledge
  base explorer", "knowledge graph", "kb graph", or asks to "set up
  kbexplorer", "bootstrap a knowledge base", "add a page to the KB", "add a
  node", "refresh the KB", "update the knowledge base", "audit kb content",
  "validate kb frontmatter", "recolor a cluster", "move a node between
  clusters", "merge KB pages", "split a KB page", "change the kb theme",
  "change visual mode", "add hero images", "investigate this repo deeply",
  "generate kb content", "explore this repo as a graph", or works with any
  file under `content/*.md`, `content/config.yaml`, `.kbexplorer/`,
  `.github/agents/kb-*.md`, or `.github/skills/kbexplorer/`. Provides
  end-to-end lifecycle guidance for creating, maintaining, refactoring,
  validating, and presenting an interactive kbexplorer knowledge base —
  with on-demand reference playbooks for each task.
version: 0.2.0
---

# kbexplorer — Lifecycle Skill

kbexplorer turns any repository into a navigable, interactive knowledge
graph. This skill covers the **full lifecycle**: bootstrap, authoring,
refactoring, validation, presentation, and incremental refresh — through a
library of focused references loaded on demand.

## How to use this skill

This file is a **router**. The real depth lives in `references/`. Identify
the user's task in the table below, then load the matching reference(s) and
follow them.

| User intent | Load |
|---|---|
| Bootstrap kbexplorer in a repo for the first time | `references/setup.md` |
| Understand the frontmatter schema | `references/frontmatter.md` |
| Add a single new page | `references/add-node.md` (uses `kbexplorer scaffold`) |
| Refresh a single existing page | `references/update-node.md` |
| Refresh content after a code change | `references/incremental-refresh.md` (uses `kbexplorer affected`) |
| Validate content integrity | `references/audit.md` (uses `kbexplorer audit`) |
| Reorganize the graph (rename/move/merge/split nodes, recolor clusters) | `references/graph-curation.md` |
| Decide what connects to what, and how to phrase it | `references/connections.md` |
| Change the visual mode, theme, or fonts | `references/presentation.md` |
| Wire sprite or hero images to nodes | `references/assets-pipeline.md` |
| Build a fresh catalogue from a repository (no agent runtime) | `references/architect-playbook.md` |
| Fill in a single page deeply (no agent runtime) | `references/writer-playbook.md` |
| Investigate a part of the codebase systematically | `references/researcher-playbook.md` |
| Look up a `config.yaml` field | `references/configuration.md` |
| Understand the architect → transform → writer pipeline | `references/content-generation.md` |

## Working without agents

This skill works in environments that lack agent support (e.g., Copilot
desktop). The three `*-playbook.md` references mirror the behavior of the
installed `kb-architect`, `kb-writer`, and `kb-researcher` agents step by
step — any LLM can follow them directly to get the same outcome.

When an agent runtime IS available, invoking the agent is faster than
following the playbook by hand, but the playbook remains the source of
truth for what the agent should do.

## CLI helpers — deterministic, no LLM

These commands handle the parts of the workflow that are pure computation.
Prefer shelling out to them over reasoning through the same logic.

| Command | Use for |
|---|---|
| `kbexplorer init` | Bootstrap; see `references/setup.md`. |
| `kbexplorer scaffold <slug> --cluster <id>` | Create a single new page with valid frontmatter; see `references/add-node.md`. |
| `kbexplorer audit` | Hard structural lint (duplicate ids, broken parents, cycles, dead connections); see `references/audit.md`. Exits non-zero on errors — CI-grade. |
| `kbexplorer affected <git-ref>` | Map a diff to impacted content nodes via citations; see `references/incremental-refresh.md`. |
| `kbexplorer links` | Soft graph-health analysis (orphans, weak clusters, coverage gaps). |
| `kbexplorer generate` | Run the architect → transform → writer pipeline; see `references/content-generation.md`. |
| `kbexplorer dev` / `kbexplorer build` | Start the dev server / production build. |

## Invariants — true in every workflow

These rules apply universally. References repeat them where relevant.

1. **Resolve the source repository context first.** Citations are useless
   without it. Detect the git remote, decide linked vs. local citations,
   determine the branch. Don't write or edit without this resolved.

2. **Cite or strike.** Every non-trivial claim is followed by a citation in
   one of the two supported formats:

   | Style | Use when | Example |
   |---|---|---|
   | Linked | A remote URL is known | `[src/auth.ts:42](URL/blob/main/src/auth.ts#L42)` |
   | Local | Local-only repo | `(src/auth.ts:42)` |

   After every Mermaid diagram add `<!-- Sources: file:line, file:line -->`.

3. **Audit before declaring done.** Run `kbexplorer audit` after any change
   to `content/` or `content/config.yaml`. Zero errors is the bar; warnings
   are acknowledged or remediated. Run `kbexplorer links` for the soft
   graph-health pass.

4. **Validate visually.** After authoring or refactoring, start `kbexplorer
   dev` and confirm the affected nodes render correctly in the browser.
   Use playwright-cli or computer-use MCP for screenshot evidence when
   available.

5. **Names lie. Read the code.** Never paraphrase from a file name, type
   name, or naming convention. Open the file, trace the path, then write.

6. **Preserve author intent.** When refreshing existing content, the
   default is the smallest surgical edit that fixes the issue. Wholesale
   rewrites destroy commentary and editorial judgement the author put
   there on purpose.

## File locations the skill cares about

| Path | Role |
|---|---|
| `content/*.md` | Authored nodes. One file per node; filename slug = id. |
| `content/config.yaml` | Title, subtitle, clusters, visual mode, theme. |
| `content/assets/heroes/`, `content/assets/sprites/` | Optional image assets. |
| `catalogue.json` | Architect output (transient, consumed by `kbexplorer generate`). |
| `.kbexplorer/` | The explorer app submodule. |
| `.env.kbexplorer` | Vite env vars (gitignored). |
| `.github/agents/kb-*.md` | Installed agent definitions. |
| `.github/skills/kbexplorer/SKILL.md` | This file. |
| `.github/skills/kbexplorer/references/*.md` | The playbook library. |
