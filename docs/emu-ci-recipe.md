# EMU CI recipe — deterministic gates → Azure SWA + AAD deploy

A single, copy-paste GitHub Actions workflow for running KB Explorer in a
**GitHub Enterprise Managed Users (EMU) / GitHub Enterprise (GHE)** work repo:

1. **Blocking PR gates** — `audit` + `validate` + `derive --check`, all
   deterministic (no LLM, no `gh` auth).
2. **Build + deploy** — `kbx build` then an **Azure Static Web Apps**
   deploy gated behind **Azure AD (AAD)** via `allowedRoles`.

You adopt it by substituting **secrets/host values only** — no logic changes.

## Files

| File | Purpose |
|---|---|
| [`recipes/emu-kb-ci.yml`](./recipes/emu-kb-ci.yml) | The workflow. Copy to `.github/workflows/kb-explorer.yml` in your work repo. |
| [`recipes/staticwebapp.config.json`](./recipes/staticwebapp.config.json) | SWA routing + AAD `allowedRoles`. The workflow stages it into `dist/kb/` at deploy time. |

## What you substitute

Everything sensitive is a repo **Secret** or **Variable** — never inlined:

| Name | Kind | Example / meaning |
|---|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | secret | SWA deployment token (from the Azure SWA resource) |
| `KBX_GH_TOKEN` | secret | PAT with `repo:read` on your EMU/GHE host (used by the manifest build) |
| `KBX_GH_API_BASE` | variable | e.g. `https://github.example.com/api/v3` |
| `<tenant-id>` | in `staticwebapp.config.json` | your Azure AD tenant GUID |
| `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` | SWA app settings | the AAD app registration (configured in Azure, not committed) |

## The blocking gates (job `gates`)

All three are deterministic, offline, and need no `gh` auth — safe as required
checks in branch protection:

| Step | Command | Fails the PR when |
|---|---|---|
| Audit | `kbx audit` | `content/*.md` has duplicate ids, broken parents, cycles, dead connections, missing required frontmatter |
| Validate | `kbx validate` | `content-model/` descriptors have dangling FK refs, unknown kinds, missing required fields, duplicate ids per kind, off-taxonomy relations, or `reports-to` cycles |
| Derive drift | `kbx derive <sources> --check` | a committed `*.jsonld` is stale relative to its source (the step auto-skips if you have no derived sources) |

Mark `gates` as a required status check, and keep
`required_conversation_resolution` on, exactly as the rest of this org's repos do.

## The deploy (job `deploy`)

Runs only on push to the default branch, only after `gates` passes:

1. `actions/checkout@v4` with `submodules: recursive` — required for
   submodule-mode `.kbx` installs (vendor-mode installs work too; the
   flag is harmless when there is no submodule).
2. `npm install` inside `.kbx/`, then `kbx build`. The manifest
   step reads your EMU host's issues/PRs/releases through the **direct-HTTP
   path** (`KBX_GH_API_BASE` + `KBX_GH_TOKEN`) — no `gh` auth
   handshake. See [`src/lib/gh-fetch.js`](../src/lib/gh-fetch.js) for the
   API-base + token precedence.
3. Copy `staticwebapp.config.json` into `dist/kb/`, then deploy the pre-built
   output with `Azure/static-web-apps-deploy@v1` (`skip_app_build: true`, so the
   SWA Oryx builder does not re-run).

### EMU host wiring (two equivalent options)

The recipe uses environment variables (shown above). Alternatively, persist the
base in `.kbx.json` so it travels with the repo and the workflow only
needs the token secret:

```jsonc
{
  "template": "...",
  "mode": "submodule",
  "ghApiBase": "https://github.example.com/api/v3"
}
```

Token precedence when a base is set: `KBX_GH_TOKEN` → `GH_TOKEN` →
anonymous.

### AAD `allowedRoles`

`staticwebapp.config.json` restricts every route to the built-in
`authenticated` role and points the AAD identity provider at your tenant
(`openIdIssuer: https://login.microsoftonline.com/<tenant-id>/v2.0`), so only
users who sign in through your tenant can reach the explorer. To restrict
further than "any authenticated tenant user", assign a **custom role** through
SWA role management (invitations) and replace `["authenticated"]` with your
custom role name.

## Adopt it

```bash
mkdir -p .github/workflows
cp <kbexplorer-cli>/docs/recipes/emu-kb-ci.yml .github/workflows/kb-explorer.yml
# Set the three secrets/variables above, set <tenant-id> in your SWA config,
# then open a PR — the gates run on the PR, the deploy runs on merge to main.
```

See the full runbook in [`deploy-to-a-work-repo.md`](./deploy-to-a-work-repo.md)
(§2.4 EMU API base, §3 content-model layout, §7.2 Azure SWA).

