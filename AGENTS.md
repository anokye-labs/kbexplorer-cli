# kbexplorer-cli

## Running the Site Locally

This repo (`@anokye-labs/kbexplorer`) is the **CLI**, not the visual explorer app. The explorer is the separate `anokye-labs/kbexplorer-template` repo, which the CLI installs into `.kbx/`. Because of this, `kbx dev` only works once `.kbx/` exists — otherwise it exits with ``✗ kbx not found. Run `kbx init` first.``

Requirements: Node >= 22 and network access (the one-time setup clones the template repo).

```bash
# 1. Pull latest
git pull

# 2. One-time setup — only if .kbx/ is absent
npx kbx init --vendor

# 3. Launch the dev server (opens http://localhost:5173)
npx kbx dev
```

**About step 2 (`init --vendor`):** it's an interactive wizard, but every prompt (owner / repo / branch / title / content mode / visual mode / theme) is pre-filled with values auto-detected from your git remote and branch — just press **Enter** through all of them to accept the defaults. It vendors a one-time copy of the template into `.kbx/`, runs `npm install` there, and writes `.env.kbx` (gitignored). Run it once per checkout; skip it if `.kbx/` already exists.

**About step 3 (`dev`):** it regenerates the manifest from local `content/`, the file tree, the README, and best-effort `gh` issues/PRs/commits, then starts Vite with `VITE_KB_LOCAL=true` and `--open`. The authored content in `content/` is what renders.

**How it works / why:** `dev` requires `.kbx/` because this repo isn't the template itself (its `package.json` name is `@anokye-labs/kbexplorer`, not `kbx`/`kbexplorer-template`). If you hit ``kbx not found. Run `kbx init` first``, run the init step above.

- **Production build:** `npx kbx build` (outputs to `dist/kb/`).
- **Headless verification:** with the dev server running, `node scripts/verify-self-kb.js` drives a headless browser and writes screenshots to `dist-screenshots/`.

See the [README](README.md) "Dogfood" section for more detail.

## Dogfooding kbx on This Repo

This repo is its own test bed: the authored pages in `content/` describe the CLI itself, and the dev server above renders them. The full content lifecycle is driven by the CLI commands below. **Every command here can be — and should be — run against this checkout to verify changes.**

### Prerequisite: Copilot CLI (for fuzzy phases)

`generate` and `derive` shell out to **GitHub Copilot CLI programmatic mode** (`copilot -p`) for their LLM phases. Install it from <https://docs.github.com/copilot/how-tos/copilot-cli> and confirm it's on your `PATH`:

```bash
copilot --version
which copilot                 # or: Get-Command copilot   (PowerShell)
```

If the binary lives somewhere else, point the CLI at it with `KBX_COPILOT_BIN=/full/path/to/copilot`. The deterministic commands (`scaffold`, `audit`, `affected`, `links`, `manifest`, `dev`, `build`, and `derive --check`) do **not** need Copilot and run fully offline.

Before invoking any fuzzy phase, preview the exact command the CLI will spawn — never run a Copilot-backed phase blind:

```bash
npx kbx generate --dry-run
npx kbx derive docs/samples/platform-squad.md --dry-run
```

The runtime adapter, router, and error codes (`BINARY_MISSING`, `TIMEOUT`, `NONZERO_EXIT`, `SPAWN_FAILED`, `INVALID_INPUT`) are documented in [`docs/copilot-runtime.md`](docs/copilot-runtime.md).

### Content Lifecycle Commands

Run all of these from the repo root (no `init` needed for the deterministic ones):

