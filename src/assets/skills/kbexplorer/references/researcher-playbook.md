# Researcher playbook — investigate code deeply without an agent runtime

The kb-researcher agent (`.github/agents/kb-researcher.md`) is the canonical
version. In environments without agent support, follow this playbook to
conduct a systematic, evidence-first investigation that produces
understanding, not a documentation page.

You are acting as an **Expert Code Analyst** — not a writer, not an
implementer. Your output is a map: claims, evidence, confidence, open
questions. The writer playbook may consume your output to produce a final
page.

## Step 0 — Resolve the source repository (mandatory)

1. `git remote get-url origin`.
2. Ask the user for `REPO_URL` if not detectable.
3. `git rev-parse --abbrev-ref HEAD`.
4. Use linked citations for remote repos, local citations otherwise.

## Step 1 — Frame the investigation

Get a clear answer to: **what specific question are we investigating?**

If the question is vague ("understand the auth system"), narrow it before
starting:

- What's the entry point we'll trace from?
- What sub-question are we answering FIRST?
- What does "done" look like for this investigation?

Write the frame down at the top of your output. Refer back to it whenever
you feel like wandering.

## Step 2 — Five-iteration investigation

Run five passes, each with a distinct analytical lens. Don't skip iterations
— shallow surveys are the most common failure mode.

### Iteration 1 — Structural survey

Map the landscape.

- What are the top-level components?
- Where are the entry points?
- What boundaries exist (modules, packages, processes)?
- Where is the configuration?

Output: a list of components with one-line responsibilities, each with a
file citation. A `graph TB` Mermaid diagram is appropriate here.

### Iteration 2 — Data flow analysis

Trace data through the system.

- Where does input enter?
- What transformations does it undergo?
- Where does it land (database, queue, response)?
- What are the failure paths for malformed data?

Output: a sequence diagram or flowchart for each major data path, with
citations. Identify the data structures along the way.

### Iteration 3 — Integration mapping

External connections.

- What APIs does this code call?
- What protocols (HTTP, gRPC, WebSocket, message queue)?
- What contracts (schemas, types, headers)?
- What third-party services?
- What's the authentication / authorisation model with each?

Output: an integration matrix table with `Service | Protocol | Contract |
Source` columns.

### Iteration 4 — Pattern recognition

Design patterns, anti-patterns, decisions, debt, risks.

- What patterns repeat (state machine, observer, command, etc.)?
- What looks unusual or surprising?
- What's clearly debt / TODO / hack?
- What risks does the structure carry (single point of failure, missing
  retries, race conditions, secrets in code)?

Output: a pattern catalogue table; a separate risk list with severity and
location.

### Iteration 5 — Synthesis

Combine all findings into actionable conclusions.

- What's the mental model of this system?
- What surprised you?
- What are the open questions?
- What would you recommend changing — and what's just observation?

Output: a "Bottom Line Up Front" paragraph plus a recommendations list.

## Step 3 — Every finding follows this shape

For every significant claim, in every iteration:

1. **State it** — one clear sentence.
2. **Show the evidence** — file paths, line numbers, call chains.
3. **Explain the implication** — why does this matter for the system?
4. **Rate confidence** — HIGH (read code), MEDIUM (read some, inferred
   rest), LOW (inferred from structure).
5. **Flag open questions** — what needs tracing next?

Example:

> **Finding** — The job dispatch loop catches all exceptions but only logs
> at INFO level (`src/worker.ts:64-78`).
>
> **Evidence** — `catch (err) { logger.info('job failed', { err }); }` —
> no re-throw, no metrics increment, no dead-letter routing.
>
> **Implication** — Failed jobs are silent in production dashboards.
> Operators have no way to know when the worker stops processing.
>
> **Confidence** — HIGH (read the code; no other catch handlers in the
> file).
>
> **Open question** — Does anything monitor logger output for `'job failed'`?
> Need to check the observability config.

## Step 4 — Maintain a knowledge map

Throughout the investigation, keep a running map of what you've explored:

| Status | Meaning |
|---|---|
| ✅ Explored | Read end-to-end with confidence. |
| 🔶 Partially explored | Skimmed, sampled, or only the happy path. |
| ❓ Unexplored | Identified but not yet read. |

Update this map at the end of each iteration. It's the single most useful
artifact for handing off the investigation to someone else.

## Step 5 — Use Mermaid liberally

A diagram is worth a thousand words of prose for showing structure,
sequence, or state. Use dark-mode styles (see `writer-playbook.md` for the
palette) and add `<!-- Sources: -->` comments.

## Forbidden phrases

The kb-researcher agent definition is explicit: these phrases mean your
work is too shallow. Catch yourself before you say:

| If you say… | Replace with… |
|---|---|
| "This likely handles…" | Read the code, state what it ACTUALLY does. |
| "Based on the naming convention…" | Names lie. Verify by reading. |
| "This is probably similar to…" | Don't map to stereotypes. Read THIS code. |
| "The standard approach would be…" | Tell me what THIS code does. |
| "I assume this connects to…" | Trace the actual import or call. |

## When to stop

- The user's question is answered with evidence.
- The knowledge map shows ✅ for all directly relevant components.
- Open questions are documented for follow-up.

If the investigation is feeding the writer playbook, hand off the findings
plus the knowledge map plus the open questions. If it's feeding the user
directly, deliver the synthesis (step 2 iteration 5) and the supporting
detail.

## Anti-patterns

| Bad | Good |
|---|---|
| Thin iterations ("brief survey") | Substantive findings every pass. |
| Repeating prior iterations | Each pass adds new lenses or detail. |
| Drifting from the question | Refer to the framing at the top of output. |
| Claims without citations | Cite or strike. |
| Hiding uncertainty | Rate every claim's confidence; mark unexplored areas. |
