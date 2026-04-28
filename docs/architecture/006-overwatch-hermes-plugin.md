# 006 — Overwatch ↔ Hermes Plugin

**Status:** Implemented (2026-04-22)
**Related:** [005-hermes-bridge.md](005-hermes-bridge.md), [../plans/hermes-gateway-plan-2026-04-22.md](../plans/hermes-gateway-plan-2026-04-22.md)

## Overview

Overwatch publishes its tmux orchestration as a Hermes plugin so the user's Hermes agent can drive Overwatch's tmux from any Hermes entrypoint — CLI, dashboard, Discord, Slack, etc. — not just from Overwatch itself. This is independent of `HARNESS_PROVIDER`: even users on the default `pi-coding-agent` harness benefit, because their Hermes (running separately) can drive their tmux through Overwatch.

## Why a plugin, not a "toolset"

Hermes "toolsets" are logical groupings inside `hermes-agent/toolsets.py` — there's no on-disk toolset directory. Tools are Python modules that self-register at import time via `registry.register(...)`. Third parties extend Hermes via:

- **Plugins** at `~/.hermes/plugins/<name>/` — Python modules with a `register(ctx)` function. Idiomatic; this is what the user's existing `halo_runtime` plugin uses.
- **MCP servers** declared in `~/.hermes/config.yaml` — auto-discovered, tool names get an `mcp_<server>_` prefix.

We ship a Python plugin as the primary integration. (An MCP server in TypeScript for non-Hermes consumers is a separate follow-up.)

## Layout

The plugin source-of-truth lives in the Overwatch repo at `cli/hermes-plugin/`:

```
cli/hermes-plugin/
├── plugin.yaml          # manifest
├── __init__.py          # register(ctx) — calls ctx.register_tool() for each tool
├── schemas.py           # JSON Schemas
└── tools.py             # httpx handlers → /api/v1/tmux/*
```

`overwatch setup --agent hermes` symlinks `~/.hermes/plugins/overwatch/` → `<repo>/cli/hermes-plugin/`. Hermes follows symlinks. Updates land automatically when the Overwatch repo is updated.

## Tools

Six tools registered under the `overwatch` toolset:

| Tool | Backend endpoint |
|---|---|
| `tmux_list_sessions` | `GET /api/v1/tmux/sessions` |
| `tmux_list_panes` | `GET /api/v1/tmux/sessions/:name/panes` |
| `tmux_send_keys` | `POST /api/v1/tmux/send-keys` |
| `tmux_read_pane` | `GET /api/v1/tmux/sessions/:name/panes/:pane/read` |
| `tmux_create_session` | `POST /api/v1/tmux/sessions` |
| `tmux_kill_pane` | `DELETE /api/v1/tmux/sessions/:name/panes/:pane` |

The `check_fn=_has_overwatch_target` gates whether tools are offered to the agent based on the `OVERWATCH_API_BASE` env var. If the var is unset, the tools simply don't appear.

`tmux_send_keys` accepts `literal: true` and `submit: true` for the Codex/Cursor pattern (literal text + separate Enter).

## Backend HTTP endpoints

The Overwatch backend exposes `/api/v1/tmux/*` (`src/routes/tmux.ts`) that shells out via `execFile("tmux", ...)` from `src/tmux/cli.ts`. Loopback-only by default. If `OVERWATCH_API_TOKEN` is set on the backend, all tmux endpoints require `Authorization: Bearer <token>`.

## Configuration

`overwatch setup --agent hermes` performs:

1. **Symlink** `~/.hermes/plugins/overwatch/` → `<repo>/cli/hermes-plugin/`.
2. **Append `- overwatch` to `plugins.enabled`** in `~/.hermes/config.yaml` (with backup at `.bak`).
3. **Set `OVERWATCH_API_BASE=http://127.0.0.1:<port>`** in `~/.hermes/.env` (idempotent merge).
4. Prompts the user to restart the Hermes gateway (`hermes restart`) when needed.

`overwatch agent status` reports whether the plugin is installed and enabled when Hermes is the active agent. There is no separate public Hermes command group.

## Smoke test

After install + `hermes restart`:

```bash
hermes plugins list                    # overwatch should be enabled
hermes tools                           # six tmux_* tools listed under overwatch toolset
```

Then ask Hermes (via any entrypoint): "list my tmux sessions" → it calls `tmux_list_sessions` → POSTs to Overwatch backend → returns the live list.

## Security notes

- Backend is loopback-only by default; bearer auth is opt-in via `OVERWATCH_API_TOKEN`.
- `tmux_send_keys` is a powerful tool. The current backend has no allowlist of session names — any tmux session on the user's machine can be targeted. **Open question 1 in the plan**: future enhancement is to restrict to Overwatch-tracked sessions.
- The plugin runs in the Hermes Python process; if the Overwatch backend is down, tools return `Overwatch HTTP error: ConnectionRefused` rather than hanging.

## Files

| Concern | File |
|---|---|
| Plugin manifest | `cli/hermes-plugin/plugin.yaml` |
| `register(ctx)` | `cli/hermes-plugin/__init__.py` |
| Tool schemas | `cli/hermes-plugin/schemas.py` |
| Tool handlers | `cli/hermes-plugin/tools.py` |
| Backend routes | `src/routes/tmux.ts` |
| Backend tmux wrapper | `src/tmux/cli.ts` |
| CLI setup/status | `packages/cli/src/hermes-config.ts`, `packages/cli/src/commands/setup.ts`, `packages/cli/src/commands/agent.ts` |
