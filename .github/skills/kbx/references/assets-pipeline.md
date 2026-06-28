# Assets pipeline — sprites and heroes

When `visuals.mode` is `sprites` or `heroes`, each node needs a matching
image. This reference covers where to put the files, how to name them, and
how to wire them into node frontmatter.

`emoji` and `none` modes need none of this.

## Directory layout

By convention, all assets live under `content/assets/` (or wherever
`source.path` points). Two recommended sub-folders:

```
content/
├── config.yaml
├── auth-flow.md
├── worker-pool.md
└── assets/
    ├── heroes/
    │   ├── auth-flow.jpg
    │   └── worker-pool.jpg
    └── sprites/
        ├── auth-flow.png
        └── worker-pool.png
```

The folder names aren't enforced — the wiring is per-node in frontmatter —
but matching the node id to the filename keeps things easy to audit.

## Heroes — full-bleed photography

| Spec | Target |
|---|---|
| Format | JPG (lossy, small) or WebP. |
| Resolution | 1920×800 minimum; landscape. |
| File size | < 200 KB after compression. |
| Aspect | ~21:9 — anything taller will be center-cropped. |
| Style | Consistent treatment across nodes — same desaturation/tonality. |

Wire into frontmatter:

```yaml
---
id: "auth-flow"
title: "Auth Flow"
cluster: security
image: "assets/heroes/auth-flow.jpg"
connections: []
---
```

The path is relative to the content directory. The explorer resolves it at
runtime; no build step required.

If `image:` is omitted, the explorer falls back to whatever
`visuals.fallback` is set to (usually `emoji`).

## Sprites — character illustrations

| Spec | Target |
|---|---|
| Format | PNG with transparency, or SVG. |
| Resolution | 512×512 for raster; viewBox-correct for SVG. |
| File size | < 80 KB. |
| Style | Same artist / same line weight / same palette across all nodes. |

Wire into frontmatter:

```yaml
---
id: "worker-pool"
title: "Worker Pool"
cluster: runtime
sprite: "assets/sprites/worker-pool.png"
connections: []
---
```

## Authoring workflow

### From scratch

1. Decide on the visual mode (`presentation.md`).
2. Plan the asset budget — for `heroes` mode, you'll need one image PER
   node; for `sprites`, the same.
3. Source or commission the assets BEFORE batch-wiring nodes — half-wired
   modes look broken.
4. Add `image:` or `sprite:` to each node's frontmatter.
5. Reload the explorer and click through every node to verify rendering.

### Adding one new node

1. Scaffold the node (`kbx scaffold ...`).
2. Drop the image into `content/assets/heroes/<slug>.jpg` (or sprite).
3. Add the `image:` / `sprite:` line to the frontmatter.
4. Run `kbx audit` (frontmatter is still valid even if the image is
   missing — audit doesn't check filesystem assets) and verify visually.

### Migrating modes

When switching modes (e.g. from `emoji` to `heroes`):

1. Change `visuals.mode` in `config.yaml` BUT set `fallback: emoji` so
   un-wired nodes still display.
2. Wire `image:` for the most-visited nodes first.
3. Use `kbx links` to find the most connected nodes and start there.
4. Once all nodes have assets, drop the fallback (or keep it as a safety net).

## Asset hygiene

| Practice | Reason |
|---|---|
| Commit assets to the repo, not a CDN | The explorer is offline-friendly; CDN dependencies break local previews. |
| Use the node id as the filename | Trivially auditable: `ls content/assets/heroes/` against the node list. |
| Keep aspect ratios consistent within a mode | Mixed aspects make the graph layout jitter. |
| Compress before commit (`pngquant`, `mozjpeg`) | Repo size matters for `git clone` speed. |
| Add a LICENSE.md in `assets/` for third-party media | Pure repo hygiene. |

## Validation

There is no CLI command for assets yet. Manual checks:

```bash
# every node that declares an image — does the file exist?
grep -l '^image:' content/*.md | while read f; do
  img=$(grep '^image:' "$f" | sed 's/image: *"\?\([^"]*\)"\?/\1/')
  test -e "content/$img" || echo "missing: $img (cited in $f)"
done
```

A future `kbx audit --check-assets` flag could automate this. For
now, run the snippet before publishing.

## Anti-patterns

| Don't | Reason |
|---|---|
| Mix `image:` and `sprite:` on the same node without picking a mode | Whichever the visual mode prefers wins; the other is dead weight. |
| Use 4K hero images | Eats bandwidth; the explorer renders at most ~800px wide. |
| Use raster sprites at <256px | They blur on retina displays. |
| Use inconsistent backgrounds across heroes | Reading view gets visually choppy. |

