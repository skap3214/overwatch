# Architecture Index

## Current Source Of Truth

> **Note (May 2026):** the documents in this directory describe the
> pre-overhaul architecture, where the voice loop ran in-Mac. The voice +
> harness-bridge overhaul (see
> [`docs/plans/voice-harness-bridge-overhaul-2026-05-01.md`](../plans/voice-harness-bridge-overhaul-2026-05-01.md))
> moved STT, TTS, VAD, smart-turn, and the inference gate into a
> Pipecat Cloud Python orchestrator; the Mac now runs only the
> session-host daemon. The harness seam, provider registry, and Hermes
> bridge invariants below remain accurate; everything voice-loop-shaped
> in 001 and 003 has been superseded.

- [001-backend-architecture.md](001-backend-architecture.md) *(partially superseded)*
  Backend architecture — harness seam, provider seam, route surface. The
  in-Mac voice loop sections are historical; the post-overhaul daemon owns
  only tmux + harness fleet + local REST.

- [002-product-vision.md](002-product-vision.md)
  Product direction: voice orchestration layer between coding agents and
  mobile devices. Still current.

- [003-gateway-service.md](003-gateway-service.md) *(partially superseded)*
  Gateway service description. The pairing + relay surface is current; the
  voice/RealtimeBridge sections are historical.

- [004-harness-pluggability.md](004-harness-pluggability.md)
  `OrchestratorHarness` interface, capabilities table, three providers
  (`pi-coding-agent`, `claude-code-cli`, `hermes`). Still current.

- [005-hermes-bridge.md](005-hermes-bridge.md)
  Hermes Agent (Nous Research) integration. Still current.

- [006-overwatch-hermes-plugin.md](006-overwatch-hermes-plugin.md)
  Retired Python plugin placeholder. Overwatch no longer publishes custom
  Hermes tmux tools; Hermes should use normal shell `tmux` access.
