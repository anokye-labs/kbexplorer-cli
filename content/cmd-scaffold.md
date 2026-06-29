---
id: "cmd-scaffold"
title: "scaffold"
emoji: "DocumentAdd"
cluster: commands
parent: commands-overview
connections:
  - to: "lib-frontmatter"
    description: "writes valid kbexplorer-subset YAML"
  - to: "lib-manifest-transform"
    description: "reuses inferIcon() for emoji selection"
  - to: "cmd-audit"
    description: "run audit immediately after scaffolding"
---

`scaffold` creates a single new content node with valid frontmatter — no need
to hand-write the YAML or look up the schema.

```bash
npx kbx scaffold my-new-topic --cluster getting-started
npx kbx scaffold api-v2 --cluster engine --parent api --title "API v2"
npx kbx scaffold deep-dive --cluster engine --emoji Beaker --force
```

## Default frontmatter

```yaml
---
id: "my-new-topic"
title: "My New Topic"
emoji: "Document"           # inferred from slug via inferIcon()
cluster: getting-started
connections: []
---

> TODO: open this file and follow the writer playbook to fill in the body.
> Cite source files inline as you go.
```

## Validation rules

- `slug` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case, no leading
  numeric).
- `--cluster` is required.
- Refuses to overwrite an existing file unless `--force` is passed.
- Respects `VITE_KB_PATH` from `.env.kbx` for the content directory.

## Where it fits

`scaffold` is the **single-node** authoring entry point. For bulk creation,
use [generate](cmd-generate). For "what should I refresh after this diff?",
use [affected](cmd-affected). After scaffolding, always run
[audit](cmd-audit) to confirm the new node is well-formed.

<!-- Sources: src/commands/scaffold.js, src/lib/transform.js -->

