import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RECIPE = resolve(ROOT, 'docs', 'recipes', 'emu-kb-ci.yml');
const SWA_CONFIG = resolve(ROOT, 'docs', 'recipes', 'staticwebapp.config.json');
const DOC = resolve(ROOT, 'docs', 'emu-ci-recipe.md');

/**
 * Gap G (#77): a single, copy-paste EMU CI recipe combining the deterministic
 * gates + build + Azure SWA/AAD deploy. These tests pin that the shipped recipe
 * contains every required element so it stays adoptable with only secret/host
 * substitutions.
 */
describe('EMU CI recipe (#77)', () => {
  it('ships the workflow, the SWA/AAD config, and the explainer doc', () => {
    assert.ok(existsSync(RECIPE), 'docs/recipes/emu-kb-ci.yml missing');
    assert.ok(existsSync(SWA_CONFIG), 'docs/recipes/staticwebapp.config.json missing');
    assert.ok(existsSync(DOC), 'docs/emu-ci-recipe.md missing');
  });

  it('is NOT installed as an active workflow in this repo', () => {
    // It must live under docs/recipes (a template), never .github/workflows,
    // so it does not try to deploy from the CLI repo itself.
    assert.ok(!existsSync(resolve(ROOT, '.github', 'workflows', 'emu-kb-ci.yml')));
    assert.ok(!existsSync(resolve(ROOT, '.github', 'workflows', 'kb-explorer.yml')));
  });

  it('wires the three deterministic blocking gates', () => {
    const yml = readFileSync(RECIPE, 'utf-8');
    assert.match(yml, /kbexplorer audit/);
    assert.match(yml, /kbexplorer validate/);
    assert.match(yml, /kbexplorer derive .* --check/);
  });

  it('gates run before deploy and deploy is gated to push on the default branch', () => {
    const yml = readFileSync(RECIPE, 'utf-8');
    assert.match(yml, /needs:\s*gates/);
    assert.match(yml, /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  });

  it('checks out submodules recursively', () => {
    const yml = readFileSync(RECIPE, 'utf-8');
    assert.match(yml, /submodules:\s*recursive/);
  });

  it('wires the EMU host (ghApiBase + token) for the manifest build', () => {
    const yml = readFileSync(RECIPE, 'utf-8');
    assert.match(yml, /KBEXPLORER_GH_API_BASE:\s*\$\{\{\s*vars\.KBEXPLORER_GH_API_BASE\s*\}\}/);
    assert.match(yml, /KBEXPLORER_GH_TOKEN:\s*\$\{\{\s*secrets\.KBEXPLORER_GH_TOKEN\s*\}\}/);
  });

  it('deploys the pre-built output to Azure Static Web Apps', () => {
    const yml = readFileSync(RECIPE, 'utf-8');
    assert.match(yml, /Azure\/static-web-apps-deploy@v1/);
    assert.match(yml, /azure_static_web_apps_api_token:\s*\$\{\{\s*secrets\.AZURE_STATIC_WEB_APPS_API_TOKEN\s*\}\}/);
    assert.match(yml, /skip_app_build:\s*true/);
    assert.match(yml, /app_location:\s*dist\/kb/);
  });

  it('ships a valid SWA config with AAD allowedRoles', () => {
    const raw = readFileSync(SWA_CONFIG, 'utf-8');
    const cfg = JSON.parse(raw); // must be valid JSON
    const route = cfg.routes.find((r) => r.route === '/*');
    assert.ok(route, 'missing /* route');
    assert.deepEqual(route.allowedRoles, ['authenticated']);
    assert.ok(cfg.auth.identityProviders.azureActiveDirectory, 'missing AAD identity provider');
    assert.match(cfg.auth.identityProviders.azureActiveDirectory.registration.openIdIssuer, /login\.microsoftonline\.com/);
  });

  it('the explainer doc links the copyable recipe files', () => {
    const md = readFileSync(DOC, 'utf-8');
    assert.match(md, /recipes\/emu-kb-ci\.yml/);
    assert.match(md, /recipes\/staticwebapp\.config\.json/);
  });
});
