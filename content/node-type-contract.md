---
id: "node-type-contract"
title: "Engine Node-Type Contract"
emoji: "Tag"
cluster: derivation
parent: derivation-overview
connections:
  - to: "cmd-derive"
    description: "derive is the producer of contract-conforming artifacts"
  - to: "derivation-runtime"
    description: "the deterministic emitter lives in lib/jsonld.js"
  - to: "lib-frontmatter"
    description: "authored nodes and derived nodes share one graph"
---

Derived artifacts are not free-form JSON — they conform to the **node-type
contract** published by the template engine (Epic 1 / F1,
[kbexplorer-template#148](https://github.com/anokye-labs/kbexplorer-template/issues/148)).
Conforming is what guarantees a `derive` artifact renders as a typed node in the
engine with **zero** core edits. The CLI's emitter, `src/lib/jsonld.js`, encodes
this contract and `validateArtifact()` enforces it on every run.

## The contract surface

The engine's `KBNode` gained three additive fields (F1, T1.1–T1.5):

| Field | Meaning | CLI emits |
|---|---|---|
| `jsonld.@id` | Identity URN, **reused** as identity — never path-derived | `kg://<type>/<slug>` |
| `jsonld.@type` | Open node-type discriminator — **never** from a file path | `person`, `squad`, … |
| `jsonld.@context` | LD context | `https://schema.org` |
| `entityType` | Open registry key (mirrors `@type`) | same as `@type` |
| `data` | Free-form structured bag the viewers render | `{ name, … }` |
| `source` | `{ type: 'structured', entityType, ref }` | reversible to the source doc |

A brand-new node type does **not** widen any union. It rides the
`source: { type: 'structured', entityType: '<kind>' }` variant plus a
`registerType({ id: '<kind>', … })` call in the engine — the "openness
contract" from #148.

## The six-relation taxonomy

Relationships map onto exactly six `KnownRelation` values, shared verbatim
between the CLI (`KNOWN_RELATIONS` in `src/lib/jsonld.js`) and the engine:

```
leads | staffs | reports-to | structural | derived | deprecated
```

`mapRelation()` folds common phrasings onto this set (`manages → leads`,
`member-of → staffs`, `part-of → structural`, …); anything unknown falls back to
`structural`, so an edge is never off-taxonomy.

## What the engine renders

The template registers a **content-model spine** of entity kinds, each bound to
a bespoke viewer (`src/engine/content-model/register.ts`):

| `@type` | Viewer | Typical relations |
|---|---|---|
| `person` | `PersonView` | `reports-to` |
| `squad` | `SquadView` | `leads`, `staffs`, `structural`, `deprecated` |
| `workstream` | `WorkstreamView` | `structural` |
| `mission` | `MissionView` | `structural` |
| `priority` / `cycle` / `org` | `PriorityView` / `CycleView` / `OrgView` | — |

Crucially, the registry is **open** and `GenericStructuredView` is a *mandatory
fallback*: a `@type` with no bespoke viewer (say `skill` or `team`) still
renders its `data`/`jsonld` as a structured table. So derived artifacts always
render — bespoke when a viewer exists, generic otherwise.

## Worked example — derive → .jsonld → rendered node

This repo ships a runnable sample. The source
[`docs/samples/platform-squad.md`](https://github.com/anokye-labs/kbexplorer-cli/blob/main/docs/samples/platform-squad.md)
says *"Jane Doe (VP Engineering) leads the Platform Squad … it staffs Amir Khan
(Staff Engineer)."* Running `kbexplorer derive docs/samples/platform-squad.md`
emits the committed artifact
[`content/derived/platform-squad.jsonld`](https://github.com/anokye-labs/kbexplorer-cli/blob/main/content/derived/platform-squad.jsonld)
— excerpt of its `@graph` (verbatim, validated output of `src/lib/jsonld.js`):

```jsonc
"@graph": [
  { "@context": "https://schema.org", "@id": "kg://person/jane-doe",
    "@type": "person", "name": "Jane Doe", "jobTitle": "VP Engineering" },
  { "@context": "https://schema.org", "@id": "kg://squad/platform-squad",
    "@type": "squad", "name": "Platform Squad",
    "mission": "Own the build and derivation runtime" },
  { "@id": "kg://edge/person/jane-doe~leads~squad/platform-squad",
    "@type": "Relationship", "relation": "leads",
    "from": { "@id": "kg://person/jane-doe" },
    "to":   { "@id": "kg://squad/platform-squad" } }
  // …also kg://person/amir-khan and a `staffs` edge
]
```

Alongside the LD `@graph`, the artifact carries a **KBNode mirror** the engine
consumes directly:

```jsonc
"kbexplorer": {
  "nodes": [{
    "id": "kg://person/jane-doe", "identity": "kg://person/jane-doe",
    "entityType": "person", "title": "Jane Doe",
    "source": { "type": "structured", "entityType": "person",
                "ref": "docs/samples/platform-squad.md#jane-doe" },
    "data": { "name": "Jane Doe", "jobTitle": "VP Engineering" }
  }]
}
```

The engine resolves `entityType: "person"` to `PersonView`, the `squad` node to
`SquadView`, and styles the `leads` edge from the shared taxonomy — closing the
loop from a sentence in a source doc to a rendered, navigable node. The
`source.ref` keeps the mapping reversible back to the originating document, and
`kbexplorer derive … --check` proves the committed `.jsonld` is byte-identical
canonical output (no LLM call).

<!-- Sources: src/lib/jsonld.js, src/commands/derive.js; kbexplorer-template#148, src/engine/node-types/registry.ts, src/engine/content-model/register.ts -->
