---
id: "cmd-dev-build"
title: "dev / build / manifest"
emoji: "Play"
cluster: commands
parent: commands-overview
connections:
  - to: "lib-detect-repo"
    description: "all three resolve the app root through getAppRoot()"
  - to: "lib-manifest-transform"
    description: "regenerate the JSON snapshot the explorer reads"
  - to: "install-modes"
    description: "indifferent to submodule vs vendor"
---

Three commands manage the explorer's runtime surface — preview, production
build, and the manifest that backs them both.

```bash
npx kbx dev                # local Vite server on :5173
npx kbx build              # static site into dist/kb/
npx kbx build --base /my-repo/    # for GitHub Pages project sites
npx kbx manifest           # regenerate manifest.json without spawning Vite
```

## Install-mode agnostic

All three commands call `getAppRoot()` from [lib-detect-repo](lib-detect-repo)
to find the explorer app. That function returns the repo root in self-hosted
mode (when the CLI runs inside the template repo), `.kbx/` for a host
repo (submodule **or** vendored), or `null` when nothing is installed.

This is why adding [vendor mode](install-modes) required **zero** changes to
`dev` / `build` / `manifest`: a vendored copy looks identical to a submodule
through this seam.

## What the manifest contains

`generateManifest` in [`lib/manifest.js`](lib-manifest-transform) builds the
JSON snapshot the explorer renders: repo tree (up to a depth), README, capped
recent issues / PRs / commits (200 / 200 / 50), and the authored
`content/*.md` nodes. The cap exists because GitHub's REST API is
rate-limited and large repos can choke. For exhaustive coverage, lean on
authored content.

## Local mode without GitHub

If `gh` is not installed or authenticated, the build degrades gracefully — it
warns, omits issues / PRs / commits, and renders the rest. Empty graphs
usually mean a wrong owner / repo in `.env.kbx`.

<!-- Sources: src/commands/dev.js, src/commands/build.js, src/commands/manifest.js, src/lib/manifest.js -->

