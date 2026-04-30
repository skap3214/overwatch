# 006 — Overwatch Hermes Plugin

**Status:** Retired (2026-04-30)
**Related:** [005-hermes-bridge.md](005-hermes-bridge.md), [../plans/hermes-gateway-plan-2026-04-22.md](../plans/hermes-gateway-plan-2026-04-22.md)

## Overview

Overwatch no longer publishes custom Hermes tmux tools. Hermes agents should use
their normal shell access to call `tmux` directly when they need to inspect or
control sessions.

The Hermes harness remains implemented in Overwatch. `HARNESS_PROVIDER=hermes`
still routes voice turns, scheduling, memory, and skills through a local Hermes
gateway as documented in [005-hermes-bridge.md](005-hermes-bridge.md). Only the
separate Python plugin tool surface was removed.

## Layout

`cli/hermes-plugin/` remains as a compatibility placeholder so existing symlinks
do not crash Hermes plugin discovery:

```
cli/hermes-plugin/
├── plugin.yaml          # manifest with provides_tools: []
└── __init__.py          # register(ctx) no-op
```

`overwatch setup --agent hermes` does not install or enable this plugin anymore.
It removes the legacy `~/.hermes/plugins/overwatch` entry and cleans
`overwatch` / `OVERWATCH_API_BASE` from Hermes plugin configuration.

## Configuration

`overwatch setup --agent hermes` and `overwatch agent set hermes` only read
Hermes API settings from `~/.hermes/config.yaml` and write the harness settings
to `~/.overwatch/config.json`.

Existing local Hermes configs may still include `overwatch` in
`plugins.enabled` until the user reruns Overwatch setup or switches the active
agent to Hermes again; with the updated placeholder plugin this exposes no tools.

## Files

| Concern | File |
|---|---|
| Compatibility plugin manifest | `cli/hermes-plugin/plugin.yaml` |
| No-op `register(ctx)` | `cli/hermes-plugin/__init__.py` |
| CLI setup/status | `packages/cli/src/hermes-config.ts`, `packages/cli/src/commands/setup.ts`, `packages/cli/src/commands/agent.ts` |
