# Contributing

Thank you for your interest in contributing to this project.

## Getting Started

1. **File an issue first.** Every change must trace back to a GitHub Issue. Use the appropriate issue type (Epic, Feature, Task, or Bug).
2. **Create a branch.** Work on a feature branch — never commit directly to the default branch.
3. **Open a pull request.** Reference the issue in your PR description.
4. **Resolve all conversations.** All review comments must be resolved before merging.

## Issue Types

| Type | Use When |
|------|----------|
| Epic | Large initiatives spanning multiple features |
| Feature | User-facing capabilities or system components |
| Task | Concrete, actionable work items |
| Bug | Defects and fixes |

Issue types are set via the GitHub Issue Type field, not labels or title prefixes.

## Development Workflow

1. Clone the repository and create a feature branch
2. Make your changes following existing code conventions
3. Run the build and tests locally before pushing
4. Open a PR and ensure CI passes
5. Address any review feedback

## TypeScript Migration Increment

This repository is migrating to TypeScript incrementally. The first increment uses a gradual `allowJs: true` + `checkJs: false` project so existing JavaScript modules can be adopted without a mass rename.

- The CLI entrypoint is now a thin Node wrapper around the built output from `src/cli.ts`.
- The representative argument-parser module lives in `src/lib/args.ts`; existing consumers continue to import the `src/lib/args.js` shim until the rest of the tree is migrated.
- New TypeScript work should keep the same convention: add the implementation in a `.ts` module, keep a `.js` shim only when a runtime path still needs to be imported from plain JavaScript, and verify with `npm run typecheck` plus the relevant tests.
- The next conversion targets should be small, reusable helpers that are imported by multiple commands (for example other parser helpers or shared runtime utilities).

## Code Style

This project uses automated formatting and linting. Check for `.editorconfig`, `ruff.toml`, `.prettierrc.json`, or similar configuration files and ensure your changes conform.

## Branch Protection

The default branch has protection rules enforced:
- Direct pushes are blocked
- All PR conversations must be resolved before merging
- Force pushes and branch deletion are blocked