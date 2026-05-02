# Architecture Index

Read these in order if you're new. Everything here describes the system as it stands today (post-2026-05-02 overhaul). Pre-overhaul docs were deleted; their content is folded into 007/008/009 or into the implemented plans under `../plans/implemented/`.

## Where to start

- **[007 — Post-overhaul architecture](007-post-overhaul-architecture.md)** — the canonical "what is" doc. Topology, components, wire protocol, deploy, invariants. Read this first.
- **[008 — Protocol and codegen](008-protocol-and-codegen.md)** — JSON Schema → TS + Python types. Drift detection. Validation surfaces.
- **[009 — Auth, pairing, and tokens](009-auth-pairing-and-tokens.md)** — pairing-token vs session-token, three-validator chain, pairing flow.

## Reference

- **[002 — Product vision](002-product-vision.md)** — what Overwatch is, why server-side voice, distribution, build sequence.
- **[004 — Harness pluggability](004-harness-pluggability.md)** — `OrchestratorHarness` interface, capability table, three providers, two-tier event union, registry, how to add a new provider.
- **[005 — Hermes bridge](005-hermes-bridge.md)** — Hermes-mode specifics: harness, jobs/skills bridges, webhook delivery, notification feeding.

## Related

- Implemented-plan history: [`../plans/implemented/`](../plans/implemented/).
- Active / proposed plans: [`../plans/`](../plans/).
- Wire-format schemas: [`../../protocol/schema/`](../../protocol/schema/) and [`../../protocol/README.md`](../../protocol/README.md).
- Codebase entrypoints: [`../../AGENTS.md`](../../AGENTS.md).
