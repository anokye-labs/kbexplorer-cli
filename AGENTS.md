# kbexplorer-cli

## Running the Site Locally

This repo (`@anokye-labs/kbexplorer`) is the **CLI**, not the visual explorer app. The explorer is the separate `anokye-labs/kbexplorer-template` repo, which the CLI installs into `.kbexplorer/`. Because of this, `kbexplorer dev` only works once `.kbexplorer/` exists — otherwise it exits with ``✗ kbexplorer not found. Run `kbexplorer init` first.``

Requirements: Node >= 22 and network access (the one-time setup clones the template repo).

```bash
# 1. Pull latest
git pull

# 2. One-time setup — only if .kbexplorer/ is absent
npx kbexplorer init --vendor

# 3. Launch the dev server (opens http://localhost:5173)
npx kbexplorer dev
```

**About step 2 (`init --vendor`):** it's an interactive wizard, but every prompt (owner / repo / branch / title / content mode / visual mode / theme) is pre-filled with values auto-detected from your git remote and branch — just press **Enter** through all of them to accept the defaults. It vendors a one-time copy of the template into `.kbexplorer/`, runs `npm install` there, and writes `.env.kbexplorer` (gitignored). Run it once per checkout; skip it if `.kbexplorer/` already exists.

**About step 3 (`dev`):** it regenerates the manifest from local `content/`, the file tree, the README, and best-effort `gh` issues/PRs/commits, then starts Vite with `VITE_KB_LOCAL=true` and `--open`. The authored content in `content/` is what renders.

**How it works / why:** `dev` requires `.kbexplorer/` because this repo isn't the template itself (its `package.json` name is `@anokye-labs/kbexplorer`, not `kbexplorer`/`kbexplorer-template`). If you hit ``kbexplorer not found. Run `kbexplorer init` first``, run the init step above.

- **Production build:** `npx kbexplorer build` (outputs to `dist/kb/`).
- **Headless verification:** with the dev server running, `node scripts/verify-self-kb.js` drives a headless browser and writes screenshots to `dist-screenshots/`.

See the [README](README.md) "Dogfood" section for more detail.

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
5. Get at least 1 approval
6. Merge via the PR (squash or merge commit)

Never commit directly to the default branch. Never force push.

## Issue-First Workflow

**Every pull request must trace back to a GitHub Issue.** No PRs without issues. No direct commits to protected branches.

1. **Create an Issue** describing the work
2. **Create a branch** to implement
3. **Open a PR** that references the issue
4. **Review and merge** the PR, which closes the issue

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

## Delegating Work to Copilot

**Assigning issues to `@copilot` is the preferred way to get work done.** To delegate:

1. Create the issue with proper type, description, and relationships
2. Edit the issue and assign it to `@copilot`
3. Copilot will pick up the issue and open a PR

## Verification and Validation

**Agents must verify their own work thoroughly before handing back control.** Writing code and hoping it works is not acceptable. Verification goes beyond running unit tests — it means confirming the system actually behaves correctly end-to-end.

### Verification Expectations

1. **Build and test** — Run the build and all existing tests. Fix failures before declaring done.
2. **Runtime verification** — If the change affects runtime behavior, run the application and confirm it works. Don't just assume passing tests means the system is correct.
3. **Web UI verification** — If web pages or browser-based interfaces are involved, use the **Playwright CLI** skill to navigate, interact, screenshot, and validate the UI behaves correctly.
4. **Desktop/GUI verification** — If desktop GUI or graphical applications are involved and you're running in Copilot CLI, check for the availability of the **computer-use MCP server**. If available, use it to interact with and verify the GUI. If not available and you believe you need it, **ask the user to install it**.
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
