---
id: "lib-frontmatter"
title: "lib/frontmatter.js"
emoji: "DocumentBulletList"
cluster: libs
parent: libs-overview
connections:
  - to: "lib-audit"
    description: "audit parses every content file through it"
  - to: "lib-affected"
    description: "affected uses extractCitedFiles()"
  - to: "cmd-scaffold"
    description: "scaffold writes output through the same schema"
  - to: "zero-deps"
    description: "a deliberate trade-off"
---

`frontmatter.js` is a zero-dependency parser for the **kbx
YAML subset**. It is intentionally not a full YAML parser — it handles only
the fields kbx's content schema uses, and no more.

## Why a custom parser

kbexplorer-cli ships with **zero runtime dependencies** (see
[zero-deps](zero-deps)). Pulling in `js-yaml` for a tiny scalar subset is
the wrong trade. The parser is small, tested, and tuned for what the
[content pipeline](cmd-generate) and [scaffold](cmd-scaffold) actually
produce.

## What it supports

- Scalar fields: `id`, `title`, `cluster`, `parent`, `emoji`, `image`, `sprite`
- A `connections:` list of `{to, description}` items
- Standard `---`-fenced frontmatter with `\n` or `\r\n` line endings

## What it does NOT support

The reference doc [`references/frontmatter.md`](skill-overview) calls this
out explicitly:

- Multi-line strings (`|`, `>`)
- Inline objects / arrays (`{a: 1}`, `[1, 2, 3]`)
- YAML anchors / aliases
- Escaped specials inside quoted strings
- Numeric ids

If you need exotic YAML, the renderer is the source of truth for what
actually breaks. [audit](cmd-audit) will report `malformed-frontmatter` for
anything the parser cannot read.

## Citation extraction

`extractCitedFiles(body)` is the other reason this lib exists. It pulls out
three citation styles for use by [affected](cmd-affected):

```
[src/auth.ts:42](URL/blob/main/src/auth.ts#L42)    # linked
(src/auth.ts:42)                                    # local
<!-- Sources: src/auth.ts, src/main.ts -->          # comment
```

## Environment helpers

`loadKbEnv(cwd)` reads `.env.kbx` without mutating `process.env`.
`resolveContentDir(cwd, override)` picks the content directory using a clear
priority: explicit flag → `process.env.VITE_KB_PATH` → `.env.kbx` →
`'content'`. [audit](cmd-audit), [affected](cmd-affected), and
[scaffold](cmd-scaffold) all use this to honor the user's configured path.

<!-- Sources: src/lib/frontmatter.js -->

