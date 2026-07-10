/**
 * kbx manifest — build the repo manifest, thin over the engine's
 * `buildManifest()` producer (anokye-labs/kbexplorer-cli#258).
 *
 * This used to spawn kbexplorer-template's `scripts/generate-manifest.js` and
 * fall back to the CLI's own byte-parallel `src/lib/repo-manifest.ts` fork
 * (flagged as duplication debt by cli#232). Both are gone: the engine now owns
 * the manifest *producer* (`buildManifest()`, driving the same `RepoSource`
 * abstractions the CLI already used for `explore`/`audit`), so this command is
 * just wiring — resolve the source, call `buildManifest()`, write the result to
 * the same on-disk path the template script used to (`<appRoot>/src/generated/
 * repo-manifest.json`), so `kbx dev`/`kbx build` need no changes.
 *
 * `--check` rebuilds in memory and diffs it against the on-disk manifest,
 * excluding volatile/live-GitHub fields (`generatedAt`, `issues`,
 * `pullRequests`, `commits`, `releases`, `branches`, `repoMetadata` — see
 * `src/lib/manifest-build.ts`), mirroring `kbx connect --check`/`kbx derive
 * --check`. It replaces the template's `check-manifest-drift.js`.
 */

import { dirname, relative } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { getAppRoot } from '../lib/detect-repo.ts';
import { buildRepoManifest, diffManifests, type RepoManifest } from '../lib/manifest-build.ts';
import { manifestOutPath } from './dev.ts';
import { parseManifestArgs } from '../lib/args.ts';

function printHelp() {
  console.log(`
  kbx manifest — build the repo manifest
   
  Usage: kbx manifest [options]
   
Drives the engine's buildManifest() producer over a local FileSystemSource by
  default, a live GitHub API source when --repo <owner/name> is provided, or a
  hybrid local+GitHub manifest when --augment <owner/name> is provided, and
  writes the result to <appRoot>/src/generated/repo-manifest.json.
   
  Options:
      --check               Drift gate: rebuild in memory and diff against the
                            on-disk manifest (excluding generatedAt +
                            live-GitHub fields); exit non-zero on drift,
                            zero when in sync. Never writes.
      --repo <owner/name>   Build from the live GitHub API instead of the local
                            filesystem. Reads GITHUB_TOKEN/GH_TOKEN for auth.
      --augment <owner/name>
                            Hybrid: local content + live GitHub augmentation
                            (repoMetadata/issues/PRs/commits/branches/releases).
      --branch <name>       Git branch to read from when --repo or --augment is
                            used (defaults to main).
  -h, --help                Show this help
`);
}
function toPosix(p: string): string {
  return String(p).split('\\').join('/');
}

export default async function manifest(args: string[] = []): Promise<void> {
  let opts: ReturnType<typeof parseManifestArgs>;
  try {
    opts = parseManifestArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.unknown.length > 0) {
    console.error(`Unknown option(s): ${opts.unknown.join(', ')}`);
    console.error('Run "kbx manifest --help" for usage.');
    process.exit(1);
  }

  const cwd = process.cwd();
  const appRoot = getAppRoot(cwd);

  if (!appRoot) {
    console.error('✗ kbx not found. Run `kbx init` first.');
    process.exit(1);
  }

  const outPath = manifestOutPath(appRoot);
  const relOut = toPosix(relative(cwd, outPath)) || outPath;

  if (opts.check) {
    if (!existsSync(outPath)) {
      console.error(`✗ No manifest at ${relOut}. Run \`kbx manifest\` first.`);
      process.exit(1);
    }
    const onDisk = JSON.parse(readFileSync(outPath, 'utf-8')) as RepoManifest;
    const fresh = await buildRepoManifest(cwd, { repo: opts.repo, branch: opts.branch, augment: opts.augment });
    const drift = diffManifests(onDisk, fresh);
    if (drift.length > 0) {
      console.error(`\n✗ Manifest drift in ${drift.length} field(s):`);
      for (const d of drift) console.error(`  ✗ ${d.field} — ${d.reason}`);
      console.error(`\n  Run \`kbx manifest\` to regenerate, then review + commit the diff.`);
      process.exit(1);
    }
    console.log(`✅ Manifest up to date (${relOut}).`);
    return;
  }

  const manifestData = await buildRepoManifest(cwd, { repo: opts.repo, branch: opts.branch, augment: opts.augment });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifestData, null, 2), 'utf-8');
  const sourceLabel = opts.repo ? ' (remote GitHub source)' : opts.augment ? ' (hybrid manifest)' : '';
  console.log(`✓ Manifest written to ${outPath}${sourceLabel}`);
}