| Command | When to use | Needs Copilot? |
|---|---|---|
| `npx kbx generate` | First-time content bootstrap, or after a structural repo change. Drives `copilot -p` to build `catalogue.json`, then deterministically transforms it into `content/` + manifest. Use `--refresh` to force a re-run, `--no-agent` to only run the transform. | Yes (unless `--no-agent`) |
| `npx kbx scaffold <slug> --cluster <id> [--parent <id>] [--title …]` | Add **one** new page with valid frontmatter. Edit the body by hand or hand off to a writer playbook. | No |
| `npx kbx derive <source...>` | Extract entities/relationships from `.docx`/prose `.md`/`.txt` into committed `content/derived/*.jsonld`. Idempotent — re-running on an unchanged source reuses the embedded extraction and re-emits **byte-identical** output without calling the LLM. | Yes (first emit per source) |
| `npx kbx derive <source...> --check` | CI drift gate. Pass the **source** files (never the `.jsonld` outputs); exits non-zero if any artifact is missing, its source changed, or a fresh emit differs from the committed bytes. | No |
| `npx kbx affected <git-ref>` | After a code change, list which content nodes cite the changed files (`--json` for tooling). Tells you what to refresh. | No |
| `npx kbx audit` | Hard structural lint — duplicate ids, broken parents, parent cycles, dead connections, missing required frontmatter, undeclared clusters. **CI-grade**, exits non-zero on errors. `--json` for CI. | No |
| `npx kbx links` | Soft graph-health report — orphans, weak clusters, coverage gaps. Advisory only. | No |
| `npx kbx manifest` | Regenerate `public/manifest/local.json` from current `content/` without starting Vite. | No |
| `npx kbx update` | Pull the latest template version into `.kbx/`. For vendored installs it never silently clobbers — `--force` backs up the current copy to `.kbx.backup-<ts>`. | No |

### Keeping the Repo Content Up to Date (recommended loop)

After any code change in `src/`, `bin/`, or `scripts/`:

```bash
# 1. Find which content nodes cite the changed files
npx kbx affected HEAD~1

# 2. Refresh those pages. For a single page, follow the writer playbook at
#    .github/skills/kbx/references/writer-playbook.md (or update-node.md).
#    For multi-page diff-driven refresh, see incremental-refresh.md.

# 3. If a .docx or prose source under a derived path changed, refresh its artifact
npx kbx derive path/to/source.md --refresh

# 4. Validate structurally and as a graph
npx kbx audit
npx kbx links
npx kbx derive content/derived-sources/*.md --check   # drift gate

# 5. Confirm it renders
npx kbx dev
node scripts/verify-self-kb.js   # in a second shell while dev is running
```

The `derive --check` and `audit` commands are the two gates safe to run unattended in CI — neither calls Copilot, both exit non-zero on drift/structural errors.

### Testing the CLI Itself

The CLI is fully hermetic to test — the Copilot binary is stubbed via an injectable `spawn` seam and a real `tests/fixtures/mock-copilot.mjs` process. No live LLM is ever required by the test suite.

```bash
npm test                          # 194 tests, runs in ~1.5s
node bin/cli.js --help            # smoke-check command surface
node bin/cli.js audit             # CI-grade structural gate over content/
node bin/cli.js generate --dry-run    # prints the exact `copilot -p …` argv
node bin/cli.js derive docs/samples/platform-squad.md --check   # deterministic drift gate
```

If you change Copilot-runtime behaviour, also run a real `copilot -p` smoke through the adapter (with `--allow-all-tools` or scoped `--allow-tool`) and confirm the dogfood content still renders via `scripts/verify-self-kb.js`. Anything you can't verify locally — for example because the template isn't installed in your worktree — must be called out explicitly when you hand back control (see "When You Cannot Verify" below).

## Branch Protection Rules

The following rules are enforced on this repository's default branch:

- **Pull request required** — All changes must go through a pull request. Direct pushes to the default branch are blocked.
- **Conversation resolution required** — All PR review comments and conversations must be resolved before merging.
- **Force pushes blocked** — Force pushes to the default branch are not allowed.
- **Branch deletion blocked** — The default branch cannot be deleted.

### Workflow

