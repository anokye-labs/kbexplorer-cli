# Loopback canvas contract (frozen A/B seam)

> **Status: frozen.** This document is the *entire* boundary between the CLI
> (which serves) and the template (which renders). It is the trackable seam that
> [#189](https://github.com/anokye-labs/kbexplorer-cli/issues/189) freezes and
> that [#190](https://github.com/anokye-labs/kbexplorer-cli/issues/190) (A1) and
> the later data/SSE/action issues (A2–A5) implement against, alongside
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
  local: true,                          // always true on the loopback host
  visualMode: 'inherit-host',           // canvas inherits the host's visual mode
  searchServiceUrl: '<origin>/search',  // absolute URL the SPA POSTs search to
  anchorNodeId,                         // optional: node to focus/anchor on open
};
```

`<origin>` is the server's own `http://127.0.0.1:<port>`. `anchorNodeId` is
present only when the canvas was opened against a specific node.

## Endpoints

| Method | Path                | Owner | Purpose |
|--------|---------------------|-------|---------|
| `GET`  | `/`                 | **A1** | Embeddable canvas entry — `canvas.html` (from the template build, #406) when present, else `index.html` as a best-effort fallback, else a minimal built-in page — with injected `window.__KBX_CANVAS__` boot config. Static assets (JS/CSS/etc.) are served from the same build directory. |
| `GET`  | `/manifest`         | A2    | `repo-manifest.json` bytes (the full host manifest). |
| `GET`  | `/manifest/slice?ids=` | A2 | Incremental manifest slice for the comma-separated node `ids`. |
| `POST` | `/search`           | A3    | `{ query }` → the SPA's `VITE_SEARCH_SERVICE_URL` result shape. |
| `GET`  | `/events`           | A4    | SSE stream: `graph-updated { nodes[] }` and `anchor { nodeId }` events. |
| `POST` | `/affordance/:name` | A5    | `{ input }` → `executeAffordance` result (consent-gated via `src/affordances/index.js`). |

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

- `graph-updated` → `data: { "nodes": [ … ] }` — content/graph mutated; the SPA
  re-fetches the affected manifest slice and re-renders.
- `anchor` → `data: { "nodeId": "…" }` — focus/anchor the SPA on a node.

Domain events are delivered through an injected `subscribe(instanceId, onEvent)`
seam. The default seam is a no-op (heartbeat-only): the endpoint is live and
hermetic today, and real triggers (file-watch / regenerate → `graph-updated`;
canvas action → `anchor`) are a deliberate follow-up. A template-side SSE
consumer (`EmbeddableApp` / `useKnowledgeBase`) is likewise a follow-up.

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
