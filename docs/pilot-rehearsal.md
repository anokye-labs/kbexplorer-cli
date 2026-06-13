# Pilot Rehearsal — Full-Pipeline Dress Rehearsal (#56)

**Date:** 2026-06-13  
**Branch:** `hoopsomuah/issue-56-dress-rehearsal`  
**Substrate:** Static GitHub twin (`twins/github/server.js`) — Podman is available but used the static twin (already running on port 3456; the Gitea DTU requires `npm install` in the template for the adapter and was deferred).  
**Keystone merged:** `feat(manifest): configurable GitHub API base + auth (#58)` — merged from `hoopsomuah/issue-58-gh-api-base` as the first commit of this branch.

---

## 1. Substrate

Podman v5.8.2 is present. However the Gitea DTU requires `npm install` in the template directory which isn't available in the vendored fixture install. The **static GitHub twin** (`twins/github/server.js`, default port 3456) was already running and serves all required routes (`/issues`, `/pulls`, `/releases`, `/commits`, `/git/trees`, `/contents`).

```
[twin] Serving on http://localhost:3456
curl http://localhost:3456/health → OK
curl http://localhost:3456/repos/test-owner/test-repo/releases → 3 releases
```

The CLI routes all GitHub fetches to the twin via:
```
KBEXPLORER_GH_API_BASE=http://localhost:3456 KBEXPLORER_GH_TOKEN=test-token
```

---

## 2. Fixture Content Tree

Created at `C:/Users/hoops/src/anokye/kbexplorer-fixture` with a synthetic work-repo:

```
kbexplorer-fixture/
├── README.md
├── catalogue.json              # pre-seeded, deterministic generate
├── node-map.yaml
├── content-model/
│   ├── teams/graph-platform.yaml     (graph-platform team, lead: adwoa)
│   ├── teams/delivery-ops.yaml       (delivery-ops team, lead: nana)
│   ├── workstreams/kb-explorer.yaml  (P1, tracked in gh-repo)
│   ├── workstreams/release-ops.yaml  (P2, tracked in gh-repo)
│   ├── priorities/p1.yaml
│   ├── priorities/p2.yaml
│   ├── people/adwoa.yaml
│   ├── people/kwame.yaml
│   ├── people/nana.yaml
│   └── systems-of-record/gh-repo.yaml
├── content/
│   ├── config.yaml             (clusters: entry/commands/libs/infra/org)
│   ├── overview.md             (existing authored)
│   ├── architecture.md         (existing authored)
│   ├── getting-started.md      (existing authored)
│   └── data-layer.md           (existing authored)
└── .git/                       # remote = https://github.com/test-owner/test-repo
```

Git remote set to `https://github.com/test-owner/test-repo` — this matches the twin's fixture data (`fixtures/issues.json`, `fixtures/releases.json`, etc.).

The fixture was initialized with a git commit and `kbexplorer init --vendor --template <local-template-path> --ref main` (non-interactive; interactive config step failed with exit 13 due to TTY, but `.kbexplorer.json` was correctly created before the prompt).

---

## 3. Command Transcript

### 3.1 `kbexplorer doctor --offline`

```
Runtime
───────
  ✅ Adapter: copilot (source: default)
  ✅ Binary: copilot
  ✅ Binary available: GitHub Copilot CLI 1.0.61.

MCP
───
  ✅ No MCP servers declared in runtime config

Template
────────
  ✅ .kbexplorer.json present (mode: vendor, template: C:/…/kbexplorer)
  ⚠  Template tracks branch "main" — consider pinning to a release tag

Environment
───────────
  ✅ Node v26.3.0
  ✅ git available: git version 2.53.0.vfs.0.7
  ✅ gh (GitHub CLI) available: gh version 2.93.0
  ✅ content/ directory present
  ✅ repo-manifest.json up to date

✅ All checks passed (or warned).
```

**Result:** Green (1 non-fatal warning: template tracks branch instead of tag).

### 3.2 Bug #41 surface: first `generate --no-agent` with mismatched catalogue

```
# Bug demonstration: catalogue with different clusters than existing content
$ node kbexplorer-cli-rehearsal/bin/cli.js generate --no-agent
📋 Transforming catalogue.json → content/...
✓ Written content/config.yaml   ← clusters overwritten to {overview,install,authoring}
✓ Generated 2 files...

$ node kbexplorer-cli-rehearsal/bin/cli.js audit
✗ undeclared-cluster (9):
  architecture.md — cluster "entry" not declared in config.yaml
  cmd-build.md    — cluster "commands" not declared in config.yaml
  ...
```

This reproduced bug **#41** exactly: 9 existing nodes orphaned.

### 3.3 Bug #41 fixed: `generate --no-agent` with orphan guard

After fix to `transform.js`:

```
$ node kbexplorer-cli-rehearsal/bin/cli.js generate --no-agent
📋 Transforming catalogue.json → content/...
⚠ 1 existing cluster(s) not in new catalogue — preserved as legacy: authoring
✓ Written content/config.yaml
  ⏭ cmd-init.md already exists — skipping
  ...
✓ Generated 4 files (4 imported from existing content)
⚠ Manifest script exited 1 — manifest may be stale. Run kbexplorer manifest separately.
✅ Content generated.
```

