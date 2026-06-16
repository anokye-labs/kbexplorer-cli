# kbexplorer Configuration Reference

Complete reference for `config.yaml` — the configuration file that controls
kbexplorer's behavior, appearance, and content.

## Location

- **Authored mode**: `{source.path}/config.yaml` (e.g., `content/config.yaml`)
- **Repo-aware mode**: `content/config.yaml` in the target repo

## Full Schema

```yaml
# Display metadata
title: "My Knowledge Base"          # Required. Page title and header text.
subtitle: "An explorable guide"     # Optional. Shown below the title.
author: "Your Name"                 # Optional. Attribution.
date: "2025"                        # Optional. Date string.

# Content source
source:
  owner: your-org                   # Required. GitHub owner (org or user).
  repo: your-repo                   # Required. GitHub repository name.
  path: content                     # Optional. Content directory for authored mode.
                                    #   Omit for repo-aware mode.
  branch: main                      # Optional. Git branch (default: main).

# Cluster definitions — group nodes by topic
clusters:
  cluster-key:                      # Key referenced in node frontmatter.
    name: "Display Name"            # Human-readable cluster name.
    color: "#4A9CC8"                # Hex color for cluster visuals.

# Visual identity system
visuals:
  mode: emoji                       # Primary visual mode.
                                    #   Options: sprites | heroes | emoji | none
  fallback: emoji                   # Fallback when primary asset is missing.
  hero:                             # Heroes mode settings (optional).
    overlay: dark-gradient           #   Overlay style: dark-gradient | light-gradient | none
    height: "300px"                  #   Hero image height.
    animation: reveal                #   Animation: reveal | fade | none
  hud:                              # HUD visual settings (optional).
    blurBackground: true             #   Enable backdrop blur on HUD.
    blurOpacity: 0.8                 #   Blur opacity (0-1).
  graph:                            # Graph view settings (optional).
    nodeImages: true                 #   Show images on graph nodes.
    nodeSizeByConnections: true      #   Scale node size by connection count.

# Theme configuration
theme:
  default: dark                     # Default theme: dark | light | sepia
  font:                             # Optional font overrides.
    heading: "Instrument Serif"      #   Heading font family.
    body: "General Sans"             #   Body text font family.
    mono: "JetBrains Mono"           #   Code/monospace font family.

# Graph physics and layout
graph:
  physics: true                     # Enable physics simulation.
  layout: force-atlas-2             # Layout algorithm: force-atlas-2 | manual

# Feature flags
features:
  hud: true                        # Show the HUD (minimap + related nodes).
  minimap: true                    # Show minimap in HUD.
  readingTools: true               # Show reading tools (copy, highlight, etc.).
  keyboardNav: true                # Enable keyboard navigation shortcuts.
  sparkAnimation: false            # Enable spark animation on nodes.

# BLUF (Bottom Line Up Front) — optional intro screen
bluf:
  quote: "Knowledge is the path."  # Quote shown on intro screen.
  duration: "5s"                   # How long the intro screen displays.
  audio: "assets/intro.mp3"        # Optional audio file for intro.
```

## Cluster Best Practices

Define clusters that match the natural categories of content:

**For repo-aware mode** (issue labels become clusters):
```yaml
clusters:
  feature:
    name: Feature
    color: "#4A9CC8"
  bug:
    name: Bug
    color: "#C04040"
  enhancement:
    name: Enhancement
    color: "#8CB050"
  documentation:
    name: Documentation
    color: "#D4A050"
```

**For authored mode** (define your own taxonomy):
```yaml
clusters:
  concept:
    name: Concepts
    color: "#4A9CC8"
  tutorial:
    name: Tutorials
    color: "#8CB050"
  reference:
    name: Reference
    color: "#E8A838"
  example:
    name: Examples
    color: "#A86FDF"
```

Clusters not defined in config but present in content are auto-generated with
colors from a built-in palette.

## Environment Variables

These Vite env vars override config values at build/dev time:

| Variable | Purpose | Example |
|----------|---------|---------|
| `VITE_KB_OWNER` | GitHub owner | `my-org` |
| `VITE_KB_REPO` | GitHub repo name | `my-project` |
| `VITE_KB_BRANCH` | Target branch | `main` |
| `VITE_KB_PATH` | Content directory | `content` |
| `VITE_KB_TITLE` | Page title | `My KB` |
| `VITE_BASE_PATH` | Deployment base path | `/docs/kb/` |
| `VITE_ENV_DIR` | Directory to load .env from | `../../` |

These are typically set in `.env.kbexplorer` by the init script.

## Runtime Block (`.kbexplorer.json`)

The optional `runtime` block in `.kbexplorer.json` sets a repo-local default
for which agent runtime to use in fuzzy (LLM) steps (`generate`, `derive`).
It travels with the repo so a team's tooling choice is version-controlled.

