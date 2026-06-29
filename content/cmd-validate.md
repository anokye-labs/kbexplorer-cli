---
id: "cmd-validate"
title: "validate"
emoji: "DocumentBulletListClock"
cluster: commands
parent: commands-overview
connections:
  - to: "cmd-audit"
    description: "sibling gate: audit covers content/, validate covers content-model/"
  - to: "lib-frontmatter"
    description: "shares the zero-dependency YAML-subset parsing philosophy"
---

`validate` is the hard, deterministic gate for the **`content-model/`** descriptor
tree — the structured org-layer files (`person`, `team`, `workstream`,
`priority`, `system-of-record`) that [audit](cmd-audit) never inspects (audit is
markdown-only). It runs with **no LLM and no `gh` auth**, so it is safe to wire
into CI as a blocking PR check. It exits **non-zero on errors**.

```bash
npx kbx validate                          # default: scan content-model/
npx kbx validate --content-model my-dir   # custom descriptor dir
npx kbx validate --json                   # machine-readable output
```

## What it catches

| Rule | Severity | Catches |
|---|---|---|
| `malformed-yaml` | error | Descriptor YAML the parser cannot read |
| `unknown-kind` | error | A file outside a known kind dir with no valid `@type` |
| `type-mismatch` | error | `@type` disagrees with the kind directory it lives in |
| `missing-required-field` | error | `@type`, `id`, or `name` is missing for the kind |
| `duplicate-id` | error | The same `id:` appears twice within one kind |
| `broken-ref` | error | A foreign key resolves to no descriptor of the target kind |
| `off-taxonomy-relation` | error | An explicit `relations:` entry is outside the 6-relation taxonomy |
| `reports-to-cycle` | error | A `person.manager` chain forms a cycle |

## Foreign keys it resolves

| Source field | Target kind | Cardinality |
|---|---|---|
| `person.manager` | person | one |
| `team.lead` | person (alias or id) | one |
| `team.members` | person | many |
| `team.workstreams` | workstream | many |
| `workstream.priority` | priority | one |
| `workstream.team` | team | one |
| `workstream.systems-of-record` | system-of-record | many |

Required fields are enforced per kind; every **other** field passes through
untouched (descriptors are passthrough, so org-specific metadata never trips the
gate). The 6-relation taxonomy is `leads | staffs | reports-to | structural |
derived | deprecated`.

## Why a separate command from audit

[audit](cmd-audit) validates `content/*.md` knowledge-graph pages; `validate`
validates the `content-model/` descriptor YAML. Splitting them keeps each gate
fast, single-purpose, and independently wireable in CI — the EMU CI recipe runs
`audit` **and** `validate` as two blocking gates.

<!-- Sources: src/commands/validate.js, src/lib/content-model.js, docs/templates/person.yaml -->