Key results:
- Orphaned cluster `authoring` preserved as legacy entry in `config.yaml`
- **4 existing node bodies imported** (fix for `findExistingBody` using wrong root)
- Manifest script failure is now a **warning, not a crash** (spawnSync instead of execSync)

### 3.4 `kbexplorer audit`

```
Files scanned:  11
Nodes parsed:   11
Errors:         0
Warnings:       0
✅ No structural issues found.
```

### 3.5 `kbexplorer manifest` (via twin)

```
KBEXPLORER_GH_API_BASE=http://localhost:3456 KBEXPLORER_GH_TOKEN=test-token \
  node kbexplorer-cli-rehearsal/bin/cli.js manifest
```

Output:
```
⚠ Template manifest script exited 1; falling back to CLI generator
[generate-manifest] GitHub API base: http://localhost:3456 (direct HTTP)
[generate-manifest] Tree: 56 entries
[generate-manifest] Content: 11 files
[generate-manifest] Issues: 65
[generate-manifest] PRs: 25
[generate-manifest] Commits: 1
[generate-manifest] Releases: 3
✓ Manifest written to .kbexplorer/src/generated/repo-manifest.json
```

The manifest was written to the correct path (fix for fallback not writing to file). GitHub data came from the twin.

### 3.6 Final `doctor --offline`

```
✅ repo-manifest.json up to date (generated 2026-06-13T05:35:51.410Z)
✅ All checks passed (or warned).
```

---

## 4. Failures, Fixes, and Deferred Items

### Fixed in this PR

| Issue | Root cause | Fix |
|-------|-----------|-----|
| **#40** connections `to: "undefined"` | `transform.js` assumed `connections[i]` is an object; architect emits bare string IDs | `transform.js`: accept both shapes (`typeof c === 'string'`). Already fixed in #36; regression test added. |
| **#41** generate --refresh orphans clusters | `transformCatalogue` unconditionally overwrites `config.yaml` from catalogue clusters | `transform.js`: `collectExistingClusters()` scans existing `.md` files; orphaned cluster IDs are carried forward as legacy entries in `config.yaml` |
| **findExistingBody wrong root** | Used `projectRoot` (CLI source dir) instead of `outputDir` | Fixed call site: `findExistingBody(node.id, outputDir)` |
| **generate Phase 2b crash** | `execSync` throws when manifest script exits non-zero (e.g. vendored install lacks `yaml` dep) | Use `spawnSync` + warn instead of crash |
| **manifest fallback not writing file** | `manifest.js` command called `generateManifest(cwd)` but discarded the return value | Write manifest to `manifestOutPath(appRoot)` in the fallback path |

### Deferred

| Issue | Reason |
|-------|--------|
| **`build` command** | `build.js` has a pre-existing syntax error (`await` inside non-async `.on('exit')` callback). Separately, a vendored install without `node_modules` cannot run Vite. Both issues exist on `main`. Deferred with a `spawn_task`. |
| **`verify-self-kb.js`** | Requires a running dev server. The dev server requires `npm install` in the template, which the vendored fixture doesn't have. Deferred. |
| **`derive` command** | No `.docx` files in fixture (task requirement); derive requires Copilot runtime for fuzzy extraction. `--check` mode worked (deterministic path). Deferred for a full runtime environment. |
| **Gitea DTU** | Preferred substrate but requires `npm install` in the template. Static twin served all required data hermetically. |

### #39 status

Issue #39 (VITE_KB_HOST_ROOT missing in vendored installs) was reported as fixed in #36. Verification in this PR:
- `generate.js` line 244: `env: { ...process.env, VITE_KB_LOCAL: 'true', VITE_KB_HOST_ROOT: cwd }` ✅
- `manifest.js` line 25 (same): `env: { ...process.env, VITE_KB_LOCAL: 'true', VITE_KB_HOST_ROOT: cwd }` ✅
- Source-level regression tests added to `tests/commands/generate.test.js`

---

## 5. Pipeline Summary

| Step | Status | Notes |
|------|--------|-------|
| `doctor` | ✅ Green | 1 non-fatal warning (branch vs tag) |
| `generate --no-agent` | ✅ Fixed | Clusters preserved, bodies imported, Phase 2b non-fatal |
| `audit` | ✅ Clean | 11 nodes, 0 errors |
| `manifest` (twin) | ✅ Working | 65 issues / 25 PRs / 3 releases from twin; written to file |
| `build` | ⛔ Deferred | Pre-existing syntax error + no vite in vendored install |
| `verify-self-kb` | ⛔ Deferred | Requires running dev server |

---

## 6. Test Coverage Added

14 new regression tests across 5 new `describe` blocks in `tests/lib/transform.test.js` and 2 in `tests/commands/generate.test.js`:

- `collectExistingClusters` — 5 tests
- `transformCatalogue — fix #40: string-array connections` — 3 tests  
- `transformCatalogue — fix #41: orphaned cluster guard` — 3 tests
- `transformCatalogue — fix: existing nodes import from outputDir` — 1 test
- `generate.js — fix #39: VITE_KB_HOST_ROOT in manifest regeneration` — 2 tests

Total: **485 tests, 0 failures** (up from 471 before this branch).
