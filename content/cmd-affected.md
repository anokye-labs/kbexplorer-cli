---
id: "cmd-affected"
title: "affected"
emoji: "BranchFork"
cluster: commands
parent: commands-overview
connections:
  - to: "lib-affected"
    description: "the citation index + diff intersector"
  - to: "lib-frontmatter"
    description: "extracts citations from body + frontmatter"
  - to: "cmd-audit"
    description: "run audit after refreshing affected nodes"
---

`affected` answers: **"After this diff, which content nodes need a refresh?"**

```bash
npx kbx affected HEAD~10           # changed files since 10 commits ago
npx kbx affected main              # changed files vs main
npx kbx affected --json            # machine-readable
```

## How it works

1. Build a **citation index** by walking every `content/*.md` and extracting
   the source file references in the body. Three citation styles are
   recognized:
   - Linked: `[src/auth.ts:42](URL/blob/main/src/auth.ts#L42)`
   - Local: `(src/auth.ts:42)`
   - Sources comment: `<!-- Sources: src/auth.ts, src/main.ts -->`
2. Ask git for the changed files between the working tree and the given ref
   (`git diff --name-only <ref>`, run via `execFileSync` to harden against
   shell-injection from user-controlled refs).
3. Suffix-match each changed file against the citation index. A
   citation `src/auth.ts` matches a changed file ending in `src/auth.ts`.
4. Print the impacted node ids.

## The refresh loop

```bash
npx kbx affected HEAD~5      # → ["cmd-init", "lib-source"]
# edit cmd-init.md and lib-source.md to reflect the changes
npx kbx audit                # validate
npx kbx dev                  # eyeball
```

For monorepos with many `auth.ts`-style basename collisions, the suffix-match
can over-report. That is acceptable — it errs toward asking you to look at
more nodes rather than missing one.

<!-- Sources: src/commands/affected.js, src/lib/affected.js -->

