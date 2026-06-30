# Rich-Markdown provider

Wave 0b · issue [kbexplorer-cli#133](https://github.com/anokye-labs/kbexplorer-cli/issues/133)

A loadable [`defineProvider()`](https://github.com/anokye-labs/kbexplorer-core)
module that ingests **one Markdown document** into a pure `KBGraph` fragment —
one node plus its typed edges — on top of the released
**`@anokye-labs/kbexplorer-core@v0.1.0`** identity + provider seams.

- Pure ingestion library: [`src/lib/rich-markdown.js`](../src/lib/rich-markdown.js)
- Provider wrapper: [`src/providers/rich-markdown.js`](../src/providers/rich-markdown.js)
- Deterministic fixture: [`docs/samples/rich-markdown-sample.md`](samples/rich-markdown-sample.md)
- Tests: [`tests/lib/rich-markdown.test.js`](../tests/lib/rich-markdown.test.js),
  [`tests/providers/rich-markdown.test.js`](../tests/providers/rich-markdown.test.js)

## What it captures

| Affordance | Where it lands | Notes |
|---|---|---|
| **Full frontmatter** | `node.data` | ARBITRARY keys preserved, not a known subset. Typed scalars, inline `[..]`/`{..}` flow, block sequences (incl. sequences of maps), nested maps and block scalars. |
| **Embedded blocks** | `node.data.richMarkdown.blocks[]` | Fenced `dot` / `mermaid` / `ics` / `canvas` only. Each carries a `contentHash` (`sha256:hex:…`) plus document `span` / `contentSpan` (char offsets) and `lines`. |
| **Typed edges** | `ProviderResult.edges` | From Markdown links and the annotated `[..](urn){rel=..}` form. Relations are mapped onto the core six-relation taxonomy via `mapRelation`. |
| **Links (all)** | `node.data.richMarkdown.links[]` | Every link is recorded for provenance; `emitEdge` flags which become edges. |

### Identity (core v0.1.0)

The node id is minted with **`buildAddress(body, { scheme, authority })`**. The
body is **opaque** — it never encodes the entity's type — so a node can be
re-typed without its identifier changing. The body is the frontmatter `id`
(verbatim) or, absent that, a slug of the source path/title. A declared type
(`entityType` / `@type` in frontmatter) is carried as an attribute
(`node.entityType` + `node.jsonld['@type']`), never in the id.

```
kg://docs/rich-markdown-sample        # scheme=kg, authority=docs, body=rich-markdown-sample (opaque)
```

Scheme/authority resolve from the provider `options`, then the KB's
`config.identity` block (`scheme`, `authority`, `sourceAuthorities`), then the
core defaults (`kg://`, no authority).

### Edge emission rule

An edge is emitted for a link when it carries an explicit `{rel=..}` **or** its
target is a `<scheme>://` address. Plain relative/non-address links (e.g.
`./other.md`) are recorded under `data.richMarkdown.links` for provenance but are
**not** emitted as edges (they would otherwise dangle). Frontmatter
`connections:` entries are also emitted as edges (`source: 'frontmatter'`).

## Provenance — interim seam (core#23)

The released core (v0.1.0) shipped only **E1.P1** (identity + the `markdown`
source format). The formal **`SourceRef`** provenance contract is
[core#23](https://github.com/anokye-labs/kbexplorer-core/issues/23) — a later E1
child that is **not yet released**. Until it ships, every fact (the node, each
block, each link) carries an **interim** provenance pointer built by
`makeSourceRef()` — the information we already have:

```jsonc
{ "kind": "interim-source-ref", "source": "docs/…/x.md",
  "span": { "start": 1078, "end": 1148 },
  "contentHash": "sha256:hex:5b63…" }
```

These live under `node.data` (the node under `data.richMarkdown.source`, blocks +
links each carry their own `sourceRef`), so `KBEdge` stays contract-pure (it has
no `data` field). When core#23 lands, swap the single `makeSourceRef` helper for
the formal `SourceRef` type — the call sites are centralized for exactly that.

## Usage

The provider is a standard loadable module: a host points an
`ExternalProviderConfig` at it via `module` and runs the default export.

```jsonc
// config.yaml (providers section) — illustrative
{
  "type": "custom",
  "name": "Docs",
  "cluster": "docs",
  "module": "./src/providers/rich-markdown.js",
  "options": {
    "path": "docs/samples/rich-markdown-sample.md",
    "scheme": "kg",
    "authority": "docs"
  }
}
```

Programmatically:

```js
import provider from './src/providers/rich-markdown.js';

const p = provider({ name: 'Docs', cluster: 'docs', options: { path: 'docs/x.md' } });
const { nodes, edges } = await p.resolve({ config: { identity: { scheme: 'kg' } } });
```

`options.content` (inline Markdown) may be supplied instead of `options.path`
for hermetic, filesystem-free use; pair it with `options.sourcePath` for a
provenance label.

## Determinism

Line endings are normalized to LF up front, so every content hash and source
offset is reported against the LF-normalized document and is **byte-identical on
LF and CRLF checkouts**. Re-running the provider on an unchanged source yields
byte-identical output — the property the committed fixture and its tests pin.
