# Presentation — visual mode, theme, fonts

How to change how the knowledge base looks without touching any content
files. All presentation lives in `content/config.yaml` plus optional asset
files; nothing here changes node frontmatter.

## Visual modes

The most impactful presentation decision. Set under `visuals.mode`:

| Mode | Asset required | Best for | Trade-off |
|---|---|---|---|
| `emoji` | None — uses node `emoji:` field | Lightweight, text-focused KBs; quick prototypes | Less visual identity; emoji rendering varies by OS |
| `sprites` | One sprite PNG per node | Technical docs with branded character art | Asset pipeline overhead |
| `heroes` | One hero JPG per node | Essays, narratives, editorial content | Bandwidth heavy; demands consistent photography |
| `none` | None | Minimal deployments where visuals would distract | Text-only — bland |

Always set a `fallback` mode in case an asset is missing:

```yaml
visuals:
  mode: heroes
  fallback: emoji
```

Asset wiring per mode is documented in `assets-pipeline.md`.

## Per-mode tuning

### `heroes` mode

```yaml
visuals:
  mode: heroes
  fallback: emoji
  hero:
    overlay: dark-gradient         # dark-gradient | light-gradient | none
    height: "300px"                # any CSS length
    animation: reveal              # reveal | fade | none
  graph:
    nodeImages: true               # show hero crops on graph nodes
    nodeSizeByConnections: true    # bigger node for more connected topics
```

| Overlay | Use when |
|---|---|
| `dark-gradient` | Bright photography; title text needs contrast. |
| `light-gradient` | Dark photography; title text is dark. |
| `none` | Heroes are abstract / muted enough that text is already legible. |

### `sprites` mode

```yaml
visuals:
  mode: sprites
  fallback: emoji
  graph:
    nodeImages: true
```

Sprites work best when they share a visual language (same artist, same
palette, same line weight). Mixed sprites read as inconsistent.

### `emoji` mode

```yaml
visuals:
  mode: emoji
  hud:
    blurBackground: true
    blurOpacity: 0.8
```

In emoji mode, each node's `emoji:` field is the only visual differentiator.
Prefer Fluent icon names (`Building`, `Database`, `LockClosed`) over Unicode
emoji — they render as crisp SVGs and don't depend on the OS emoji set.

## Theme

```yaml
theme:
  default: dark               # dark | light | sepia
  font:
    heading: "Instrument Serif"
    body: "General Sans"
    mono: "JetBrains Mono"
```

| Theme | Character |
|---|---|
| `dark` | Default. High-contrast on a near-black background. Good for technical content; Mermaid diagrams must use dark-mode colors. |
| `light` | Inverted. Good for documentation portals embedded in a light corporate site. Mermaid colors should still be readable. |
| `sepia` | Long-form-reading optimised. Best for essay-style content. |

Font overrides need the fonts to be loadable — bundle them with the template
or load from Google Fonts. Keep the headings serif, body sans, mono mono for
the established reading hierarchy.

## HUD

```yaml
features:
  hud: true             # show the heads-up display panel
  minimap: true         # show the minimap inside the HUD
```

```yaml
visuals:
  hud:
    blurBackground: true
    blurOpacity: 0.8    # 0 = transparent, 1 = opaque
```

Disable the HUD only for embeds where screen space is critical.

## Reading tools

```yaml
features:
  readingTools: true    # copy, highlight, citation share
  keyboardNav: true     # j/k navigation, / for search
```

These are mostly free; leave them on unless the host environment conflicts
with the keyboard shortcuts.

## Graph physics

```yaml
graph:
  physics: true                  # enable force simulation
  layout: force-atlas-2          # force-atlas-2 | manual
```

Use `physics: false` + `layout: manual` only when you've designed an
explicit position for every node (rare; usually only for landing-page
KBs of < 20 nodes).

## BLUF intro screen

Optional cinematic intro:

```yaml
bluf:
  quote: "Knowledge is the path."
  duration: "5s"
  audio: "assets/intro.mp3"      # optional
```

Use sparingly. Great for first-launch demos, distracting on repeat visits.
Most production KBs leave the `bluf` block out.

## How to change presentation safely

1. Edit `content/config.yaml`.
2. Reload the explorer (`Ctrl-R` in the browser) — no rebuild needed for
   most config keys.
3. If you changed `visuals.mode` to `sprites` or `heroes`, see
   `assets-pipeline.md` for the required asset work.
4. Validate by clicking through 3–5 different node types (cluster
   representatives, leaf, hub).
5. Use Playwright or computer-use MCP to take before/after screenshots if
   the change is meant for a stakeholder.

## What presentation does NOT change

Cluster colors and per-node `emoji:` values live elsewhere:

- Cluster colors → `content/config.yaml` under `clusters.<key>.color`.
- Node icon/emoji → frontmatter `emoji:` field in the node's `.md` file.

See `graph-curation.md` for cluster recolouring; see `frontmatter.md` for
node emoji.
