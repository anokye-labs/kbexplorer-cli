# Loopback canvas contract (frozen A/B seam)

> **Status: frozen.** This document is the _entire_ boundary between the CLI
> (which serves) and the template (which renders). It is the trackable seam that
> [#189](https://github.com/anokye-labs/kbexplorer-cli/issues/189) freezes and
> that [#190](https://github.com/anokye-labs/kbexplorer-cli/issues/190) (A1) and
> the later data/SSE/action issues (A2–A6) implement against, alongside
> `kbexplorer-template#406` / `#408`.
>
> **The CLI never renders; the template never touches disk or spawns servers.**
> The only thing that crosses this line is HTTP on a per-instance loopback origin.

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
| `GET`  | `/events`              | A4     | SSE stream: `graph-updated { nodes[] }` and `anchor { nodeId }` events.                                                                                                                                                                                                                    |
| `POST` | `/affordance/:name`    | A5     | `{ input }` → `executeAffordance` result (consent-gated via `src/affordances/index.js`).                                                                                                                                                                                                   |
| `POST` | `/chat-intent`         | A6     | `{ intent, nodeId, prompt? }` → posts a real new agent chat turn on the joined SDK session; `{ ok: true, messageId }`.                                                                                                                                                                     |

### A1 scope vs. later issues

A1 implemented the server lifecycle, `GET /` (serving the available
canvas entry — `canvas.html` preferred, else `index.html`, else a minimal
fallback — plus boot-config injection), and teardown. The data/SSE/action
endpoints landed in follow-up issues and are now all implemented:

- `/manifest`, `/manifest/slice` → A2 ✅ (behind the injected `getManifest` seam)
- `/search` → A3 ✅ (behind the injected `runSearch` seam)
- `/events` → A4 ✅ **endpoint** is live; domain-event wiring is **not** (see below —
  heartbeat-only scaffolding today, no real triggers, no consumer)
- `/affordance/:name` → A5 ✅ (behind the injected `executeAffordance` seam)
- `/chat-intent` → A6 ✅ (behind the injected `sendChatMessage` seam)

Historically, until each owning issue landed, its endpoint responded `404` with a
small JSON body `{ "error": "not yet", "endpoint": "<path>" }` so callers got a
clear, stable signal rather than a hang or a generic error. No contract endpoint
route remains stubbed today — but see `/events` below: the *transport* is
finished, the *feature* (real domain events reaching a real consumer) is not.

### `/events` (A4) — SSE event schema

**Status: heartbeat-only scaffolding, not a finished feature.** The HTTP
endpoint is real and live (correct headers, `ready` event, periodic
heartbeat), but no code anywhere in this repo or its template emits an actual
`graph-updated` or `anchor` event, and no SPA consumer subscribes to any of
this. Treat `/events` today as "the wire is connected and idles cleanly," not
"canvas updates push live" — that remains future work, not something already
shipped.

`GET /events` opens a `text/event-stream` (`cache-control: no-cache`,
`connection: keep-alive`). On connect it writes a `: connected` comment, a
`retry: 3000` advisory, and an initial `ready` event; a `: heartbeat` comment is
emitted periodically to keep the connection warm. Domain events follow the frozen
names (schema only — see status note above for what actually fires today):

- `graph-updated` → `data: { "nodes": [ … ] | null, ... }` — content/graph
  mutated or the visible node set changed; the SPA re-fetches the affected
  manifest slice and re-renders. The base payload is `{ "nodes": [...] }`; the
  canvas **actions** below (#194) additionally set a `"reason"` field
  (`"expand" | "trace" | "filter"`) plus action-specific fields — see
  [Canvas actions](#canvas-actions-agent-invocable-194) for the exact shape
  each action emits. `"nodes"` is `null` only for a `filter` with no `query`
  (see below).
- `anchor` → `data: { "nodeId": "…" }` — focus/anchor the SPA on a node.

Domain events are delivered through an injected `subscribe(instanceId, onEvent)`
seam. `createCanvasRegistry`'s real default (as of #194) is
`createEventBus()` — a per-`instanceId` pub/sub — **not** a no-op: any live
`/events` stream for an instance receives every event the registry's
`emit(instanceId, event, data)` pushes for that same instance, and only that
instance (an emit for one panel never reaches another panel's stream). The
old heartbeat-only no-op (`defaultSubscribe`) is still exported for hermetic
tests that want a truly inert seam, but it is no longer what a real
`open()`'d registry uses. The trigger side is now real too: every canvas
**action** below pushes its event through this same bus after its affordance
call succeeds. A template-side SSE consumer (`EmbeddableApp` /
`useKnowledgeBase`) remains a template-side follow-up.

### Canvas actions (agent-invocable, #194)

The canvas declares an `actions[]` array (Copilot canvas SDK shape —
`{ name, description, inputSchema, handler }`) so the **agent** can drive the
graph the iframe renders, via `invoke_canvas_action`. This is the second half
of the do-seam: `/affordance/:name` (A5) lets the **iframe** call an
affordance over HTTP; `actions[]` lets the **agent** call one through the SDK.
`anchor`/`expand`/`trace` route through the same `executeAffordance` core
(`src/affordances/index.js`) the iframe do-seam uses, so consent/provenance
are identical either way. `filter`'s query mode instead calls
`registry.search(params)` — the exact seam the `/search` HTTP endpoint (A3)
uses, including its dependency-free text-index fallback — rather than the
raw `search` affordance, which hard-throws `UNSUPPORTED`/`MISSING_ARTIFACT`
when no `@anokye-labs/kbexplorer-search` engine or `.search/` artifacts are
installed; this keeps `filter` usable in a stock checkout. Every action, on
success, pushes the resulting domain event through
`registry.emit(instanceId, event, data)` — the real bus described above — so
the panel that requested the action (or any other panel subscribed to the
same `instanceId`) updates live over `/events`. `instanceId` is resolved from
the SDK's action-invoke context (`ctx.instanceId`).

| Action | Input schema | Delegates to | Emits |
|---|---|---|---|
| `anchor` | `{ nodeId: string }` (required) | `query_node { id: nodeId }` (existence check) | `anchor { nodeId }` |
| `expand` | `{ nodeId: string, depth?: number }` (`nodeId` required; `depth` clamped 1–4, default 1) | `graph_neighbors { id: nodeId, depth }` | `graph-updated { nodes: [nodeId, ...neighborIds], reason: "expand", focus: nodeId }` |
| `trace` | `{ fromId?: string, toId?: string, nodeId?: string }` (one of `fromId`/`nodeId` required; `nodeId` is an alias for `fromId` when `toId` is omitted) | `trace { fromId, toId }` (shortest path, or 1-hop neighbours when `toId` is omitted) | `graph-updated { nodes: path, reason: "trace", path, connected }` |
| `filter` | `{ query?: string, cluster?: string, nodeType?: string }` (all optional) | `registry.search { query, cluster, entityType: nodeType }` **only when `query` is given** — engine-backed when `.search/*` artifacts exist, else the dependency-free text index | `graph-updated { reason: "filter", filter: { query, cluster, nodeType }, nodes }` — `nodes` is the matched id array when `query` was given, else `null` |

**Honesty note on `filter`:** the `query` path works in a stock checkout —
`registry.search` degrades gracefully to a dependency-free text index over
the live manifest (same fallback `/search` uses) when no search engine or
`.search/*` artifacts are installed, and both paths honor `cluster`/`nodeType`
as exact-match filters. When only `cluster`/`nodeType` are given (no
`query`), the action still validates and emits — so the panel gets a live
`graph-updated` frame to react to — but `nodes` is `null` and the SPA is
expected to apply the cluster/nodeType predicate client-side against the
manifest it already has; there is currently no affordance/seam that filters
purely by cluster/entity type server-side with no query term. This is a
documented, intentional partial capability, not an oversight.

Action names deliberately avoid the SDK-reserved `canvas.` prefix (lifecycle
verbs). Handlers throw a plain `TypeError` for a missing required input field
(e.g. `anchor` with no `nodeId`) before calling any affordance; affordance-level
errors (`NOT_FOUND`, `INVALID_INPUT`, consent-denied, …) propagate as-is —
the SDK surfaces the thrown error as the action's failure, no envelope is
imposed here.

### `/affordance/:name` (A5) — the do-seam adapter

`POST /affordance/:name` routes straight through the affordance registry's
`executeAffordance`, making the canvas a first-class **do-seam adapter** — the
third delivery surface after the extension-tool adapter (#163) and the MCP
adapter (#197). Consent and provenance are enforced **at the action core**
(`src/affordances/index.js`); the handler imports the registry, never a
transport, and never re-implements consent. The request body is the affordance
input (a `{ "input": … }` envelope is also accepted). Error mapping: unknown
affordance → `404`, invalid input → `400`, consent required/denied → `403`
(surfaced, not crashed), non-POST → `405`; success → `200 { "ok": true, "result": … }`.

**Consent status today: this route supplies no `requestConsent` seam.** The
choke point is the same one every adapter shares, but "fail-closed identically"
does not mean "capable identically" — only the MCP adapter
([`docs/mcp-adapter.md`](mcp-adapter.md)) currently wires an interactive
consent seam. Every `write` / `sample`-class affordance called through this
route unconditionally gets the fail-closed default and returns
`403 CONSENT_REQUIRED`; only `read`-class affordances complete end-to-end
through `/affordance/:name` as shipped. Implementing a canvas-side consent UX
is tracked as **post-launch** work.

### `/chat-intent` (A6, #195) — click→chat seam

`POST /chat-intent` is how the iframe turns a UI click into a **real new agent
chat turn** in the same session the canvas is embedded in — the mechanism
`kbexplorer-template#410`'s click affordances (`pin`, `derives`, `affected`, …)
build on.

**Request body:**

```jsonc
{ "intent": "pin" | "derives" | "affected" | string, "nodeId": "string", "prompt": "string?" }
```

`intent` and `nodeId` are required (non-empty strings). `prompt` is optional —
when given it is used **verbatim** as the chat-turn text (the iframe is free
to author its own phrasing); when omitted, a canned phrasing is used for the
three known intents (`pin`/`derives`/`affected`); an **unknown** `intent` with
no `prompt` is rejected `400` rather than guessing at text for an intent the
CLI doesn't recognize.

**Response:** `200 { "ok": true, "messageId": "<sdk-message-id>" | null }`. The
`messageId` is the id `Session.send()` returns — additive beyond the `{ ok:
true }` the consumer issue asked for; safe to ignore.

**By design, this endpoint never executes anything directly.** Every intent —
read-only (`derives`, `affected`) or mutating (`pin`) — is turned into a real
`Session.send(prompt)` chat turn on the joined SDK session; there is no
direct-execute shortcut through `/affordance/:name` here. This is a
deliberately conservative choice, not a missed optimization: the frozen
contract _permits_ read-only intents to resolve directly, but routing
everything through the agent trivially guarantees a mutating intent can
**never** bypass the agent's own consent gate by reaching this endpoint, and
it matches the consumer issue's own acceptance criterion that even a
read-only intent like "what derives from this?" must produce a real,
observable chat turn (not a silent direct fetch).

**Failure modes:**

- No SDK session is joined yet (canvas opened standalone, or `/chat-intent`
  reached before `joinSession()` resolves) → **fails closed**, never a fake
  `200`. Depending on exactly how "not ready" is detected this surfaces as
  either `503 { "error": "chat seam unavailable" }` (no `sendChatMessage` seam
  configured at all) or `500 { "error": "chat-intent failed" }` (a seam is
  configured but the session it lazily reads isn't bound yet) — both are
  fail-closed, neither ever returns `{ ok: true }` without a real message
  having been sent.
- Missing `intent`/`nodeId`, invalid JSON body → `400`.
- `nodeId` that isn't kebab-case (lowercase letters, digits, hyphens) → `400`.
  Enforced **before** templating, so a crafted `nodeId` (quotes, newlines,
  prompt-injection text) can never ride along into the canned prompt text
  handed to `sendChatMessage`.
- Unknown `intent` with no `prompt` → `400`.
- Non-`POST` → `405`.
- `sendChatMessage` itself throwing (e.g. the SDK call rejects) → `500`.

**Production wiring:** `src/extension/index.js`'s `registerKbxExtension`
builds the canvas registry with a `sendChatMessage` seam that closes over a
`session` variable set only _after_ `joinSession()` resolves (the registry —
and its HTTP server — must exist _before_ `joinSession()` is called, since the
canvas has to be constructed first and handed to it). The closure reads
`session` lazily, so a `/chat-intent` request that arrives after `join`
resolves reaches the real `session.send(prompt)`.

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