1. Create a feature branch (use git worktrees when possible)
2. Make changes and commit
3. Open a pull request targeting the default branch
4. Address all review comments and resolve conversations
5. Get at least 1 approval — **except** PRs authored by the allowlisted bot
   accounts in `.github/workflows/auto-merge.yml` (currently
   `devin-ai-integration[bot]`, `copilot-swe-agent[bot]`, `Copilot`), which
   auto-merge at **0 human approvals** once the required status checks pass
   and all conversations are resolved. Human-authored PRs are never
   auto-merged. If you're an agent whose account isn't on that allowlist,
   don't assume auto-merge applies to you — check the workflow file.
6. Merge via the PR (squash or merge commit)

Never commit directly to the default branch. Never force push.

## Issue-First Workflow

**Every pull request must trace back to a GitHub Issue.** No PRs without issues. No direct commits to protected branches.

1. **Create an Issue** describing the work
2. **Create a branch** to implement
3. **Open a PR** that references the issue
4. **Review and merge** the PR, which closes the issue

See ["GitHub & Work-Item Conventions"](#github--work-item-conventions) below
for the commit-message-level rule (`refs #N`, never `closes #N`) and the
verify-before-close expectation — the "closes the issue" step above is about
the *reviewed PR description*, not individual commits along the way.

## Issue Types (Required)

**Every issue MUST have an Issue Type applied.** Use the organization-level issue types defined for `anokye-labs` — these are the actual GitHub Issue Type field, NOT labels and NOT title prefixes.

| Issue Type | Use When |
|------------|----------|
| **Epic** | Large initiatives spanning multiple features |
| **Feature** | User-facing capabilities or system components |
| **Task** | Concrete, actionable work items |
| **Bug** | Defects and fixes |

Labels are for metadata and categorization only. Never use labels or title prefixes like `[TASK]` or `[BUG]` as a substitute for issue types.

## Issue Relationships

### Parent-Child Hierarchy

Use GitHub's sub-issues to create parent-child relationships:

- **3-level:** Epic → Feature → Task (when work groups into features)
- **2-level:** Feature → Task or Epic → Task (when tasks are standalone)

Maximum nesting depth is 8 levels, maximum 100 sub-issues per parent.

### Blocking Relationships

Create `blocked-by` / `blocking` relationships between issues to track dependencies. Before starting work on any issue, verify its blocking dependencies are resolved.

### GraphQL Required

Use the GraphQL API for issue types, sub-issues, and relationship management. The REST API does not support these features. Include the `GraphQL-Features: sub_issues` header for sub-issue operations.

## GitHub & Work-Item Conventions

These rules are **tool-agnostic** — they describe outcomes, not a specific
CLI or SDK. Use whatever GitHub access your runtime actually has (a `gh` CLI
install, a GitHub MCP server, direct REST/GraphQL calls, or another agent
platform's built-in GitHub integration); none of the rules below assume one
particular mechanism.

- **GitHub access:** issue/PR reads and writes, comments, and label
  management can go through any of the mechanisms above. **Sub-issues and
  `blocked-by`/`blocking` relationships specifically require the GraphQL
  API** (see "GraphQL Required" above) — the REST API cannot express them
  regardless of which tool is issuing the request.
- **`refs #N`, never `closes #N`, in commit messages.** Reference the issue a
  commit addresses with `refs #N` so the link is visible without triggering
  GitHub's auto-close keywords. This matters most on a branch/PR that touches
  several issues across several commits — an early commit's auto-close
  keyword would close an issue before the rest of the branch (and review) is
  actually done. A PR's own description may use a closing keyword
  (`Closes #N`) once that PR is genuinely ready to merge and its own review
  confirms the issue is fully addressed — that is a deliberate, reviewed
  decision, not an accidental side effect of an intermediate commit message.
- **Verify before you close.** Never close an issue (or let a merge
  auto-close one) on the strength of "a commit referencing it merged" alone.
  Confirm the fix actually works per the "Verification and Validation"
  section below, then close explicitly (or let the reviewed PR description's
  closing keyword do it) — don't rely on an accidental close from an
  unrelated commit's keyword.
- **Conventional Commits.** Format commit messages as `type(scope):
  description` (`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
  `ci`, …). Keep commits atomic — one logical change per commit — and write
  messages that explain *why*, not just *what*.
- **Workback scheduling / work breakdown.** When a task calls for turning an
  epic or a large piece of work into a real Epic → Feature → Task hierarchy
  of GitHub issues (types, sub-issues, `blocked-by` edges) *before*
  implementation starts, use the `wbs-builder` skill/playbook from
  `kbexplorer-template`'s [`.agents/skills/wbs-builder/`](https://github.com/anokye-labs/kbexplorer-template/tree/main/.agents/skills/wbs-builder)
  rather than improvising an ad hoc issue-creation script.

## Delegating Work to an Agent

This org is worked by multiple AI coding agents, not just one — treat the
delegation mechanics below as tool-agnostic. To hand an issue to an
agent:

1. Create the issue with proper type, description, and relationships
2. Assign it to whichever agent (or agent-backed account, e.g. `@copilot`) is
   set up to pick up issues in this repo
3. The agent picks up the issue and opens a PR referencing it

`@copilot` is one available option, not "the" preferred one — pick whichever
agent fits the task. Separately, and unconditionally regardless of which agent
runs it: `generate` and `derive`'s fuzzy phases have a hard **runtime**
dependency on GitHub Copilot CLI (`copilot -p`), documented under
["Prerequisite: Copilot CLI"](#prerequisite-copilot-cli-for-fuzzy-phases)
above — that is a factual dependency of those two commands, independent of
which agent is doing the delegating or the implementing.

## Verification and Validation

**Agents must verify their own work thoroughly before handing back control.** Writing code and hoping it works is not acceptable. Verification goes beyond running unit tests — it means confirming the system actually behaves correctly end-to-end.

### Verification Expectations

1. **Build and test** — Run the build and all existing tests. Fix failures before declaring done.
2. **Runtime verification** — If the change affects runtime behavior, run the application and confirm it works. Don't just assume passing tests means the system is correct.
3. **Web UI verification** — If web pages or browser-based interfaces are involved, use the **Playwright CLI** skill to navigate, interact, screenshot, and validate the UI behaves correctly.
4. **Desktop/GUI verification** — If desktop GUI or graphical applications are involved, check whether your runtime has access to a **computer-use MCP server** (availability depends on which agent/runtime you are). If available, use it to interact with and verify the GUI. If not available and you believe you need it, **ask the user to install it**.
5. **Integration verification** — If the change involves APIs, services, or external systems, make real calls and confirm responses. Don't mock what you can test live.

### When You Cannot Verify

If you cannot fully verify your work — due to missing tools, environment limitations, or access constraints:

1. **State it explicitly.** When you hand back control, clearly list what you were NOT able to validate.
2. **Explain why.** Say what tool, access, or capability you were missing.
3. **Ask for help.** If a tool or MCP server would enable verification, ask the user to install or configure it before you proceed.
4. **Never claim "done" without disclosure.** An honest "I could not verify X because Y" is always better than a silent gap.

### Available Verification Tools

| Scenario | Tool | How to Access |
|----------|------|---------------|
| Web pages / browser UI | Playwright CLI | Use the `playwright-cli` skill |
| Desktop GUI / graphical apps | Computer Use MCP | Check MCP server availability; ask user to install if needed |
| API endpoints | curl / Invoke-RestMethod | Direct HTTP calls |
| Build / test suites | Project build system | `dotnet test`, `npm test`, `pytest`, `cargo test`, etc. |
| File system / output | Direct inspection | Read and verify output files, logs, generated artifacts |

**Bottom line:** Do as much as possible to verify. Ask for help if you can't. Be transparent about what remains unverified.

