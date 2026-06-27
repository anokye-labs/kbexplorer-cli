---
id: "zero-deps"
title: "Dependency Philosophy"
emoji: "Diamond"
cluster: infra
parent: home
connections:
  - to: "lib-frontmatter"
    description: "hand-rolled frontmatter parsing is the canonical case for delegating to a vetted library"
  - to: "cli-router"
    description: "routing and argument parsing are moving from hand-rolled code to commander"
---

kbexplorer-cli once advertised **zero runtime dependencies** — `package.json`
declared no `dependencies` at all, and the CLI leaned entirely on Node
built-ins plus shellouts to `git`, `gh`, and `vite`. That posture has been
**retired**. Hand-rolling a YAML parser, an MCP protocol stack, and an argument
parser cost more than it saved: more code to test, more edge cases to get
wrong, and a worse result than the conventional libraries everyone already
trusts.

The replacement is not "depend on everything." It is a **deliberate, minimal,
vetted** dependency set: reach for a well-maintained library when it removes
hand-rolled protocol or parsing code, and keep using Node built-ins for
everything else.

## The principle

- **Delegate protocol and parsing.** Wire formats and grammars — MCP JSON-RPC,
  YAML frontmatter, CLI argument parsing — are solved problems. Use the
  standard implementation instead of a bespoke subset.
- **Stay lean everywhere else.** Filesystem walks, `git` / `gh` / `vite`
  shellouts, retrieval scoring, and the `.docx` unzip stay built-ins-only — a
  dependency would buy nothing there.
- **Vet what you add.** Each dependency is chosen for maintenance health, a
  stable API, and a footprint the project is willing to own. Additions are
  reviewed on their merits, not rejected by reflex.

## What landed first

The MCP server was the first module to switch. It is built on the official
**`@modelcontextprotocol/sdk`** (with `zod` for tool schemas) instead of a
hand-rolled JSON-RPC-over-stdio harness — the SDK owns the handshake, the
bidirectional `sampling` / `roots` calls, and stdio framing, which are
genuinely hard to re-derive correctly. See the
[design doc](https://github.com/gaming-microsoft/kbexplorer-cli/blob/main/docs/mcp-server.md).

## Still in flight

The same reasoning is being applied to the other hand-rolled corners as
separate, reviewed changes: frontmatter parsing moves to `js-yaml` (see
[lib-frontmatter](lib-frontmatter)), and CLI routing / argument parsing moves
to `commander`.

## The trade-off we accept

A real dependency tree is a real supply chain. The MCP SDK, for example, pulls
a sizable transitive set because it bundles HTTP/SSE transports this
stdio-only server never uses. That cost is acceptable where the library removes
fragile hand-rolled code — and swapping a heavy library for a lighter one stays
on the table if a footprint stops being worth it.

<!-- Sources: package.json -->
