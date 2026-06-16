---
id: "lib-audit"
title: "lib/audit.js"
emoji: "CheckmarkCircle"
cluster: libs
parent: libs-overview
connections:
  - to: "cmd-audit"
    description: "the CLI wrapper"
  - to: "lib-frontmatter"
    description: "parses every file through it"
---

`audit.js` is a **rules-based validator** for the content directory. Each
rule is a pure check returning a `Finding` with `severity`, `rule`, and
identifying metadata.

## API

```js
import { audit } from './lib/audit.js';

const { findings, summary } = audit({
  contentDir: '/path/to/content',   // required
  cwd: process.cwd(),               // optional; enables config lookup
  contentPath: 'content',           // optional; passed to readConfig
});
```

## Findings shape

```json
{
  "severity": "error",
  "rule": "duplicate-id",
  "id": "my-node",
  "files": ["content/a.md", "content/b.md"],
  "message": "id \"my-node\" declared in 2 files"
}
```

## Rules

See [cmd-audit](cmd-audit) for the full table. Briefly:

- **Errors** (block CI): `malformed-frontmatter`, `missing-required-field`,
  `duplicate-id`, `broken-parent`, `parent-cycle`, `dead-connection`,
  `undeclared-cluster`, `missing-config`, `missing-clusters`.
- **Warnings** (informational): `filename-id-mismatch`, `read-error`.

## Cluster declaration semantics

Audit uses `readConfig()` from [lib-manifest-transform](lib-manifest-transform)
to discover declared cluster keys. The interaction matrix:

| Content has clusters? | `config.yaml` present? | `clusters:` block? | Result |
|---|---|---|---|
| No | any | any | nothing to check |
| Yes | no | — | `missing-config` error |
| Yes | yes | no | `missing-clusters` error |
| Yes | yes | yes | per-node `undeclared-cluster` checks |

Pre-fix, `audit` would silently pass when `config.yaml` was absent. That
was a CI false-green of the worst kind — fixed in the same commit that
bumped `dead-connection` and `undeclared-cluster` from `warning` to `error`.

<!-- Sources: src/lib/audit.js, src/lib/manifest.js -->