### Selection Precedence

| Priority | Source | Example |
|----------|--------|---------|
| 1 | `--runtime <name>` CLI flag | `kbexplorer derive --runtime claude` |
| 2 | `runtime` block in `.kbexplorer.json` | (this section) |
| 3 | `KBEXPLORER_RUNTIME` env var | `KBEXPLORER_RUNTIME=claude …` |
| 4 | Default | `copilot` |

### Shape

```jsonc
{
  // …existing template-source fields…
  "runtime": {
    // Required. Named adapter: "copilot" | "claude" | "custom"
    "agent": "copilot",

    // The fields below are ONLY valid when agent = "custom"
    "command": "my-agent",                    // Required for custom
    "argsTemplate": ["-p", "{prompt}"],       // Required for custom; must contain {prompt}
    "outputFormat": "text",                   // "text" | "jsonl"  (optional, default "text")
    "timeoutMs": 600000,                      // Positive number, ms (optional)
    "binaryEnv": "MY_AGENT_BIN"              // Env var for binary override (optional)
  }
}
```

### Examples

**Use Claude instead of Copilot:**
```json
{ "runtime": { "agent": "claude" } }
```

**Custom agent with JSONL output:**
```json
{
  "runtime": {
    "agent": "custom",
    "command": "my-llm",
    "argsTemplate": ["--prompt", "{prompt}", "--output-format", "jsonl"],
    "outputFormat": "jsonl",
    "timeoutMs": 300000
  }
}
```

### Validation

The CLI validates the block on load and emits an actionable error for:

- Unknown `agent` value (valid: `"copilot"`, `"claude"`, `"custom"`)
- `agent: "custom"` without `command` or `argsTemplate`
- `argsTemplate` not containing the `{prompt}` placeholder
- Non-string entries in `argsTemplate`
- `outputFormat` not `"text"` or `"jsonl"`
- `timeoutMs` not a positive number
- `command`, `argsTemplate`, `outputFormat`, or `binaryEnv` specified for a non-custom agent

### Binary Path Overrides

These env vars override the binary path for the named adapters and are
orthogonal to runtime selection:

| Env var | Adapter |
|---------|---------|
| `KBEXPLORER_COPILOT_BIN` | `copilot` |
| `KBEXPLORER_CLAUDE_BIN` | `claude` |

### MCP Server Requirements (`runtime.mcp`)

Declare which MCP servers the pipeline depends on. The CLI verifies these are
configured **before** any LLM call or partial write; a missing required server
exits non-zero with an actionable message. Valid for any agent.

```jsonc
{
  "runtime": {
    "agent": "copilot",
    "mcp": {
      "required": ["ado", "sharepoint-docs"],   // preflight fails if missing
      "optional": ["org-chart"]                  // warning only; never fails
    }
  }
}
```

Entries must be non-empty strings; duplicates within a list, or the same name
in both lists, are rejected at config-load time.

#### Detection by adapter (filesystem-only, no process spawning)

| Adapter | Config checked |
|---------|----------------|
| `copilot` | `~/.copilot/mcp-config.json` (top-level `mcpServers` keys — the file Copilot CLI reads; no repo-local MCP config exists today) |
| `claude` | `<repo>/.mcp.json` (`mcpServers` keys), then `~/.claude.json` project entries matching the current directory |
| `custom` | Not detectable — declared servers are reported as unverifiable (warning, not failure) |

Both adapters' config files use the same entry shape:

```json
{ "mcpServers": { "ado": { "command": "npx", "args": ["-y", "ado-mcp"] } } }
```

#### `--skip-preflight`

Development escape hatch for `derive` and `generate`: bypasses the MCP check
with a warning. Never use in CI or on shared branches.

Preflight never runs on no-LLM paths: `derive --check`, `--dry-run`,
`generate --no-agent`, or when every derive source is served from a fresh
committed artifact.

### Diagnosing local setup (`kbexplorer doctor`)

When regeneration fails, run `kbexplorer doctor` before filing a bug. It
checks all four layers in one command and tells you exactly what is wrong:

```bash
kbexplorer doctor                   # full diagnosis against the repo's config
kbexplorer doctor --runtime claude  # check a specific adapter
kbexplorer doctor --json            # machine-readable output for tooling
kbexplorer doctor --offline         # skip the latest-tag network call
```

Sections reported: **Runtime** (adapter selected, why, binary, version),
**MCP** (per-server check for each required/optional server),
**Template** (`.kbexplorer.json` vs `.gitmodules`, pinned ref vs latest tag),
**Environment** (node version, `git`/`gh` on PATH, content dir, manifest freshness).

Exit code `0` means all checks passed or warned. Exit code `1` means at least
one check failed — safe to use as a CI gate.
