---
id: "cmd-links"
title: "links"
emoji: "Pulse"
cluster: commands
parent: commands-overview
connections:
  - to: "cmd-audit"
    description: "audit owns broken refs; links owns soft health"
---

`links` is the **soft** graph-health analyzer. It is advisory — it never
fails CI; that role belongs to [audit](cmd-audit).

```bash
npx kbx links
npx kbx links --json
```

## What it reports

- **Orphans** — authored nodes with zero connections in either direction.
- **Weak clusters** — clusters with no cross-cluster edges (visually
  isolated subgraphs).
- **Unlinkified mentions** — body text mentions another node's title but
  doesn't link to it.
- **Redundant frontmatter** — `connections.to` duplicates an inline link
  already present in the body.
- **Coverage gaps** — source files in the repo with no content node citing
  them.

Broken `connections.to → unknown id` used to be reported here as well, but
that signal moved to [audit](cmd-audit) as a hard error — `links` no longer
double-reports it.

## When to run

After authoring or refactoring, before opening a PR. Use the suggestions to
strengthen the graph (add connections to orphans; linkify mentions; close
coverage gaps with new [scaffold](cmd-scaffold) calls).

<!-- Sources: src/commands/links.js -->

