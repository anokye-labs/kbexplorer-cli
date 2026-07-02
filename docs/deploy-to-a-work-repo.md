# Deployment Runbook — KB Explorer in a Work Repo

Step-by-step guide for deploying KB Explorer into an enterprise work repository.
This document records the path proven in the [pilot rehearsal](./pilot-rehearsal.md).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Initialize the work repo](#2-initialize-the-work-repo)
3. [Author the work-graph YAML](#3-author-the-work-graph-yaml)
4. [Local-first fuzzy regeneration loop](#4-local-first-fuzzy-regeneration-loop)
5. [Regenerate the manifest](#5-regenerate-the-manifest)
6. [Production build](#6-production-build)
7. [Hosting options](#7-hosting-options)
8. [Troubleshooting with `kbx doctor`](#8-troubleshooting-with-kbx-doctor)

---

## 1. Prerequisites

### 1.1 Node.js

KB Explorer requires Node.js **≥ 22**.

```bash
node --version   # must print v22.x.x or higher
```

### 1.2 GitHub CLI (`gh`)

The CLI uses `gh api` for GitHub data unless you override the API base (see §2.4).

```bash
gh --version
gh auth status   # must show "Logged in to github.com"
```

#### GitHub Enterprise (GHE / EMU)

If your work repo lives on a GHE or EMU host, authenticate the `gh` CLI against it
and set `GH_HOST`:

```bash
gh auth login --hostname github.example.com
export GH_HOST=github.example.com
```

Or bypass `gh` entirely with a direct-HTTP override and a PAT (see §2.4).

### 1.3 Agent runtime

The `generate` and `derive` commands delegate their fuzzy (LLM) analysis to a
configured agent runtime. One of the three must be available on your machine:

| Runtime | Binary | Install |
|---------|--------|---------|
| **Copilot** (default) | `copilot` | [GitHub Copilot CLI docs](https://docs.github.com/copilot/how-tos/copilot-cli) |
| **Claude** | `claude` | [Claude Code](https://claude.ai/download) |
| **Custom** | any | configure in `.kbx.json` |

The fuzzy step runs **locally under your identity** — it is never invoked in CI.

#### MCP servers (if your agent uses them)

If your agent needs MCP servers (e.g. ADO, SharePoint), install and configure
them before running `generate` or `derive`. The CLI verifies declared servers
via MCP preflight and exits early with actionable errors if they are missing.

Declare the servers you need in `.kbx.json` after `init`:

```jsonc
{
  "runtime": {
    "agent": "copilot",
    "mcp": {
      "required": ["ado"],          // preflight fails if missing
      "optional": ["org-chart"]     // warning only
    }
  }
}
```

Detection locations per adapter:

| Adapter | Config file checked |
|---------|---------------------|
| `copilot` | `~/.copilot/mcp-config.json` |
| `claude` | `<repo>/.mcp.json`, then `~/.claude.json` (project entries) |
| `custom` | Not detectable — all declared servers are reported as unverifiable (warning, not failure) |

---

## 2. Initialize the work repo

### 2.1 Run `init`

From the root of your work repository:

```bash
npx @anokye-labs/kbx init
```

The interactive wizard walks through:

1. **Template install** — adds `.kbx/` as a pinned git submodule (default)
   or a one-time vendored copy (`--vendor`).
2. **Agents and skills** — copies `kb-architect`, `kb-writer`, and `kb-researcher`
   to `.github/agents/`, and the `kbx` skill to `.github/skills/kbx/`.
3. **Config** — writes `.env.kbx` with owner/repo/branch/title and adds
   `kb:dev`, `kb:build`, `kb:generate` npm scripts.
4. **Runtime selection** — records your chosen agent runtime in `.kbx.json`.

#### Submodule vs. vendor mode

| Mode | Flag | Best for |
|------|------|----------|
| **Submodule** (default) | _(none)_ | Track upstream as-is; `kbx update` bumps the pin |
| **Vendor** | `--vendor` | Copy-and-customize; `.kbx/` committed to the work repo |

For most enterprise work repos where you do not plan to customize the template,
the **submodule** mode is recommended.

```bash
# Submodule mode (default)
npx @anokye-labs/kbx init

# Vendor mode
npx @anokye-labs/kbx init --vendor

# Pin to a specific template release
npx @anokye-labs/kbx init --ref v1.2.0
```

#### Non-interactive / scripted init

For scripted or CI environments, pass `--yes` to take every answer from flags
plus git-remote detection instead of prompting. Without `--yes`, a non-TTY
stdin makes `init` exit with a clear reminder (it no longer hangs):

```bash
npx @anokye-labs/kbx init --yes --owner acme --repo widgets --title "Acme KB"
```

See `npx kbx init --help` for all non-interactive flags (`--kb-branch`,
`--content-mode`, `--visual`, `--theme`, `--runtime`, `--config <file>`, …).
Alternatively, run `init` interactively on a developer machine first to produce
`.env.kbx` and `.kbx.json`, then commit those files.

### 2.2 Commit the scaffold

```bash
git add .kbx .gitmodules .env.kbx .kbx.json \
        .github/agents .github/skills package.json
git commit -m "chore: add kbx scaffold"
```

### 2.3 Verify the install

Run `doctor` immediately after `init`:

```bash
npx kbx doctor
```

All sections should be green (or warn-only). See [§8](#8-troubleshooting-with-kbx-doctor) for remediation.

### 2.4 GitHub Enterprise / EMU: API base override

When your work repo is on GHE or EMU and you want to avoid `gh` auth handshake
complexity, use the direct-HTTP path:

```bash
# Runtime env var (one-off)
KBX_GH_API_BASE=https://github.example.com/api/v3 \
KBX_GH_TOKEN=<personal-access-token> \
npx kbx manifest

# Or persist it in .kbx.json (travels with the repo)
```

Add to `.kbx.json`:

```jsonc
{
  "template": "...",
  "mode": "submodule",
  "ghApiBase": "https://github.example.com/api/v3"
}
```

Token precedence (when `ghApiBase` is set):

| Priority | Source |
|----------|--------|
| 1 | `KBX_GH_TOKEN` env var |
| 2 | `GH_TOKEN` env var |
| 3 | Anonymous (no `Authorization` header) |

---

## 3. Author the work-graph YAML

KB Explorer's organizational layer is driven by **five descriptor kinds** stored
as YAML files in your `content-model/` directory. These files are the primary
input for the graph — they are durable (not regenerated per planning cycle) and
authored by hand.

See [`docs/templates/`](./templates/) for copy-paste starter files with inline
comments for each kind. The authoritative field contract is in
[`docs/work-graph-vocabulary.md`](https://github.com/anokye-labs/kbexplorer-template/blob/main/docs/work-graph-vocabulary.md)
in the template repo.

### Directory layout

```
content-model/
├── teams/
│   └── <id>.yaml           # one file per team
├── workstreams/
│   └── <id>.yaml           # one file per workstream
├── priorities/
│   └── <id>.yaml           # one file per priority level
├── people/
│   └── <id>.yaml           # one file per person
└── systems-of-record/
    └── <id>.yaml           # one file per system-of-record (ADO board, GH repo, etc.)
```

### Minimum viable graph

A three-file starter is enough to produce a renderable graph:

1. `priorities/p1.yaml` — at least one priority level
2. `teams/platform.yaml` — at least one team
3. `workstreams/platform-kb.yaml` — at least one workstream referencing the team and priority

Start there, validate with `audit`, then expand.

### Adding unstructured sources

For `.docx`, prose Markdown, or loosely-structured text files you want to extract
entities from, use `kbx derive`:

```bash
npx kbx derive docs/org-chart.docx docs/team-charter.md
```

This calls the configured agent runtime (LLM) once per source, extracts entities
and relationships into `content/derived/*.jsonld`, and embeds the extraction for
future reuse (no LLM call on unchanged input). See `kbx derive --help`.

---

## 4. Local-first fuzzy regeneration loop

The fuzzy `generate` step — which calls the LLM to analyze the repo and emit
`catalogue.json` — always runs **locally under your own identity and MCP
configuration**. It is never invoked in CI. This is intentional: the LLM needs
access to your authenticated MCP servers, and the results are committed artifacts
that CI can validate deterministically.

### Typical loop

```bash
# Step 1: (Optional) verify the environment first
npx kbx doctor

# Step 2: Run the agent to produce catalogue.json, then transform → content/
npx kbx generate

# Step 3: Preview locally
npx kbx dev

# Step 4: Audit structural integrity
npx kbx audit

# Step 5: Commit catalogue.json + content/ when satisfied
git add catalogue.json content/
git commit -m "chore(kb): regenerate catalogue"
```

### Runtime selection

The active runtime is resolved in this order (highest wins):

| Priority | Source |
|----------|--------|
| 1 | `--runtime <name>` flag on the command |
| 2 | `runtime` block in `.kbx.json` |
| 3 | `KBX_RUNTIME` env var |
| 4 | Default: `copilot` |

```bash
# Use Claude for this run only
npx kbx generate --runtime claude

# Preview what the agent command would look like without running it
npx kbx generate --dry-run
```

### Refresh an existing catalogue

```bash
# Re-run analysis even if catalogue.json already exists
npx kbx generate --refresh

# Skip the agent step and just re-transform an existing catalogue
npx kbx generate --no-agent
```

### Binary path overrides

If the runtime binary is not on `PATH`, set the relevant env var:

```bash
KBX_COPILOT_BIN=/usr/local/bin/copilot npx kbx generate
KBX_CLAUDE_BIN=/opt/claude/bin/claude npx kbx generate --runtime claude
```

---

## 5. Regenerate the manifest

The manifest captures a snapshot of the repo's GitHub data (issues, PRs, releases,
commits, file tree) for the explorer's in-app views.

```bash
npx kbx manifest
```

The manifest is written to `.kbx/src/generated/repo-manifest.json` (or the
equivalent path in your install). It is regenerated automatically during `build`.

### GHE / EMU

```bash
KBX_GH_API_BASE=https://github.example.com/api/v3 \
KBX_GH_TOKEN=<pat> \
npx kbx manifest
```

---

## 6. Production build

`kbx build` generates the manifest, then runs Vite to produce a static SPA.

```bash
npx kbx build
```

Output: `dist/kb/` (relative to the work repo root for non-template repos).

> **Note:** `build` requires the template's `node_modules` to be installed.
> In vendored installs without `npm install`, run `npm install` inside
> `.kbx/` first, or use the submodule mode which installs deps during `init`.

### Custom base path (sub-directory hosting)

```bash
npx kbx build --base /my-kb/
```

This passes `--base` to Vite. Use it when hosting under a path prefix (e.g.
GitHub Pages at `/<repo>/` or an Azure SWA custom domain with a sub-path).

> **Status note:** The full `build` + browser-verify path (Playwright smoke test
> via `scripts/verify-self-kb.js`) requires a running dev server and a fully
> installed template. In the pilot rehearsal this step was deferred because the
> vendored fixture lacked `node_modules`. The pilot rehearsal did verify `doctor`,
> `generate`, `audit`, and `manifest` end-to-end.

---

## 7. Hosting options

All three options receive the same static files from `dist/kb/`. The explorer is
a client-side SPA — it needs no server-side rendering. GitHub Actions is the
recommended CI driver.

### 7.1 GitHub Pages

**Best for:** public repos, or private repos on plans that include private Pages.

1. Enable GitHub Pages in the repo settings (source: `gh-pages` branch or
   `Actions` runner).
2. Add a workflow:

```yaml
# .github/workflows/deploy-kb.yml
name: Deploy KB Explorer

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive   # needed for submodule mode

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install template deps
        run: npm install --no-audit --no-fund
        working-directory: .kbx

      - name: Build
        run: npx kbx build --base /${{ github.event.repository.name }}/

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist/kb

      - name: Deploy to Pages
        uses: actions/deploy-pages@v4
```

**Private-repo note:** GitHub Pages for private repos requires a GitHub Team or
Enterprise plan. If unavailable, use Azure SWA or an internal static host instead.

### 7.2 Azure Static Web Apps (SWA)

**Best for:** enterprise environments with Azure, internal auth (AAD), or private
access requirements.

1. Create an Azure Static Web App resource pointing at your repo.
2. In the SWA configuration, set the app location to `.` and the output location
   to `dist/kb`.
3. Add the SWA deployment token as a repo secret (`AZURE_STATIC_WEB_APPS_API_TOKEN`).
4. The SWA GitHub Action handles build and deploy automatically.

**Auth note:** Azure SWA supports AAD-backed authentication out of the box. For
internal-only access, configure the `allowedRoles` in `staticwebapp.config.json`.

```json
{
  "routes": [
    {
      "route": "/*",
      "allowedRoles": ["authenticated"]
    }
  ],
  "auth": {
    "identityProviders": {
      "azureActiveDirectory": {
        "userDetailsClaim": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
        "registration": {
          "openIdIssuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
          "clientIdSettingName": "AAD_CLIENT_ID",
          "clientSecretSettingName": "AAD_CLIENT_SECRET"
        }
      }
    }
  }
}
```

> **EMU copy-paste CI recipe:** For a single, ready-to-copy workflow that wires
> the deterministic PR gates (`audit` + `validate` + `derive --check`) ahead of
> a `build` + Azure SWA/AAD deploy — with `submodules: recursive` and the
> `ghApiBase`/token wiring for an EMU host — see
> [`emu-ci-recipe.md`](./emu-ci-recipe.md) and the copyable files under
> [`recipes/`](./recipes/). You substitute secrets/host values only.

### 7.3 Internal static host

**Best for:** air-gapped or on-prem environments where GitHub Pages and Azure are
not options.

1. Build the static files (`dist/kb/`).
2. Copy `dist/kb/` to your web server's document root (nginx, Apache, IIS, etc.).
3. Configure the server to return `index.html` for all unknown paths (SPA routing).

**nginx example:**

```nginx
location /kb-explorer/ {
    alias /var/www/kb-explorer/;
    try_files $uri $uri/ /kb-explorer/index.html;
}
```

**Token / auth note:** The explorer itself is a static site — it does not make
authenticated API calls at runtime. All GitHub data is baked into the manifest
at build time. If the manifest build needs access to a private GHE repo, provide
`KBX_GH_TOKEN` as a CI secret (not a client-side variable).

---

## 8. Troubleshooting with `kbx doctor`

`kbx doctor` is the first command to run when anything looks wrong. It
diagnoses five sections and exits non-zero if any check fails.

```bash
npx kbx doctor
npx kbx doctor --runtime claude    # check a specific adapter
npx kbx doctor --json             # machine-readable output
npx kbx doctor --offline          # skip the latest-tag network check
```

### 8.1 What each section checks

**Runtime**
- Which adapter is selected and why (flag, config, env, or default)
- Whether the binary is on `PATH` and what version it reports

**MCP**
- Whether each server declared in the `mcp` block is configured in the adapter's
  config file(s)
- Required servers missing → `❌ fail`; optional servers missing → `⚠️ warn`

**Template**
- Whether `.kbx.json` is present and parseable
- (Submodule mode) Whether `.gitmodules` agrees with `.kbx.json`
- Whether the template is on a release tag, a branch, or tracking latest

**Adoption readiness**
- Which structured-content path is configured (future `.kbx.json` fields,
  `VITE_KB_CONTENT_MODEL`, `.env.kbx`, then the default `content-model/`)
- Whether that path exists and contains YAML descriptors
- Whether likely misnamed descriptor folders exist elsewhere
- Local/remote parity risks, such as non-committed env-only path overrides
- Template capability/protocol metadata when advertised, or a warning that the
  template has not advertised it yet

**Environment**
- Node.js version meets the `>=22` requirement
- `git` is on `PATH`
- `gh` (GitHub CLI) is on `PATH`
- `content/` directory exists
- `repo-manifest.json` is present and not stale relative to HEAD

### 8.2 Common failures and remediation

#### `❌ Binary "copilot" not found on PATH`

The Copilot CLI is not installed or not on your shell's `PATH`.

```
Runtime
───────
  ✅ Adapter: copilot (source: default)
  ✅ Binary: copilot
  ❌ Binary "copilot" not found on PATH — install from https://docs.github.com/copilot/how-tos/copilot-cli
```

Fix: install the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli),
or switch to the Claude adapter (`--runtime claude`), or set `KBX_COPILOT_BIN`
to the full path of an existing binary.

#### `❌ Required server "ado": NOT configured for copilot`

A server declared in `runtime.mcp.required` is absent from the adapter's config.

```
MCP
───
  ❌ Required server "ado": NOT configured for copilot
     Expected in: ~/.copilot/mcp-config.json
     Example entry:
       { "mcpServers": { "ado": { "command": "npx", "args": ["-y", "ado-mcp"] } } }
```

Fix: add the server entry to `~/.copilot/mcp-config.json` (copilot) or
`.mcp.json` in the repo root (claude), then re-run `doctor` to confirm.

#### `⚠️ .kbx.json not found — run kbx init`

`init` has not been run yet, or the file was deleted.

```
Template
────────
  ⚠️  .kbx.json not found — run kbx init to create it
```

Fix: run `npx kbx init`.

#### `⚠️ Template tracks branch "main" — consider pinning to a release tag`

The template was installed from a branch rather than a versioned release tag.
This is non-fatal but makes builds less reproducible.

```
Template
────────
  ✅ .kbx.json present (mode: submodule, template: …)
  ⚠️  Template tracks branch "main" — consider pinning to a release tag for reproducibility
```

Fix: run `npx kbx update --ref <tag>` to pin to a specific release, or
re-init with `npx kbx init --ref v1.2.0`.

#### `⚠️ A newer release tag exists: v1.0.0 → v1.1.0`

A newer template version is available.

```
Template
────────
  ⚠️  A newer release tag exists: v1.0.0 → v1.1.0 (run kbx update)
```

Fix: `npx kbx update` to pull the latest template version.

#### `⚠️ repo-manifest.json may be stale`

The manifest was generated before the latest commit.

```
Environment
───────────
  ⚠️  repo-manifest.json may be stale (generated 2026-01-01T00:00:00.000Z, HEAD is newer)
```

Fix: run `npx kbx manifest` to regenerate it.

#### `⚠️ content/ directory not found`

No content has been generated yet.

```
Environment
───────────
  ⚠️  content/ directory not found
```

Fix: run `npx kbx generate` (or `npx kbx generate --no-agent` if
`catalogue.json` already exists).

#### `❌ Node v20.x.x is below required >=22`

Node.js version is too old.

Fix: install Node.js 22 or later (use `nvm`, `fnm`, or your system package manager).

#### `❌ Failed to resolve runtime adapter: …`

The `.kbx.json` has an invalid `runtime` block (unknown agent, missing
`command` for custom, etc.).

Fix: edit `.kbx.json` to correct the `runtime` block. Valid shapes are
documented in the [Runtime Configuration](../README.md#runtime-configuration)
section of the README. Or re-run `npx kbx init` to rewrite it interactively.
