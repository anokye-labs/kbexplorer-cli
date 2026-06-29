---
id: "cmd-init"
title: "init"
emoji: "Rocket"
cluster: commands
parent: commands-overview
connections:
  - to: "install-modes"
    description: "submodule or vendor"
  - to: "lib-source"
    description: "writes .kbx.json"
  - to: "lib-detect-repo"
    description: "auto-detects owner / repo / branch"
  - to: "agents-overview"
    description: "copies agents into .github/agents/"
  - to: "skill-overview"
    description: "copies the skill into .github/skills/"
---

`init` is the interactive bootstrap. It installs the explorer template into a
host repo and wires up everything kbx needs to operate.

```bash
npx kbx init                                  # default: submodule
npx kbx init --vendor --ref main              # one-time copy
npx kbx init --template https://github.com/my-org/my-template.git
```

Under the hood it:

1. Detects `git remote origin` and the current branch.
2. Asks 4–5 short questions (owner, repo, branch, title, content mode).
3. Installs the template at `.kbx/` — as a git submodule by default,
   or vendored when `--vendor` is set. See [install-modes](install-modes) for
   the trade-offs.
4. Writes `.env.kbx` (Vite env vars; gitignored), `.kbx.json`
   (the [source record](lib-source)), and the npm scripts (`kb:dev`,
   `kb:build`, `kb:generate`).
5. Copies the [agents](agents-overview) and the [skill](skill-overview) into
   `.github/`.
6. Runs `npm install` inside `.kbx/`.

## Atomic installs

The vendor path clones into a sibling temp directory, strips `.git`, validates
`package.json`, then `renameSync`s into place. A failed clone never leaves
a half-installed `.kbx/`. The same temp-dir-then-rename pattern is used
by [update](cmd-update) when swapping a vendored install.

<!-- Sources: src/commands/init.js, src/lib/source.js -->

