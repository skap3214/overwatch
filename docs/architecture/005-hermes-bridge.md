# 005 — Hermes Bridge

**Status:** Implemented (Hermes provider, jobs/skills bridges, webhook are live in the daemon; tmux plugin tools were retired — Hermes agents use normal shell `tmux` access)
**Related:** [004-harness-pluggability.md](004-harness-pluggability.md), [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md), [../plans/implemented/hermes-gateway-plan-2026-04-22.md](../plans/implemented/hermes-gateway-plan-2026-04-22.md)
**Reference:** [Hermes Agent (Nous Research)](https://github.com/NousResearch/hermes-agent)

## Overview

When `HARNESS_PROVIDER=hermes`, the Overwatch backend routes everything — turns, scheduling, memory, reasoning — through a locally-running Hermes Agent gateway. Hermes-native concepts (jobs, skills, sessions) are surfaced through the existing mobile UI (monitors, notifications, etc.) by translating between Hermes shapes and Overwatch shapes.

## What the user's Hermes provides

| | Overwatch (default) | Hermes |
|---|---|---|
| LLM brain | `pi-coding-agent` | Whatever Hermes is configured for (gpt-5.5, Anthropic, Ollama, …) |
| Cron | (Local cron retired in the 2026-05-02 overhaul; orchestrator's `IdleReportProcessor` covers idle nudges, harness adapters surface their own scheduling.) | Hermes `/api/jobs` |
| Memory | `~/.overwatch/memory` | `~/.hermes/state.db` + Hermes session memory |
| Personality | None / per-prompt | `~/.hermes/config.yaml` `personalities.*` |
| Skills | None | `~/.hermes/skills/` filesystem tree |

In Hermes mode, Overwatch's local scheduler is intentionally disabled — the user creates jobs through Hermes (via Overwatch voice → Hermes's `cronjob` tool, or via `hermes` CLI / dashboard / Discord, etc.) and Overwatch is a read-side display.

## The harness — `HermesAgentHarness`

`packages/session-host-daemon/src/harness/hermes-agent.ts` implements `OrchestratorHarness` against Hermes's HTTP API server (`http://127.0.0.1:8642` by default).

### Wire flow

1. `POST /v1/runs` with `{input, session_id}` → returns `{run_id}` in HTTP 202.
2. `GET /v1/runs/{run_id}/events` → SSE stream until `run.completed` or `run.failed`.
3. Each Hermes event is translated by `packages/session-host-daemon/src/harness/hermes-events.ts:mapHermesEvent` to an `AdapterEvent` (Tier 1 wire shape — see [004](004-harness-pluggability.md)):
   - `tool.started` → `tool_lifecycle{phase:"start"}`
   - `tool.completed` → `tool_lifecycle{phase:"complete"}`
   - `reasoning.available` → `reasoning_delta` (registry routes to `inject`, never speaks)
   - `message.delta` → `text_delta` (routes to `speak`)
   - `run.completed` → `session_end{subtype:"success"}`
   - `run.failed` → `error` then `session_end{subtype:"error"}`
   - Anything else Hermes-specific (e.g. `hermes/run_completed`) surfaces as `provider_event{provider:"hermes",kind}` so the orchestrator's `HARNESS_EVENT_CONFIGS` decides routing.

### Voice convention

The user's `~/.hermes/SOUL.md` declares a `<voice>` tag convention: input wrapped in `<voice>...</voice>` instructs the agent to respond in speakable form (no markdown, terse, conversational). Hermes itself doesn't parse the tag — it's purely prompt engineering taught to the model via SOUL.md.

`HermesAgentHarness` wraps the user transcript as `<voice>{transcript}</voice>` when `isVoice: true`. We do NOT add a redundant "be concise" instructions prefix — that would conflict with SOUL.md.

### Skill bootstrap

The `overwatch` skill at `~/.hermes/skills/overwatch/SKILL.md` tells Hermes "you're acting as a tmux orchestrator agent for Overwatch":

- **Auto-installed/updated on daemon boot** (`packages/session-host-daemon/src/harness/skill-installer.ts`). The bundled source-of-truth lives in the Overwatch repo at `.agents/skills/overwatch/SKILL.md` — the same format consumed by the [`npx skills@latest`](https://github.com/vercel-labs/skills) CLI, so other agents can install it standalone too. On boot in Hermes mode, the bundled file is compared against the installed file by SHA-256 hash; if different, the user's file is backed up to `SKILL.md.backup` before overwriting.
- **Activated client-side on the first turn of each session.** Hermes's api_server adapter does not auto-activate skills based on platform (it's missing the upstream `set_session_vars` call), so we prepend a synthetic activation message that mimics what `agent/skill_commands.py:build_skill_invocation_message` produces. Subsequent turns in the same session send the bare user input — Hermes session continuity carries the context.

### Setup-installed skill for other agents

The Overwatch repo publishes its skill in the `npx skills@latest` format. `overwatch setup` installs `.agents/skills/overwatch` globally for detected supported agents by running the skills CLI under the hood. The same command can be run directly if setup cannot reach npm:

```bash
npx skills@latest add skap3214/overwatch/.agents/skills/overwatch --global --all --copy
```

The skill uses minimal `name` + `description` frontmatter so it works across every agent's skill loader (Claude Code, Cursor, OpenCode, Codex, Hermes, etc.).

## Cron — `HermesJobsBridge`

`packages/session-host-daemon/src/scheduler/hermes-jobs-bridge.ts` polls `GET /api/jobs?include_disabled=true` every 5s and translates each Hermes job to a `ScheduledMonitor`:

| Hermes job field | `ScheduledMonitor` field |
|---|---|
| `id`, `name` | `id`, `title` |
| `schedule_display` | `scheduleLabel` |
| `next_run_at`, `last_run_at` | `nextRunAt`, `lastFiredAt` |
| `enabled`, `state`, `last_status`, `last_error` | new fields with same names (camelCase) |
| `paused_at` (truthy) | `paused: true` |
| `repeat` | `repeat` |

A poll-tick callback (`onJobFired`) detects `last_run_at` advances and creates a `NotificationEvent` of kind `scheduled_task_result` (or `scheduled_task_error`), summarizing the run output read from `~/.hermes/cron/output/{job_id}/{timestamp}.md`. The daemon's `AdapterProtocolServer` subscribes to `notificationStore` and forwards new notifications to the orchestrator as `provider_event(overwatch/notification)`, which `HARNESS_EVENT_CONFIGS` routes to `speak`.

### REST shim

`packages/session-host-daemon/src/routes/monitors.ts` exposes `/api/v1/monitors/*` endpoints that proxy to Hermes `/api/jobs`. Mobile uses these for create/edit/pause/resume/run/delete and for run history. In local mode the same shim talks to `LocalMonitorSource`. Mobile is mode-agnostic.

### Webhook delivery (push, opt-in)

`packages/session-host-daemon/src/scheduler/hermes-webhook.ts` mounts at `POST /api/v1/hermes/webhook`. Hermes jobs configured with `deliver: "webhook"` push results to it; payloads become `NotificationEvent`s immediately (vs. up-to-5s polling latency).

## Skills surface — `HermesSkillsBridge`

`packages/session-host-daemon/src/scheduler/hermes-skills-bridge.ts` walks `~/.hermes/skills/` every 60s and emits a `skill.snapshot` envelope (`{name, description, category, enabled, version}` per skill). Mobile renders a "Hermes • N skills" pill in the header that opens a read-only modal listing skills grouped by category. Editing/installing skills is left to `hermes` CLI / dashboard.

## Sessions

Hermes sessions and Overwatch device-sessions are different concepts. We use a stable `X-Hermes-Session-Id` per Overwatch session to keep them aligned:

```typescript
const hermesSessionId = `overwatch-${hostname}`;
```

`hermes sessions list` then groups Overwatch turns logically; Hermes memory accumulates across turns; fresh device session = fresh Hermes session.

## Network & auth

Default: Hermes binds `127.0.0.1:8642` (loopback). Bearer auth via `API_SERVER_KEY` from `~/.hermes/config.yaml`. The Overwatch backend reads this via:

```bash
HARNESS_PROVIDER=hermes
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=halo-voice-local
```

`overwatch setup --agent hermes` and `overwatch agent set hermes` read the key from `~/.hermes/config.yaml` (path `platforms.api_server.extra.key`) and write both env vars into `~/.overwatch/config.json`.

For multi-machine setups (Hermes on workstation, Overwatch on laptop), point `HERMES_BASE_URL` off-box. Tailscale + bearer auth handles it.

## Files

| Concern | File |
|---|---|
| Harness | `packages/session-host-daemon/src/harness/hermes-agent.ts` |
| SSE parser + event mapper | `packages/session-host-daemon/src/harness/hermes-events.ts` |
| Voice + skill prompt helpers | `packages/session-host-daemon/src/harness/hermes-prompt.ts` |
| Skill auto-installer | `packages/session-host-daemon/src/harness/skill-installer.ts` |
| Bundled skill (npx skills@latest format) | `.agents/skills/overwatch/SKILL.md` |
| Jobs bridge | `packages/session-host-daemon/src/scheduler/hermes-jobs-bridge.ts` |
| Run history walker | `packages/session-host-daemon/src/scheduler/hermes-job-runs.ts` |
| Skills bridge | `packages/session-host-daemon/src/scheduler/hermes-skills-bridge.ts` |
| Webhook receiver | `packages/session-host-daemon/src/scheduler/hermes-webhook.ts` |
| Monitor REST shim | `packages/session-host-daemon/src/routes/monitors.ts` |
| Monitor source abstraction | `packages/session-host-daemon/src/scheduler/monitor-source.ts` |
| CLI agent setup | `packages/cli/src/hermes-config.ts`, `packages/cli/src/commands/setup.ts`, `packages/cli/src/commands/agent.ts` |
| Notification store (feeder of `provider_event(overwatch/notification)`) | `packages/session-host-daemon/src/notifications/store.ts` |
