---
name: kbexplorer
description: >-
  This skill should be used when the user asks to "set up KB explorer",
  "add a knowledge base", "explore this repo", "visualize the knowledge graph",
  "bootstrap kbexplorer", "configure kbexplorer", "run the knowledge base",
  "view issues as a graph", "browse repo knowledge", or mentions kbexplorer,
  knowledge base explorer, or knowledge graph visualization. Provides guidance
  for setting up, configuring, and running the kbexplorer interactive knowledge
  base tool — either as a submodule in another repo or self-hosted.
version: 0.1.0
---

# kbexplorer — Interactive Knowledge Base Explorer

kbexplorer transforms any GitHub repository into a navigable, interactive knowledge graph.
It visualizes issues, pull requests, README files, source directories, and hand-authored
markdown as an interconnected constellation — explorable through card grids, force-directed
networks, and deep-dive reading views.

## When to Use

Activate this skill when a user wants to:
- Set up kbexplorer in a new or existing repo
- Configure content modes, visuals, or themes
- Launch the explorer dev server or build for deployment
- Author knowledge base content (markdown with YAML frontmatter)
- Troubleshoot kbexplorer setup issues

## Setup Flow

The setup is fully agent-driven. The agent executes every step — the user only
answers configuration questions during the interactive wizard.

### Self-Hosted Mode (kbexplorer repo itself)

If the current repo IS kbexplorer (check `package.json` name or git remote), skip submodule
setup. Run the init wizard directly, then start the dev server and validate:

```bash
node scripts/init.js      # interactive config questions
npm run dev               # agent starts this
# agent validates with playwright-cli
```

### Submodule Mode (any other repo)

The agent performs these steps in order:

1. **Add the submodule** (agent runs this):
   ```bash
   git submodule add https://github.com/anokye-labs/kbexplorer.git .kbexplorer
   ```

2. **Run the interactive init wizard** (user answers config questions):
   ```bash
   node .kbexplorer/scripts/init.js
   ```
   The wizard asks about content mode, title, visual style, theme, and features.
   It creates `.env.kbexplorer`, `content/config.yaml`, adds npm scripts, and
   installs dependencies automatically.

3. **Start the explorer** (agent runs this):
   ```bash
   npm run kb:dev
   ```

4. **Validate with playwright-cli** (agent does this — MANDATORY):
   Navigate to `http://localhost:5173`, take a screenshot, evaluate with vision.

### What Init Creates

| File | Purpose |
|------|---------|
| `.env.kbexplorer` | Vite env vars (`VITE_KB_OWNER`, `VITE_KB_REPO`, etc.) — gitignored |
| `content/config.yaml` | Full kbexplorer configuration |
| `package.json` updates | `kb:dev`, `kb:build`, `kb:install` scripts |
| `.gitignore` update | Ensures `.env.kbexplorer` is ignored |

## Content Modes

### Repo-Aware (default)

No content path set. kbexplorer auto-discovers issues, PRs, README, and source directories
from the target GitHub repo. Issue labels become clusters; `#N` cross-references become edges.

### Authored

Set `source.path` to a directory of markdown files (e.g., `content/`). Each file's YAML
frontmatter defines node metadata, hierarchy, and connections. Full control over the graph.

### Frontmatter Fields (Authored Mode)

```yaml
---
id: unique-node-id
title: Display Title
emoji: "🔧"
cluster: cluster-key
image: assets/hero.jpg       # heroes visual mode
sprite: assets/sprite.png    # sprites visual mode
parent: parent-node-id       # hierarchical grouping
connections:
  - to: other-node-id
    description: "relates to"
---
```

## Configuration Reference

The full `config.yaml` schema is documented in `references/configuration.md`.
Consult it for cluster definitions, visual modes, theme options, graph settings,
and feature flags.

## Visual Modes

| Mode | Assets | Best For |
|------|--------|----------|
| `emoji` | Unicode emoji | Lightweight, text-focused |
| `sprites` | Character illustrations | Technical docs, branded content |
| `heroes` | Full-bleed photography | Essays, narratives, editorial |
| `none` | Text only | Minimal deployments |

## Commands

After setup, these npm scripts are available:

| Command | Description |
|---------|-------------|
| `npm run kb:dev` | Start dev server with hot reload |
| `npm run kb:build` | Production build to `dist/kb/` |
| `npm run kb:install` | Install kbexplorer dependencies |

## Validation with Playwright (REQUIRED)

After starting the dev server, validation is **mandatory** — not optional. The agent
MUST validate the explorer loaded correctly. Do NOT skip this step. Do NOT ask the
user to validate manually unless playwright-cli is unavailable.

Use the **playwright-cli** skill to:
1. Navigate to `http://localhost:5173`
2. Wait for the page to fully load (network idle or ~5 seconds)
3. Take a full-page screenshot
4. Evaluate the screenshot with vision:
   - Page should show knowledge base content (cards, graph, or titles)
   - No blank screens, error messages, or broken layouts
5. Report the validation result with the screenshot

### If playwright-cli is NOT available

Inform the user that automated validation requires playwright-cli:
- **Where to get it**: Install the `playwright-cli` Copilot CLI plugin
- **Fallback**: Open `http://localhost:5173` in the user's browser automatically
  (use `start` on Windows, `open` on macOS, `xdg-open` on Linux)
- Clearly note that playwright-cli should be installed for the best experience

## Troubleshooting

- **Rate limit errors**: GitHub API allows 60 unauthenticated requests/hour. Add a
  `GITHUB_TOKEN` env var for higher limits.
- **Empty graph**: Verify the `owner` and `repo` in `.env.kbexplorer` are correct.
  Check that the repo has issues or content files.
- **Build fails**: Run `npm run kb:install` to ensure dependencies are installed.
- **Config not loading**: Ensure `content/config.yaml` exists in the target repo
  at the expected path.

## Content Generation

kbexplorer can auto-generate rich knowledge base content from any repository
using its built-in agents (adapted from Deep Wiki, MIT license).

### Quick Start

Run `/kb:generate` to analyze the current repo and produce a full knowledge graph.

### Agents

| Agent | Purpose |
|-------|---------|
| **kb-architect** | Scans repo → structured JSON catalogue with clusters and connections |
| **kb-writer** | Generates rich content pages with citations, Mermaid diagrams |
| **kb-researcher** | Deep investigation with evidence-first analysis |

### Pipeline

```
/kb:generate → kb-architect → catalogue → transform-catalogue.js → kb-writer → content/
```

The transform script converts the catalogue into kbexplorer-native frontmatter
(id, title, emoji, cluster, parent, connections). The kb-writer agent then fills
in each page with deep, evidence-based content.

See `references/content-generation.md` for the full format specification,
emoji mapping, and connection derivation rules.

## Additional Resources

### Reference Files

- **`references/configuration.md`** — Complete config.yaml schema with all options,
  defaults, and examples.
- **`references/content-generation.md`** — Content generation pipeline, frontmatter
  format, catalogue-to-node mapping, and emoji assignments.
