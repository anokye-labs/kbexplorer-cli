---
id: "agents-overview"
title: "Copilot Agents"
emoji: "Bot"
cluster: agents
parent: home
connections:
  - to: "cmd-generate"
    description: "generate orchestrates the three agents"
  - to: "skill-overview"
    description: "the skill mirrors agent behavior in playbooks"
  - to: "lib-manifest-transform"
    description: "the architect's output is consumed by transform"
---

Three Copilot agents ship with kbexplorer-cli, installed into
`.github/agents/` by [init](cmd-init):

| Agent | Role |
|---|---|
| `kb-architect` | Scan a repo, produce a structured catalogue of nodes, clusters, and connections with Fluent icon hints. |
| `kb-writer` | Author per-page content: rich prose with citations and Mermaid diagrams. |
| `kb-researcher` | Deep, evidence-first investigation of a part of the codebase. |

## How they collaborate

1. The user runs [generate](cmd-generate).
2. `kb-architect` reads the repository and writes `catalogue.json`.
3. [`transformCatalogue`](lib-manifest-transform) emits per-node skeletons
   plus a `config.yaml`.
4. `kb-writer` opens each skeleton and fills the body.
5. `kb-researcher` is invoked on demand when the writer needs to verify
   something at a depth that warrants its own subagent.

## Agent-free fallback

Copilot Desktop does not support agents. For that environment the
[skill](skill-overview) ships three **playbooks** — `architect-playbook.md`,
`writer-playbook.md`, `researcher-playbook.md` — that transcribe each
agent's behavior step by step so any LLM can follow them directly.

The agents themselves remain installed regardless; environments that
support them get faster execution.

<!-- Sources: src/assets/agents/kb-architect.md, src/assets/agents/kb-writer.md, src/assets/agents/kb-researcher.md -->
