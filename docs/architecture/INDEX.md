# Architecture Index

## Current Source Of Truth

- [001-backend-architecture.md](001-backend-architecture.md)
  Current backend architecture for Overwatch, including harness seam, provider seam, route surface, and frontend integration constraints.

- [002-product-vision.md](002-product-vision.md)
  Product direction: voice orchestration layer between coding agents and mobile devices. Covers harness swap to pi-coding-agent, iOS app direction, and distribution goals.

- [003-gateway-service.md](003-gateway-service.md)
  Gateway service running between phone, relay, and local backend.

- [004-harness-pluggability.md](004-harness-pluggability.md)
  `OrchestratorHarness` interface, capabilities table, three providers (`pi-coding-agent`, `claude-code-cli`, `hermes`), and the reasoning-vs-TTS isolation invariant.

- [005-hermes-bridge.md](005-hermes-bridge.md)
  Hermes Agent (Nous Research) integration: `HermesAgentHarness`, jobs/skills/sessions bridges, voice + skill bootstrap, and the monitor REST shim.

- [006-overwatch-hermes-plugin.md](006-overwatch-hermes-plugin.md)
  Retired Python plugin placeholder. Overwatch no longer publishes custom Hermes tmux tools; Hermes should use normal shell `tmux` access.
