# Loopback canvas contract (frozen A/B seam)

> **Status: frozen.** This document is the _entire_ boundary between the CLI
> (which serves) and the template (which renders). It is the trackable seam that
> [#189](https://github.com/anokye-labs/kbexplorer-cli/issues/189) freezes and
> that [#190](https://github.com/anokye-labs/kbexplorer-cli/issues/190) (A1) and
> the later data/SSE/action issues (A2–A5) implement against, alongside
> `kbexplorer-template#406` / `#408`.
>
> **The CLI never renders; the template never touches disk or spawns servers.**
> The only thing that crosses this line is HTTP on a per-instance loopback origin.
>
> **Contract version: v3** (corrects `filter`'s param name to `nodeType`
> and adds resolved `nodes` to `expand`'s payload — see
> [Changelog](#changelog) for the full v2→v3 diff. `anchor`/`graph-updated`/
> `ready` are unchanged since v1).

Part of the epic
[#188 — Canvas serving & data path](https://github.com/anokye-labs/kbexplorer-cli/issues/188).

## Origin

The canvas host opens **one loopback HTTP server per canvas `instanceId`**, bound
to `127.0.0.1:0` (an OS-assigned ephemeral port). The resulting
`http://127.0.0.1:<port>` is the canvas `url`. The server is memoized per
`instanceId` (re-opening rehydrates the same origin) and torn down when the
canvas closes. Server lifecycle is owned by A1 (`src/extension/canvas-server.js`).

## Boot config

`GET /` returns the embeddable **canvas entry** — `canvas.html` (produced by the
template build in #406) when present, else `index.html` as a best-effort
fallback before #406 lands, else a minimal built-in placeholder — with a
boot-config script injected into whichever entry is served, **before** the
runtime bundle executes:

```js
window.__KBX_CANVAS__ = {
  local: true, // always true on the loopback host
  visualMode: 'inherit-host', // canvas inherits the host's visual mode
  searchServiceUrl: '<origin>/search', // absolute URL the SPA POSTs search to
  anchorNodeId, // optional: node to focus/anchor on open
};
```

`<origin>` is the server's own `http://127.0.0.1:<port>`. `anchorNodeId` is
present only when the canvas was opened against a specific node.

## Endpoints

| Method | Path                   | Owner  | Purpose                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/`                    | **A1** | Embeddable canvas entry — `canvas.html` (from the template build, #406) when present, else `index.html` as a best-effort fallback, else a minimal built-in page — with injected `window.__KBX_CANVAS__` boot config. Static assets (JS/CSS/etc.) are served from the same build directory. |
| `GET`  | `/manifest`            | A2     | `repo-manifest.json` bytes (the full host manifest).                                                                                                                                                                                                                                       |
| `GET`  | `/manifest/slice?ids=` | A2     | Incremental manifest slice for the comma-separated node `ids`.                                                                                                                                                                                                                             |
| `POST` | `/search`              | A3     | `{ query }` → the SPA's `VITE_SEARCH_SERVICE_URL` result shape.                                                                                                                                                                                                                            |
| `GET`  | `/events`              | A4     | SSE stream: `anchor { nodeId }`, `graph-updated { nodes[] }`, and `view-action { action, params, requestId? }` (#212) events.                                                                                                                                                              |
| `POST` | `/affordance/:name`    | A5     | `{ input }` → `executeAffordance` result (consent-gated via `src/affordances/index.js`).                                                                                                                                                                                                   |

### A1 scope vs. later issues

A1 implemented the server lifecycle, `GET /` (serving the available
canvas entry — `canvas.html` preferred, else `index.html`, else a minimal
fallback — plus boot-config injection), and teardown. The data/SSE/action
endpoints landed in follow-up issues and are now all implemented:

- `/manifest`, `/manifest/slice` → A2 ✅ (behind the injected `getManifest` seam)
- `/search` → A3 ✅ (behind the injected `runSearch` seam)
- `/events` → A4 ✅ (SSE; behind the injected `subscribe` seam)
- `/affordance/:name` → A5 ✅ (behind the injected `executeAffordance` seam)

Historically, until each owning issue landed, its endpoint responded `404` with a
small JSON body `{ "error": "not yet", "endpoint": "<path>" }` so callers got a
clear, stable signal rather than a hang or a generic error. No contract endpoint
remains stubbed today.

### `/events` (A4) — SSE event schema

`GET /events` opens a `text/event-stream` (`cache-control: no-cache`,
`connection: keep-alive`). On connect it writes a `: connected` comment, a
`retry: 3000` advisory, and an initial `ready` event; a `: heartbeat` comment is
emitted periodically to keep the connection warm. Domain events follow the frozen
names:

- `anchor` → `data: { "nodeId": "…" }` — focus/anchor the SPA on a node.
  **Unchanged since A4.**
- `graph-updated` → `data: { "nodes": [ … ] | null, ... }` — content/graph
  mutated or the visible node set changed; the SPA re-fetches the affected
  manifest slice and re-renders. **Unchanged since A4** — reserved for future
  content/data mutations; no canvas action emits this event as of #212 (see
  `view-action` below for the agent-driven VIEW actions).
- `view-action` (added #212, contract v2) → `data: { "action":
"expand"|"trace"|"filter", "params": { … }, "requestId"?: "…" }` — a single,
  additive envelope for agent-driven VIEW mutations. Added instead of growing
  the wire vocabulary with one event per action, and instead of overloading
  `anchor` (which is `{ nodeId }`-shaped and can't express a path or a
  cluster/nodeType filter). Consumers that don't recognize `view-action` can
  safely ignore it — this is additive, not a breaking change. See
  [Canvas actions](#canvas-actions-agent-invocable-212) for the exact `params`
  shape per `action`.

Domain events are delivered through an injected `subscribe(instanceId, onEvent)`
seam. `createCanvasRegistry`'s real default (as of #212) is
`createEventBus()` — a per-`instanceId` pub/sub — **not** a no-op: any live
`/events` stream for an instance receives every event the registry's
`emit(instanceId, event, data)` pushes for that same instance, and only that
instance (an emit for one panel never reaches another panel's stream). The
old heartbeat-only no-op (`defaultSubscribe`) is still exported for hermetic
tests that want a truly inert seam, but it is no longer what a real
`open()`'d registry uses. The trigger side is now real too: every canvas
**action** below pushes its event through this same bus after its affordance
call (where applicable) succeeds. A template-side SSE consumer (`EmbeddableApp` /
`useKnowledgeBase`) remains a template-side follow-up.

### Canvas actions (agent-invocable, #212)

The canvas declares an `actions[]` array (Copilot canvas SDK shape —
`{ name, description, inputSchema, handler }`) so the **agent** can drive the
graph the iframe renders, via `invoke_canvas_action`. This is the second half
of the do-seam: `/affordance/:name` (A5) lets the **iframe** call an
affordance over HTTP; `actions[]` lets the **agent** call one through the SDK.
`anchor`/`expand`/`trace` route through the same `executeAffordance` core
(`src/affordances/index.js`) the iframe do-seam uses, so consent/provenance
and node-existence validation are identical either way. `filter` is a pure
VIEW instruction — cluster/nodeType highlighting is expected to apply
**client-side** against the manifest the panel already has — and never calls
an affordance or `registry.search`. Every action, on success, pushes its
event through
`registry.emit(instanceId, event, data)` — the real bus described above — so
the panel that requested the action (or any other panel subscribed to the
same `instanceId`) updates live over `/events`. `instanceId` is resolved from
the SDK's action-invoke context (`ctx.instanceId`); the envelope's `requestId`
field is a forward-compatible, best-effort pass-through of `ctx.requestId`
when the invocation context happens to supply one — the current Copilot
canvas SDK action-invoke shape does not guarantee this field exists, so
consumers **must not** assume `requestId` is reliably present; treat it as
optional correlation metadata only.

| Action   | Input schema                                                                                                                                        | Delegates to                                                                                 | Emits                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor` | `{ nodeId: string }` (required)                                                                                                                     | `query_node { id: nodeId }` (existence check)                                                | `anchor { nodeId }` — **unchanged since A4**                                                                                                                                                                      |
| `expand` | `{ nodeId: string, depth?: number }` (`nodeId` required; `depth` clamped 1–4, default 1, by the `graph_neighbors` affordance)                       | `graph_neighbors { id: nodeId, depth }` (existence + depth validation + neighbor resolution) | `view-action { action: "expand", params: { nodeId, depth?, nodes } }` — `depth` present only when the caller supplied it; `nodes` is the affordance's RESOLVED neighbor list (`{id, title, cluster, distance}[]`) |
| `trace`  | `{ fromId?: string, toId?: string, nodeId?: string }` (one of `fromId`/`nodeId` required; `nodeId` is an alias for `fromId` when `toId` is omitted) | `trace { fromId, toId }` (shortest path, or 1-hop neighbours when `toId` is omitted)         | `view-action { action: "trace", params: { path } }` — `path` is the affordance's computed node-id array                                                                                                           |
| `filter` | `{ cluster?: string, nodeType?: string }` (at least one of `cluster`/`nodeType` required)                                                           | _(none — pure view instruction, no affordance/search call)_                                  | `view-action { action: "filter", params: { cluster?, nodeType? } }` — only the supplied field(s) are present in `params`                                                                                          |

**Honesty note on `expand`'s resolved-neighbor `nodes`:** `expand`'s `view-action`
payload carries the affordance's fully-resolved neighbor list
(`{id, title, cluster, distance}` per neighbor), not just an echo of the
request. This is a deliberate correction from an earlier draft of this
contract that only echoed `{ nodeId, depth? }`: the `/manifest` payload
served to the panel is **raw authored markdown** (`authoredContent`,
keyed by path) with no extracted edge/adjacency array anywhere in it —
`connections:` frontmatter is parsed server-side only (`src/lib/graph.js`),
never serialized into the manifest JSON. A client with no server-side
graph-parsing of its own has no way to compute a neighborhood from
`/manifest` alone, so `expand` must ship the resolved nodes on the wire.

**Honesty note on `trace`'s narrower emit:** `trace`'s `view-action` payload
still only carries the computed `{ path }` (a node-id array), not the full
per-node title/cluster data `trace` internally resolves for each hop. The
affordance call still happens (and its full result — including `nodes` —
is returned to the _agent_ as the action's return value, for its own use),
but the SSE payload assumes the panel can resolve `path`'s ids against data
it already has locally (e.g. a prior `expand`'s `nodes`, or a `/manifest`
fetch) rather than re-shipping full node data for every hop. Unlike
`expand`, `trace`'s neighborhood is a strict subset of ids the client is
very likely to already hold from having reached this node in the first
place; this is called out explicitly as a follow-up worth revisiting if
the template's `trace` rendering needs `path` node data it doesn't
otherwise have.

**Honesty note on `filter`:** `filter` uses `cluster`/`nodeType` — the real
`KBNode` attributes (per `kbexplorer-core`'s `graph.ts`) — **not** `layer`
(an earlier draft used `layer`, which was wrong: "layer" in kbx refers to
visual rendering layers/theme/accent, not a node-grouping attribute; this
was corrected before merge). `filter` also has **no semantic/free-text
`query` mode** — dropped entirely (previously routed through
`registry.search`) in favor of being a pure `cluster`/`nodeType` VIEW
instruction with no data lookup server-side at all; the panel applies the
highlight client-side against the manifest it already has. This is a
**deliberate, flagged capability drop, not a silent regression**: semantic
filtering needs a real server-side data lookup (unlike `cluster`/`nodeType`,
which are plain node attributes the client already has), so it doesn't fit
`filter`'s "pure view instruction" contract — if the template needs it, it
should be a dedicated `search` view-op/action with its own data-lookup
seam (`registry.search` already exists and is untouched, still backing
`/search` (A3) — a canvas `search` action could reuse it), tracked as a
separate follow-up issue rather than smuggled into `filter`. At least one
of `cluster`/`nodeType` is required (both may be given together); the
handler throws a `TypeError` when neither is a non-empty string.

Action names deliberately avoid the SDK-reserved `canvas.` prefix (lifecycle
verbs). Handlers throw a plain `TypeError` for a missing required input field
(e.g. `anchor` with no `nodeId`, or `filter` with neither `cluster` nor
`nodeType`) before calling any affordance or emitting; affordance-level errors
(`NOT_FOUND`, `INVALID_INPUT`, consent-denied, …) propagate as-is — the SDK
surfaces the thrown error as the action's failure, no envelope is imposed
here.

### `/affordance/:name` (A5) — the do-seam adapter

`POST /affordance/:name` routes straight through the affordance registry's
`executeAffordance`, making the canvas a first-class **do-seam adapter** — the
third delivery surface after the extension-tool adapter (#163) and the MCP
adapter (#197). Consent and provenance are enforced **at the action core**
(`src/affordances/index.js`), fail-closed, identically to the other adapters; the
handler imports the registry, never a transport, and never re-implements consent.
The request body is the affordance input (a `{ "input": … }` envelope is also
accepted). Error mapping: unknown affordance → `404`, invalid input → `400`,
consent required/denied → `403` (surfaced, not crashed), non-POST → `405`;
success → `200 { "ok": true, "result": … }`.

## Invariants

- **One server per `instanceId`**, memoized; re-`open()` returns the same origin.
- **Loopback only** — always `127.0.0.1`, never a routable interface.
- **Ephemeral port** — bind `:0`; never hard-code a port.
- **Boot config is injected server-side**, not shipped in the static build, so
  the origin-relative `searchServiceUrl` and `anchorNodeId` are always correct.
- **Teardown on close** — closing the canvas closes its server and frees the port.
- **Emit is instance-scoped** — `registry.emit(instanceId, event, data)` (and
  therefore every canvas action) only reaches `/events` streams open for that
  same `instanceId`; it never leaks to another panel.

## Changelog

- **v1** (A1–A5, #190–#193, #201): server lifecycle, `/manifest`+`/manifest/slice`
  (A2), `/search` (A3), `/events` SSE with `anchor`/`graph-updated` (A4),
  `/affordance/:name` do-seam (A5).
- **v2** (#212): added the `actions[]` agent-invoke surface
  (`anchor`/`expand`/`trace`/`filter`) and a real per-instance SSE emit bus
  (replacing the no-op `defaultSubscribe` default). Added exactly one new,
  additive SSE event — `view-action { action, params, requestId? }` — for the
  `expand`/`trace`/`filter` actions. `anchor`/`graph-updated`/`ready` are
  **unchanged**.
- **v3** (#212 review follow-up, pre-merge): two corrections found during
  end-to-end review of the v2 draft, before it shipped —
  1. `filter`'s second param was renamed `layer` → `nodeType`. `layer` was
     wrong: it doesn't correspond to any `KBNode` attribute in
     `kbexplorer-core`'s `graph.ts` (which carries `cluster` + `nodeType`);
     "layer" in kbx means visual rendering layers (theme/accent/heroes), not
     a node-grouping field. `filter`'s semantic/free-text `query` mode
     (routed through `registry.search` in an earlier draft) was dropped
     entirely and explicitly documented as a flagged follow-up, not folded
     silently into `nodeType`.
  2. `expand`'s `view-action` params now include the affordance's resolved
     `nodes` (`{id,title,cluster,distance}[]`), not just an echo of
     `{ nodeId, depth? }`. Confirmed via direct inspection of
     `generateManifest()` (`src/lib/manifest.js`) that `/manifest` carries
     only raw `authoredContent` markdown strings — no edges/connections
     array — so a template client cannot compute a node's neighborhood from
     the manifest alone; the server must ship resolved neighbor data.
