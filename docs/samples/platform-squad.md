# Platform Squad

Jane Doe (VP Engineering) leads the Platform Squad. The Platform Squad owns the
build and derivation runtime, and it staffs Amir Khan (Staff Engineer).

This file is a small, human-readable sample source for `kbexplorer derive`. It
is intentionally prose: `derive` reads `.docx`, prose Markdown, and plain text
identically. Running

```bash
kbexplorer derive docs/samples/platform-squad.md
```

re-emits the committed artifact at `content/derived/platform-squad.jsonld`. The
emit is deterministic and timestamp-free, so the committed file is the canonical
output and `kbexplorer derive docs/samples/platform-squad.md --check` stays green
until this source changes. See `content/node-type-contract.md` for how the
template engine renders the result.
