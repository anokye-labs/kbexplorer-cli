---
name: kbx
description: >-
  This skill should be used when the user mentions "kbx", "knowledge
  base explorer", "knowledge graph", "kb graph", or asks to "set up
  kbx", "bootstrap a knowledge base", "add a page to the KB", "add a
  node", "refresh the KB", "update the knowledge base", "audit kb content",
  "validate kb frontmatter", "recolor a cluster", "move a node between
  clusters", "merge KB pages", "split a KB page", "change the kb theme",
  "change visual mode", "add hero images", "investigate this repo deeply",
  "generate kb content", "explore this repo as a graph", or works with any
  file under `content/*.md`, `content/config.yaml`, `.kbx/`,
  `.github/agents/kb-*.md`, or `.github/skills/kbx/`. Provides
  end-to-end lifecycle guidance for creating, maintaining, refactoring,
  validating, and presenting an interactive kbx knowledge base —
  with on-demand reference playbooks for each task.
version: 0.2.0
---

# kbx — Lifecycle Skill

kbx turns any repository into a navigable, interactive knowledge
graph. This skill covers the **full lifecycle**: bootstrap, authoring,
refactoring, validation, presentation, and incremental refresh — through a
library of focused references loaded on demand.

## How to use this skill

This file is a **router**. The real depth lives in `references/`. Identify
the user's task in the table below, then load the matching reference(s) and
follow them.

| User intent | Load |
|---|---|
| Bootstrap kbx in a repo for the first time | `references/setup.md` |
| Understand the frontmatter schema | `references/frontmatter.md` |
| Add a single new page | `references/add-node.md` (uses `kbx scaffold`) |
| Refresh a single existing page | `references/update-node.md` |
| Refresh content after a code change | `references/incremental-refresh.md` (uses `kbx affected`) |
| Validate content integrity | `references/audit.md` (uses `kbx audit`) |
| Reorganize the graph (rename/move/merge/split nodes, recolor clusters) | `references/graph-curation.md` |
| Search/query/inspect the graph through plugin tools (`kbx_*`) | `references/search.md` |
| Present or focus the graph on the kbexplorer canvas | `references/canvas.md` |
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
| `kbx init` | Bootstrap; see `references/setup.md`. |
| `kbx scaffold <slug> --cluster <id>` | Create a single new page with valid frontmatter; see `references/add-node.md`. |
| `kbx audit` | Hard structural lint (duplicate ids, broken parents, cycles, dead connections); see `references/audit.md`. Exits non-zero on errors — CI-grade. |
| `kbx affected <git-ref>` | Map a diff to impacted content nodes via citations; see `references/incremental-refresh.md`. |
| `kbx links` | Soft graph-health analysis (orphans, weak clusters, coverage gaps). |
| `kbx generate` | Run the architect → transform → writer pipeline; see `references/content-generation.md`. |
| `kbx dev` / `kbx build` | Start the dev server / production build. |

## Affordance tools — when a kbx plugin is installed

When the kbx plugin/extension runtime is present, the graph also exposes a
**protocol-neutral action surface** (the "do-seam"): graph operations delivered
as Copilot CLI tools named `kbx_<action>`. Drive the graph through these tools
rather than ad-hoc file scanning — they read the same graph the kbexplorer
canvas renders, and inputs are schema-validated.

| Tool | Class | Use for | Reference |
|---|---|---|---|
| `kbx_search` | read | Ranked semantic search over the graph | `references/search.md` |
| `kbx_query_node` | read | Fetch one node (frontmatter + body) by id | `references/search.md` |
| `kbx_graph_neighbors` | read | BFS neighbours of a node (depth ≤ 4) | `references/search.md` |
| `kbx_affected` | read | Nodes whose citations touch a changed git ref | `references/incremental-refresh.md` |
| `kbx_audit` | read | Structural integrity audit of `content/` | `references/audit.md` |
| `kbx_llm_context` | sample | Assemble a grounded context bundle (no model call) | `references/search.md` |
| `kbx_derive` | write | Extract entities into committed JSON-LD | `references/content-generation.md` |

The kbexplorer **canvas** (id `kbexplorer`) presents the graph these tools act
on — see `references/canvas.md`. When no plugin runtime is available, fall back
to the deterministic CLI helpers above; they compute the same answers offline.

### Job layer — long-running work

The stateless tools above can't express long-running generation/write-back, so
the do-seam also includes a **protocol-neutral job layer** delivered through the
same `kbx_<action>` tool surface. A job is started, polled, then reviewed and
applied:

| Tool | Class | Use for |
|---|---|---|
| `kbx_start_generate` | sample | Begin a long-running generation job; returns a job id (resumable) |
| `kbx_get_job_status` | read | Poll a job's status, progress, and any late-credential prompt |
| `kbx_cancel_job` | write | Abort a running (or credential-paused) job |
| `kbx_preview_changes` | read | List the files a succeeded job would write (no disk writes) |
| `kbx_apply_changes` | write | Write the job's change set back verbatim (partial-failure recovery) |
| `kbx_create_pr` | write | Open a pull request once the changes are applied |

Typical flow: `kbx_start_generate` → poll `kbx_get_job_status` until it succeeds
(or `kbx_cancel_job` to stop it) → `kbx_preview_changes` to review → review the
diff, `kbx_apply_changes` to write back → `kbx_create_pr`. Job state is a runtime
concern (no timestamps); the model and git/PR runtimes are injected by the host,
never owned by the contract.

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

3. **Audit before declaring done.** Run `kbx audit` after any change
   to `content/` or `content/config.yaml`. Zero errors is the bar; warnings
   are acknowledged or remediated. Run `kbx links` for the soft
   graph-health pass.

4. **Validate visually.** After authoring or refactoring, start `kbx
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
| `catalogue.json` | Architect output (transient, consumed by `kbx generate`). |
| `.kbx/` | The explorer app submodule. |
| `.env.kbx` | Vite env vars (gitignored). |
| `.github/agents/kb-*.md` | Installed agent definitions. |
| `.github/skills/kbx/SKILL.md` | This file. |
| `.github/skills/kbx/references/*.md` | The playbook library. |

