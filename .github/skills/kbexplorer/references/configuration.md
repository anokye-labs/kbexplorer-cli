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
