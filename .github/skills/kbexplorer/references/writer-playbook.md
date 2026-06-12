# Writer playbook — generate a rich page without an agent runtime

The kb-writer agent (installed in `.github/agents/kb-writer.md`) is the
canonical version of this procedure. In environments where the agent cannot
be invoked, follow this playbook directly to fill in a single node's body.

You are acting as a **Senior Technical Documentation Engineer**:
diagram-heavy, evidence-first, dark-mode-aware, no shallow claims.

## Step 0 — Resolve the source repository (mandatory)

If you arrived here from `architect-playbook.md`, this is already done.
Otherwise:

1. `git remote get-url origin`.
2. Ask the user for `REPO_URL` if not detectable.
3. `git rev-parse --abbrev-ref HEAD` for the branch.
4. Use linked citations (`[path:line](URL/blob/branch/path#Lline)`) for
   remote repos, local citations (`(path:line)`) for local-only.

## Step 1 — Read the brief

Find the kb-writer prompt in the file's frontmatter or the HTML comment
left by the scaffold/architect step. Note the cited files and the scope.

If the file has existing body content, read `update-node.md` instead — this
playbook is for filling in a fresh skeleton.

## Step 2 — Plan (10% of effort)

Decide before writing:

- Word budget. Most pages: 800–2000 words.
- Diagram count. **Minimum 3–5**, scaled to scope.
- Diagram TYPES. **At least 2 different types** are required. Pick from
  the table in step 5.
- Section outline. Typical: Overview → Architecture → Key Flows → Internals
  → Caveats → Related.

## Step 3 — Analyze (40% of effort)

Read EVERY cited file in full. Then:

- Trace each major code path end to end. Don't paraphrase from names.
- Identify the data structures, lifecycles, and state transitions.
- Note anything surprising — unusual patterns, debt, missing tests.
- Find imports and call sites to map real dependencies on other modules.

Update your draft connection list as you discover relationships.

## Step 4 — Write (40% of effort)

Build the body section by section. Every section MUST add value.

### Citation rules

Every non-trivial claim is followed by a citation:

| Format | When | Example |
|---|---|---|
| Linked | `REPO_URL` resolved | `[src/auth.ts:42](https://github.com/o/r/blob/main/src/auth.ts#L42)` |
| Local | Local-only repo | `(src/auth.ts:42)` |
| Range | Multi-line | `[src/auth.ts:42-58](URL/blob/main/src/auth.ts#L42-L58)` |
| Code block | Snippet shown | Add `<!-- Source: src/auth.ts:42-58 -->` above the block |
| Mermaid block | After every diagram | Add `<!-- Sources: src/auth.ts:42-58, src/store.ts:1-30 -->` |

Minimum 5 distinct cited files per page.

### Tables

Use tables aggressively. Anything that's structured (APIs, configs,
parameters, components, comparisons) is a candidate. Include a `Source`
column with linked citations when listing code artifacts.

- Headers are descriptive (`Component`, `Responsibility`, `Key File`,
  `Source`) — not `Name`, `Description`.
- Inline code for file paths and identifiers.
- Bold for the term being defined.
- Start each major section with a one-row summary table when sensible.

### Prose

- Explain WHY, not just WHAT.
- Concrete > abstract. File paths and function names over generic verbs.
- Mental model first, drill-in second.
- Flag what you haven't explored.

## Step 5 — Diagrams

Pick types that match what you're documenting:

| Diagram type | Document |
|---|---|
| `graph TB` / `graph LR` | Component relationships, dependency graphs |
| `sequenceDiagram` | Request flows, API interactions, multi-step processes |
| `classDiagram` | Class hierarchies, interfaces, type relationships |
| `stateDiagram-v2` | Lifecycles, state machines |
| `erDiagram` | Data models, database schemas |
| `flowchart` | Decision trees, conditional logic |

Rule of thumb: structure → graph, behavior → sequence/state, data → ER,
decisions → flowchart.

### Dark-mode Mermaid — mandatory

Inline styles on every node:

```
style NodeName fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
```

Palette:

| Role | Style |
|---|---|
| Primary | `fill:#1e3a5f,stroke:#4a9eed` (blue) |
| Success | `fill:#2d4a3e,stroke:#4aba8a` (green) |
| Warning | `fill:#5a4a2e,stroke:#d4a84b` (amber) |
| Danger | `fill:#4a2e2e,stroke:#d45b5b` (red) |
| Neutral | `fill:#2d2d3d,stroke:#7a7a8a` (gray) |

Use `<br>` (not `<br/>`) in labels. Use `autonumber` in every
`sequenceDiagram`.

After every diagram, add a `<!-- Sources: ... -->` block.

### Example diagram

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant Auth
    participant TokenStore

    Client->>Auth: POST /login
    Auth->>TokenStore: issue(user)
    TokenStore-->>Auth: token
    Auth-->>Client: 200 { token }

    style Client fill:#1e3a5f,stroke:#4a9eed,color:#e0e0e0
    style Auth fill:#2d4a3e,stroke:#4aba8a,color:#e0e0e0
    style TokenStore fill:#2d2d3d,stroke:#7a7a8a,color:#e0e0e0
```
<!-- Sources: src/auth.ts:42-90, src/token-store.ts:1-60 -->

## Step 6 — Update connections

If your deep read uncovered relationships the scaffold didn't include, add
them to the frontmatter `connections:` list (see `connections.md`). Don't
remove existing connections without a reason.

## Step 7 — Validate (10% of effort)

Before declaring the page done, walk this checklist:

- [ ] Source repository context resolved (REPO_URL or local).
- [ ] Every Mermaid block parses without errors.
- [ ] Every Mermaid block has a `<!-- Sources: ... -->` comment.
- [ ] No citation points to a non-existent file.
- [ ] All citations use the correct format (linked or local consistently).
- [ ] At least 2 different diagram types used.
- [ ] At least 5 distinct source files cited.
- [ ] At least one cross-reference to a related node.
- [ ] No claim without a code reference.
- [ ] `kbexplorer audit` is clean (frontmatter integrity).

Optional but recommended:

- [ ] Preview in the dev server, verify Mermaid renders.
- [ ] Use playwright-cli or computer-use MCP to take a screenshot.

## Anti-patterns to avoid

| Bad | Good |
|---|---|
| "This likely handles X" | Read the code and state what it ACTUALLY does. |
| "Based on the naming convention…" | Names lie — verify the implementation. |
| Three sequence diagrams in a row | Mix types (`graph` + `sequence` + `state`). |
| Mermaid without dark-mode colors | Always inline-style every node. |
| Mermaid without a `<!-- Sources: -->` block | Always cite. |
| Generic prose without citations | Cite or delete. |
| Restating the README | Add new mental model + diagrams + code refs. |
