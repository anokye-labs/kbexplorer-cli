---
id: "skill-overview"
title: "Skill — slim router + references"
emoji: "BrainCircuit"
cluster: skill
parent: home
connections:
  - to: "agents-overview"
    description: "playbooks mirror agent behavior for desktop"
  - to: "cmd-audit"
    description: "audit is the enforcement arm of every reference"
  - to: "cmd-scaffold"
    description: "skill points at scaffold for single-node creation"
---

The `kbx` skill is installed at `.github/skills/kbx/`. Its
`SKILL.md` is a **thin router** — when-to-use triggers, an intent →
reference routing table, and a short list of universal invariants. The
depth lives in `references/`.

## The 15 references

| Category | References |
|---|---|
| Bootstrap | `setup`, `configuration` |
| Schema | `frontmatter`, `connections` |
| Authoring | `add-node`, `update-node`, `incremental-refresh`, `content-generation` |
| Refactoring | `graph-curation` |
| Validation | `audit` |
| Presentation | `presentation`, `assets-pipeline` |
| Agent-free playbooks | `architect-playbook`, `writer-playbook`, `researcher-playbook` |

## Routing pattern

A typical interaction:

1. The user mentions kbx or a related concept.
2. The skill's when-to-use clause activates.
3. The router maps the user's intent to one or two references.
4. The model loads those references on demand and executes.

This pattern avoids the failure mode of a single monolithic SKILL.md, where
the model has to either hold the whole thing in context (expensive) or
skim and miss key invariants (unreliable).

## Invariants

Three rules apply everywhere, restated in every reference:

1. **Cite or strike** — every non-trivial claim ends in a citation.
2. **Audit before done** — [audit](cmd-audit) must be green before claiming
   a content change is complete.
3. **Names lie, read the code** — never paraphrase a file name; open it.

<!-- Sources: src/assets/skills/kbx/SKILL.md, src/assets/skills/kbx/references/*.md -->

