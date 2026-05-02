# Docs README

Start here before extending Overwatch.

## Read In This Order

1. **[architecture/INDEX.md](architecture/INDEX.md)** — short pointer doc.
2. **[architecture/007-post-overhaul-architecture.md](architecture/007-post-overhaul-architecture.md)** — the canonical "what is" doc. Topology, components, wire protocol, deploy, invariants.
3. **[architecture/008-protocol-and-codegen.md](architecture/008-protocol-and-codegen.md)** — JSON Schema → TS + Python codegen pipeline.
4. **[architecture/009-auth-pairing-and-tokens.md](architecture/009-auth-pairing-and-tokens.md)** — pairing-token vs session-token, three-validator chain.
5. **[architecture/004-harness-pluggability.md](architecture/004-harness-pluggability.md)** — how to add a new harness provider.
6. **[architecture/005-hermes-bridge.md](architecture/005-hermes-bridge.md)** — Hermes-mode specifics.
7. **[insights.md](insights.md)** — small observations and gotchas.

## Folder layout

| Path | Purpose |
| --- | --- |
| `architecture/` | Current state of the system. Source of truth. |
| `plans/` | Active or proposed plans that haven't shipped yet. |
| `plans/implemented/` | Plans that have shipped — frozen historical context. |
| `research/` | Research findings, comparisons, technical explorations. |
| `insights.md` | Small observations and gotchas worth revisiting. |

## Notes for future agents

- Architecture docs are the live source of truth. When code changes, update the relevant architecture doc.
- Plans freeze at implementation time. Don't update an implemented plan to match the current code — the architecture doc is where current shape lives.
- Stale architecture content gets deleted, not stub-replaced. A reader picking up 400 lines of fiction internalizes the wrong shape before realizing it's outdated.
- Cross-reference related docs whenever a plan or architecture decision depends on another.
