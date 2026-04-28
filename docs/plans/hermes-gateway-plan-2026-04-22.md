# Plan: Hermes Gateway Integration

**Date:** 2026-04-22
**Status:** Proposed
**Related Docs:** [../architecture/001-backend-architecture.md](../architecture/001-backend-architecture.md), [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [cli-and-relay-plan-2026-04-09.md](cli-and-relay-plan-2026-04-09.md), [react-native-app-plan-2026-04-08.md](react-native-app-plan-2026-04-08.md)
**Reference:** [Hermes Agent (Nous Research)](https://github.com/NousResearch/hermes-agent), [API Server docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

## Outcome

A user with the [Hermes Agent](https://github.com/NousResearch/hermes-agent) running locally can flip a single switch to make Overwatch route everything — turns, scheduling, memory, reasoning — through their Hermes gateway. Their Hermes session, toolsets, skills, cron jobs, and personality become the brain behind the Overwatch voice loop and tmux orchestrator. The mobile UI surfaces Hermes-native concepts (jobs, skills, run history, agent reasoning) using the existing monitor and notification panels plus a small set of new components. **The integration is bidirectional**: Overwatch also publishes its tmux orchestration as a Hermes plugin, so the user's Hermes agent can drive Overwatch tmux from any Hermes entrypoint (CLI, dashboard, Discord, Slack, etc.) — not just from Overwatch itself. This is the first non-default harness, and it lays the foundation for **harness pluggability** as a long-term direction.

## Why

Hermes is a daemon-style local agent: a single supervisor process that hosts platform adapters for Discord, Slack, Telegram, etc., **and an OpenAI-compatible HTTP API server** with native cron jobs, skills, sessions, and memory. Many users — including the maintainer — already have Hermes installed and supervised. Today Overwatch ships its own harness based on `pi-coding-agent`, plus its own scheduler, plus its own memory directory. A user with Hermes ends up with two separate agents on the same machine, each with their own state.

By exposing Hermes as a harness option:

1. **Setup collapses.** Users who already configured Hermes get an Overwatch backend with zero new credentials, zero new toolsets, zero new memory. Just `HARNESS_PROVIDER=hermes`.
2. **Hermes keeps learning.** Every Overwatch turn flows into the user's existing Hermes session, contributing to its memory and skill usage. Overwatch becomes a voice-and-tmux frontend on top of an agent the user has already invested in.
3. **Bidirectional plumbing.** Publishing Overwatch's tmux tools as a Hermes plugin means the user's Hermes — wherever they invoke it from — can drive their Mac's tmux through Overwatch's existing orchestration. Two products become one cohesive surface.
4. **Pluggable harnesses become a real direction**, not a hypothetical. Once Hermes is wired in alongside `pi-coding-agent` and `claude-code-cli`, the `OrchestratorHarness` interface graduates from internal abstraction to a published extension point.
5. **Reuse, don't duplicate.** Hermes already has cron, skills, sessions, memory, and platform delivery. Overwatch surfaces those rather than running parallel implementations.

## Background — what is Hermes

### Identification (verified)

The "Hermes" the user has installed is **Hermes Agent by Nous Research** ([repo](https://github.com/NousResearch/hermes-agent), MIT). Confirmed by inspecting the live install:

- Install root: `~/.hermes/hermes-agent/`
- Daemon: `~/.hermes/gateway.pid` running `hermes gateway run --replace`
- Config: `~/.hermes/config.yaml` declares `api_server.enabled: true`, `host: 127.0.0.1`, `port: 8642`, `key: halo-voice-local`
- Live: `GET /health` → `{"status":"ok","platform":"hermes-agent"}`, `GET /v1/models` → `[{"id":"hermes-agent",...}]`, `POST /v1/runs` returns a `run_id` in HTTP 202

### Two senses of "gateway"

1. **The Hermes gateway process** — the long-lived daemon supervising platform adapters. State persists in `~/.hermes/gateway_state.json` and SQLite stores in `~/.hermes/`.
2. **The "API Server" platform adapter** inside that gateway — OpenAI-compatible HTTP server that bypasses messaging platforms. **This is what "directly connect to their API" means.**

### Wire protocol summary

| | |
|---|---|
| Transport | Plain HTTP (aiohttp), loopback by default |
| Default bind | `127.0.0.1:8642` (env: `API_SERVER_HOST`, `API_SERVER_PORT`) |
| Auth | `Authorization: Bearer <API_SERVER_KEY>` |
| Streaming | SSE (`text/event-stream`), 30s keepalive, client disconnect interrupts the run |
| Body cap | 1 MB |
| Idempotency | Optional `Idempotency-Key`, 5-min cache |
| Sessions | Optional `X-Hermes-Session-Id` per request, persisted into `~/.hermes/state.db` |

### Endpoint catalog (live-verified, all gated by bearer except `/health`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` / `/v1/health` | Liveness |
| `GET` | `/health/detailed` | Gateway state + connected platforms + PID |
| `GET` | `/v1/models` | Lists `hermes-agent` |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses, server-side state |
| `POST` | **`/v1/runs`** | **Fire-and-forget agent run, returns `run_id` (202)** |
| `GET` | **`/v1/runs/{id}/events`** | **SSE of `tool.started`, `message.delta`, `reasoning.available`, `run.completed`, `run.failed`** |
| `GET` / `POST` | `/api/jobs` | List / create cron jobs |
| `GET` / `PATCH` / `DELETE` | `/api/jobs/{id}` | Read / update / delete |
| `POST` | `/api/jobs/{id}/pause` `…/resume` `…/run` | Lifecycle |

### What the api_server does NOT expose

- No sessions endpoint (sessions live in `~/.hermes/state.db`, readable directly)
- No skills endpoint (skills live as files at `~/.hermes/skills/<category>/<name>/SKILL.md`)
- No tools/toolsets endpoint (toolsets are Python source-level groupings; see Part 7)
- No global event stream (no websocket/SSE for "all things")
- No run history endpoint (cron outputs at `~/.hermes/cron/output/{job_id}/{timestamp}.md`)

The integration accommodates these via HTTP polling, direct sqlite reads, and Hermes's webhook adapter for push.

## Architecture decision

| | **Option A — Hermes as a harness provider** ★ | **Option B — Mobile-direct** |
|---|---|---|
| Where the swap happens | Inside backend's `OrchestratorHarness` | Inside mobile app's `RealtimeClient` |
| Backend running? | Yes (unchanged) | No |
| Mobile app changes | New UI surfaces (monitors, reasoning, skills) | Significant rewrite of connection layer |
| Notifications, monitors, sessions | ✅ Bridge to Hermes-native equivalents | ❌ Lost |
| Server-side STT/TTS | ✅ Works | ❌ Must move to client |
| Tmux pane control | ✅ Works | ❌ Lost |
| Network reachability | Local loopback (Mac talks to Mac) | Phone must reach Mac's `:8642` |
| Implementation effort | ~1-2 weeks (with bridge + UI) | ~1 week + the same bridge work |

**Decision: ship Option A.** It's what "use Hermes instead of our agent" most cleanly means — the LLM brain becomes Hermes, the rest of the Overwatch stack stays. Option B is documented at the bottom as future work; it has no advantages over Option A for the core use case.

## Architecture — Part 1: Harness layer

### The harness boundary already exists

`src/harness/types.ts` defines a one-method interface:

```typescript
export interface OrchestratorHarness {
  runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent>;
}

export interface HarnessTurnRequest {
  prompt: string;
  cwd?: string;
  abortSignal?: AbortSignal;
}
```

Two implementations already plug into it: `src/harness/pi-coding-agent.ts` (default) and `src/harness/claude-code-cli.ts`. Adding a third (`src/harness/hermes-agent.ts`) is the entire harness-side change.

### `HermesAgentHarness` shape

```typescript
// src/harness/hermes-agent.ts
import type { HarnessEvent } from "../shared/events.js";
import type { OrchestratorHarness, HarnessTurnRequest } from "./types.js";
import { wrapVoiceTurn, prependSkillActivation } from "./hermes-prompt.js";

export interface HermesAgentHarnessOptions {
  baseURL: string;            // http://127.0.0.1:8642
  apiKey: string;             // API_SERVER_KEY from ~/.hermes/config.yaml
  sessionId: string;          // X-Hermes-Session-Id, stable per device-session
  skillName?: string;         // "overwatch" — activated on first turn of each session
  isVoice: boolean;           // wrap input as <voice>…</voice>
}

export class HermesAgentHarness implements OrchestratorHarness {
  private skillActivated = new Set<string>();

  constructor(private readonly opts: HermesAgentHarnessOptions) {}

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent> {
    const input = this.buildInput(request.prompt);
    const { run_id } = await this.startRun(input, request.abortSignal);
    yield* this.streamRun(run_id, request.abortSignal);
  }

  private buildInput(prompt: string): string {
    let input = this.opts.isVoice ? wrapVoiceTurn(prompt) : prompt;
    if (this.opts.skillName && !this.skillActivated.has(this.opts.sessionId)) {
      input = prependSkillActivation(this.opts.skillName, input);
      this.skillActivated.add(this.opts.sessionId);
    }
    return input;
  }
  // startRun: POST /v1/runs
  // streamRun: GET /v1/runs/{id}/events, SSE → mapHermesEvent → yield
}
```

### Voice tag wrapping (the SOUL.md convention)

The user's `~/.hermes/SOUL.md` already declares:

```markdown
- `<voice>`: The user is speaking through a voice interface. Your response will be read aloud via TTS.
  Keep responses concise and conversational. Avoid markdown, code fences, and symbol-heavy output.
```

Hermes does **not** itself parse or strip `<voice>` tags — it's a prompt-engineering convention SOUL.md teaches the model. The implication is precise:

- **Overwatch wraps the user transcript as `<voice>{transcript}</voice>` in the `input` field.** That's it. The agent sees the tag, follows SOUL.md, replies in speakable form.
- **Overwatch does NOT add a "be concise" instructions prefix.** Would conflict with SOUL.md and bloat every prompt.
- **Overwatch does NOT need to strip voice tags from output.** Live-verified — the tag exists only in the user-side prompt convention.
- **Bonus**: if Hermes's response includes a `[[audio_as_voice]]` token followed by `MEDIA:<path>` lines (a separate adapter convention for delivering audio attachments via Telegram/Discord), strip those before display. They shouldn't appear in api_server output, but defensive cleanup is cheap.

### Skill bootstrap

Per-turn `instructions` was rejected in favor of a Hermes-native skill at `~/.hermes/skills/overwatch/SKILL.md`. The skill is editable by the user, accumulates learning across sessions, shows up in Hermes's own dashboard, and can be invoked from any Hermes entrypoint — not just Overwatch.

#### Auto-update on backend boot — settled

Each time the Overwatch backend starts in Hermes mode (or `overwatch setup --agent hermes` is run), the bundled skill at `.agents/skills/overwatch/SKILL.md` is checked against the installed version at `~/.hermes/skills/overwatch/SKILL.md`:

```typescript
// src/harness/skill-installer.ts
export async function syncOverwatchSkill(opts: { force?: boolean } = {}): Promise<SyncResult> {
  const bundled = path.join(REPO_ROOT, "cli", "skills", "overwatch", "SKILL.md");
  const installedDir = path.join(os.homedir(), ".hermes", "skills", "overwatch");
  const installed = path.join(installedDir, "SKILL.md");

  const bundledVersion = readFrontmatterVersion(bundled);
  const installedVersion = (await fileExists(installed)) ? readFrontmatterVersion(installed) : null;

  if (installedVersion === bundledVersion && !opts.force) return { action: "skipped" };

  await fs.mkdir(installedDir, { recursive: true });

  if (installedVersion) {
    // Back up user edits before overwriting
    await fs.copyFile(installed, path.join(installedDir, "SKILL.md.backup"));
  }
  await fs.copyFile(bundled, installed);
  return { action: installedVersion ? "updated" : "installed", from: installedVersion, to: bundledVersion };
}
```

Behavior:
- If `~/.hermes/skills/overwatch/SKILL.md` is missing → install.
- If the bundled version differs from the installed one → back up to `SKILL.md.backup`, then write the new version.
- If versions match → skip.
- A user who hand-edited their SKILL.md will see their edits preserved in `SKILL.md.backup` after an upgrade. They can diff and merge if they want their customizations back.
- Logged at boot: `[hermes] skill 'overwatch' synced: 1.0.0 → 1.1.0 (backup at SKILL.md.backup)`.

The bundled SKILL.md lives in the Overwatch repo at `.agents/skills/overwatch/SKILL.md`. Format:

```yaml
---
name: overwatch
description: Use when receiving turns from the Overwatch voice + tmux orchestrator. The user is on a phone driving a Mac. Coordinate background work, manage tmux panes, and keep responses speakable.
version: 1.0.0
author: Overwatch
metadata:
  hermes:
    tags: [overwatch, voice, tmux, orchestration]
---
# Overwatch tmux orchestrator
... (body — see Part 1 of the original plan for sample content) ...
```

#### Skill activation

Hermes does not auto-activate skills based on session source — the api_server adapter is missing the `set_session_vars(platform=...)` call that the webhook adapter uses for per-route skill prefill. That's an upstream limitation we work around client-side, on the first turn of each Hermes session, by prepending a synthetic activation message that mimics what `agent/skill_commands.py:build_skill_invocation_message` produces:

```typescript
// src/harness/hermes-prompt.ts
export function prependSkillActivation(skillName: string, userInput: string): string {
  return [
    `[SYSTEM: The "${skillName}" skill is active for this Overwatch session. Follow its instructions.]`,
    "",
    `[Skill directory: ~/.hermes/skills/${skillName}]`,
    "",
    `The user has provided the following instruction:`,
    userInput,
  ].join("\n");
}
```

Activation is tracked per `sessionId` in memory; subsequent turns send bare input. Process restart resets the flag (extra activation is a no-op since the skill is already in context).

### Event translation (with reasoning rendering)

`mapHermesEvent` in `src/harness/hermes-events.ts`:

| Hermes event | Overwatch `HarnessEvent` | Notes |
|---|---|---|
| `tool.started` | `{ kind: "tool_call", tool, args, label }` | Drives existing tool-pill UX |
| `tool.completed` | (skip in v1) | Optional — extend `HarnessEvent` later if rendered |
| `reasoning.available` | **`{ kind: "reasoning_delta", text }`** | **NEW kind. Rendered in transcript, NOT spoken.** |
| `message.delta` | `{ kind: "text_delta", text }` | Feeds TTS streamer + transcript |
| `run.completed` | (terminate iterable) | Resolves coordinator's harness promise |
| `run.failed` | `throw new Error(error.message)` | Coordinator emits `turn.error` |

#### Reasoning: render but don't speak — settled

Some models (OpenAI o1/o3, Claude Sonnet 4.5 with extended thinking, DeepSeek-R1, GPT-5, etc.) produce internal stream-of-consciousness "thinking" before their final answer. Hermes streams this as `reasoning.available` events distinct from `message.delta`. The integration:

1. **`HarnessEvent` gets a new kind: `reasoning_delta`.** Add to `src/shared/events.ts`.
2. **Coordinator routes by kind in `runForegroundTurn`:**
   - `text_delta` → both TTS adapter and socket-server.
   - `reasoning_delta` → socket-server only. **Never reaches TTS.**
   - `tool_call`, `message` → unchanged (socket only).
3. **New realtime envelope: `turn.reasoning_delta` `{ turnId, text }`.** Add to `src/realtime/protocol.ts`.
4. **Mobile transcript rendering:**
   - During streaming (before any `message.delta` arrives): show a live "thinking…" affordance with the latest reasoning line at the assistant bubble's location, subtly animated.
   - Once `message.delta` events start: collapse the reasoning into a "Show thinking" caret on the assistant bubble; tapping expands the full reasoning text below the assistant message in dim/italic styling.
   - When the turn ends with no `message.delta` (e.g. agent reasoned but didn't reply, or run failed): keep the reasoning visible as a fallback so the user sees what happened.
5. **TTS isolation guarantee.** Add a regression test: send a turn with reasoning content, assert the TTS adapter receives zero bytes from `reasoning_delta` events. This is the core invariant — reasoning must never be read aloud.

### Selection mechanism

`src/config.ts`:

```typescript
export const HARNESS_PROVIDER = process.env.HARNESS_PROVIDER ?? "pi-coding-agent";
export const HERMES_BASE_URL = process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8642";
export const HERMES_API_KEY = process.env.HERMES_API_KEY ?? "";
export const HERMES_SESSION_ID = process.env.HERMES_SESSION_ID ?? `overwatch-${os.hostname()}`;
export const HERMES_SKILL_NAME = process.env.HERMES_SKILL_NAME ?? "overwatch";
```

`src/index.ts` instantiates via `makeHarness(HARNESS_PROVIDER)` from `src/harness/index.ts`. `/health` and `/debug/harness` report the active provider.

## Architecture — Part 2: Cron / monitor bridge

This is where the integration earns its keep — Hermes already has cron, so Overwatch's existing scheduler should yield to it when running in Hermes mode.

### Two scheduling modes

```
local mode (HARNESS_PROVIDER != "hermes"):
  scheduler-runner.ts  →  TurnCoordinator  →  PiCodingAgentHarness
  monitors-store ← monitor.snapshot ← scheduler-runner

hermes mode (HARNESS_PROVIDER = "hermes"):
  Hermes /api/jobs scheduler  →  Hermes runs the job  →  output to ~/.hermes/cron/output/
  monitors-store ← monitor.snapshot ← HermesJobsBridge polling /api/jobs
                                       (Overwatch's local scheduler-runner is disabled)
```

In Hermes mode, the user creates jobs through Hermes (via Overwatch voice — Hermes uses its own `cronjob` tool — or via `hermes` CLI, dashboard, etc.). Overwatch is a read-side bridge plus optional push notifications.

### `HermesJobsBridge`

`src/scheduler/hermes-jobs-bridge.ts`:

1. **Poll `GET /api/jobs?include_disabled=true`** every 5s. Diff against last snapshot.
2. **Translate Hermes job → `ScheduledMonitor`** (extended schema):
   ```typescript
   function hermesJobToMonitor(job: HermesJob): ScheduledMonitor {
     return {
       id: job.id,
       title: job.name,
       scheduleLabel: job.schedule_display,
       nextRunAt: job.next_run_at,
       lastFiredAt: job.last_run_at,
       recurring: job.schedule.kind !== "one_shot",
       enabled: job.enabled,
       state: job.state,                  // "scheduled" | "paused" | "running"
       lastStatus: job.last_status,       // "ok" | "error" | null
       lastError: job.last_error,
       paused: !!job.paused_at,
       repeat: job.repeat,
     };
   }
   ```
3. **Detect transitions** (`last_run_at` advanced → emit notification; `state: running` → live status).
4. **Emit `monitor.snapshot` / `monitor.updated`** through the existing socket-server.
5. **Disable local scheduler** when in Hermes mode. `src/index.ts` skips `scheduler-runner`.

### Mobile-initiated CRUD

The Overwatch backend exposes a thin REST shim that proxies to `/api/jobs`:

```
POST   /api/v1/monitors              → POST /api/jobs
PATCH  /api/v1/monitors/{id}         → PATCH /api/jobs/{id}
DELETE /api/v1/monitors/{id}         → DELETE /api/jobs/{id}
POST   /api/v1/monitors/{id}/pause   → POST /api/jobs/{id}/pause
POST   /api/v1/monitors/{id}/resume  → POST /api/jobs/{id}/resume
POST   /api/v1/monitors/{id}/run     → POST /api/jobs/{id}/run
GET    /api/v1/monitors/{id}/runs    → fs walk ~/.hermes/cron/output/{id}/*.md
```

Same shim works in local mode (proxies to `scheduler-runner`). Mobile calls `/api/v1/monitors/*` regardless of mode.

### Run history

Hermes does not expose run history via HTTP. Outputs are markdown files at `~/.hermes/cron/output/{job_id}/{YYYY-MM-DD_HH-MM-SS}.md`. The bridge walks this directory on demand:

```typescript
export async function listJobRuns(jobId: string): Promise<JobRun[]> {
  const dir = path.join(os.homedir(), ".hermes", "cron", "output", jobId);
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter(f => f.endsWith(".md"))
    .map(f => ({ id: f.replace(".md", ""), jobId, ranAt: parseTimestamp(f), outputPath: path.join(dir, f) }))
    .sort((a, b) => b.ranAt - a.ranAt);
}
```

### Notifications when jobs fire

Two strategies, both supported:

1. **Polling (zero setup, default).** `HermesJobsBridge` already polls; on `last_run_at` advance, emit `notification.created` with kind `scheduled_task_result`, body derived from a summary of the run output. Latency: 0–5s.
2. **Webhook delivery (push, opt-in).** Hermes jobs accept `deliver: "webhook"` with a URL. Backend exposes `/api/v1/hermes/webhook` to receive these. Setup CLI offers to flip the user's existing jobs (or set the default) to webhook delivery. Latency: ~0s.

## Architecture — Part 3: Skills surface

Skills are how Hermes-installed users keep teaching their agent. Overwatch:

1. **Installs the `overwatch` skill** on first run (Part 1).
2. **Surfaces installed skills** in the mobile UI — read-only, status pill.
3. **Doesn't own skill management.** Editing/installing other skills is what `hermes skills` and the Hermes dashboard are for.

### Skill discovery

`src/scheduler/hermes-skills-bridge.ts` walks `~/.hermes/skills/` every 60s and emits `skill.snapshot`:

```typescript
type ActiveSkill = {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
};
```

### Mobile UI

A small "Hermes • N skills" pill in the header (next to the connection status dot). Tap → modal listing skills with descriptions. Read-only. Lets the user verify the `overwatch` skill is installed and active.

## Architecture — Part 4: Sessions

Hermes and Overwatch both have a "session" concept; they're different concepts:

- **Overwatch session** = device conversation thread (`SessionInfo` in `useTurnStore`). User-facing.
- **Hermes session** = agent reasoning trace, persisted in `~/.hermes/state.db`. Backend-facing.

For v1, **don't merge them.** Backend uses a stable `X-Hermes-Session-Id` per Overwatch device-session:

```typescript
const hermesSessionId = `overwatch-${hostname}-${overwatchSessionId}`;
```

This means `hermes sessions list` shows Overwatch conversations grouped logically; Hermes memory accumulates correctly across turns; fresh Overwatch conversation = fresh Hermes session. v2 could add a "view in Hermes dashboard" deep link to `http://127.0.0.1:9119/sessions/{id}` — out of scope.

## Architecture — Part 5: Mobile UI changes

Existing components are mostly sufficient. Specific gaps to fill:

### Existing components — work as-is

- `NotificationsBanner` — receives `notification.created` from bridge, renders unchanged.
- `MonitorsDropdown` — receives `monitor.snapshot` from `HermesJobsBridge`. Schema extended with `enabled`, `state`, `lastStatus`, `paused` — banner adds visual treatment for paused / errored states.
- `TranscriptView` / `useTurnStore` — extended with optional reasoning per assistant message (see `ReasoningBlock` below).
- `SessionsPanel` — unchanged.

### New components

#### 1. `ReasoningBlock` (transcript) — for the new reasoning_delta event

`overwatch-mobile/src/components/ReasoningBlock.tsx`. Two states:

- **Live (streaming, no final message yet).** Pulses subtly, shows latest reasoning line truncated to ~80 chars with leading "thinking…" prefix. Sits where the assistant bubble will land.
- **Collapsed (final message arrived).** Renders as a small caret/disclosure ("▸ Show thinking") on the assistant bubble. Tap → expands a dim italicized block below the assistant message text containing the full accumulated reasoning. Tap again → collapses.

Wires to the `useTurnStore`'s assistant `Message` schema, extended with optional `reasoning?: string`.

#### 2. `MonitorDetailScreen`

Tap a row in `MonitorsDropdown` → push this screen. Shows title, schedule, next run, last run with status badge, prompt, deliver target, skills attached, repeat counter, **run history list** (from `GET /api/v1/monitors/{id}/runs`). Action buttons: Pause/Resume, Run Now, Edit, Delete.

#### 3. `MonitorRunOutputView` (modal)

Reads markdown via `GET /api/v1/monitors/{id}/runs/{runId}`. Renders body. Read-only.

#### 4. `MonitorEditForm`

Create/edit a job. Fields: name, schedule (presets + freeform), prompt, skills (multi-select), deliver (local/webhook/platforms), repeat. Submits to `POST /api/v1/monitors`.

#### 5. `SkillStatusPill` + `SkillsModal`

Header pill + tap-to-list modal. Read-only.

#### 6. `NotificationsHistoryScreen`

Full history with filtering by source / kind / date. Tap a job-result notification → land on `MonitorDetailScreen`.

#### 7. `HarnessProviderPicker` (in `SettingsPage`)

A new "Agent" section in settings. Shows active provider; lets user switch between `pi-coding-agent`, `claude-code-cli`, `hermes` (only listed if Hermes daemon is detected via `~/.hermes/gateway.pid` + `GET :8642/health`). Switching writes `~/.overwatch/config.json` and restarts the backend.

### New stores

- `useSkillsStore` — holds `ActiveSkill[]`, replaces on `skill.snapshot`.
- `useTurnStore` — assistant `Message` gains optional `reasoning?: string`; new envelope handler `turn.reasoning_delta` appends to the in-progress assistant message's reasoning field.
- Extend `useNotificationsStore` with filter helpers (`byKind`, `bySource`).

### New envelopes

In `src/realtime/protocol.ts`:

```typescript
| { type: "turn.reasoning_delta"; payload: { turnId: string; text: string } }
| { type: "skill.snapshot"; payload: { skills: ActiveSkill[] } }
| { type: "harness.snapshot"; payload: { provider: string; capabilities: HarnessCapabilities } }
```

## Architecture — Part 6: Pluggable harness foundation

The Hermes integration is the second non-default harness (after `claude-code-cli`), and it sets the pattern for future ones.

### Provider capabilities

```typescript
// src/harness/capabilities.ts
export interface HarnessCapabilities {
  hasNativeCron: boolean;
  hasNativeSkills: boolean;
  hasNativeMemory: boolean;
  hasSessionContinuity: boolean;
  emitsReasoning: boolean;          // for ReasoningBlock visibility
  voiceConvention: "soul-md" | "instructions-prefix" | "none";
}

export const CAPABILITIES: Record<string, HarnessCapabilities> = {
  "pi-coding-agent": {
    hasNativeCron: false, hasNativeSkills: false, hasNativeMemory: true,
    hasSessionContinuity: false, emitsReasoning: false,
    voiceConvention: "instructions-prefix",
  },
  "claude-code-cli": {
    hasNativeCron: false, hasNativeSkills: true, hasNativeMemory: false,
    hasSessionContinuity: true, emitsReasoning: false,
    voiceConvention: "instructions-prefix",
  },
  "hermes": {
    hasNativeCron: true, hasNativeSkills: true, hasNativeMemory: true,
    hasSessionContinuity: true, emitsReasoning: true,
    voiceConvention: "soul-md",
  },
};
```

Backend emits `harness.snapshot` on connection. Mobile uses capabilities to gate UI:
- `SkillStatusPill` rendered only if `hasNativeSkills`.
- `MonitorEditForm`'s skills multi-select shown only if `hasNativeSkills`.
- `ReasoningBlock` reserved space allocated only if `emitsReasoning`.
- Voice prep happens inside the harness, not the mobile app.

### Folder structure

```
src/harness/
  types.ts                 # OrchestratorHarness, HarnessTurnRequest
  capabilities.ts          # CAPABILITIES record
  index.ts                 # makeHarness(provider) factory
  pi-coding-agent.ts       # existing
  claude-code-cli.ts       # existing
  hermes-agent.ts          # NEW
  hermes-prompt.ts         # NEW: wrapVoiceTurn, prependSkillActivation
  hermes-events.ts         # NEW: mapHermesEvent
  skill-installer.ts       # NEW: syncOverwatchSkill (Part 1)
src/scheduler/
  hermes-jobs-bridge.ts    # NEW: poll /api/jobs, emit envelopes
  hermes-job-runs.ts       # NEW: fs walk for run history
  hermes-skills-bridge.ts  # NEW: walk ~/.hermes/skills/
  hermes-webhook.ts        # NEW: /api/v1/hermes/webhook handler
src/routes/
  monitors.ts              # NEW: /api/v1/monitors/* shim
src/tmux/                  # existing tmux orchestration
  http-routes.ts           # NEW (or extend): /api/v1/tmux/* — see Part 7
.agents/skills/overwatch/
  SKILL.md                 # NEW: bundled skill body
cli/hermes-plugin/         # NEW: see Part 7
  plugin.yaml
  __init__.py
  schemas.py
  tools.py
```

## Architecture — Part 7: Publishing Overwatch toolset to Hermes

Overwatch ships a Hermes plugin so the user's Hermes agent can drive Overwatch's tmux orchestration from any Hermes entrypoint — CLI, dashboard, Discord, Slack, even other Overwatch sessions. This works **regardless of which harness Overwatch itself is using** — the plugin is purely additive on the Hermes side.

### Why a plugin, not a "toolset"

Research finding: Hermes "toolsets" are logical groupings inside `/Users/soami/.hermes/hermes-agent/toolsets.py` — there's no on-disk toolset directory. Tools themselves are Python modules that self-register at import time via `registry.register(...)`. Third parties extend Hermes via:

- **Plugins** at `~/.hermes/plugins/<name>/` — Python modules with `register(ctx)` that calls `ctx.register_tool(...)`. **Idiomatic.**
- **MCP servers** declared in `~/.hermes/config.yaml` — auto-discovered, tool names get `mcp_<server>_` prefix. Cross-language friendly.

We ship a Python plugin as the primary integration. (MCP is documented as a follow-up for non-Hermes consumers — Claude Code, Cursor, etc.)

The user already has a `~/.hermes/plugins/halo_runtime/` plugin in this exact shape (currently dormant due to a missing `plugin.yaml`). The Overwatch plugin reuses the same pattern.

### Plugin layout

```
~/.hermes/plugins/overwatch/
├── plugin.yaml          # manifest
├── __init__.py          # register(ctx)
├── schemas.py           # JSON schemas per tool
└── tools.py             # httpx handlers → Overwatch HTTP API
```

The plugin source-of-truth lives in the Overwatch repo at `cli/hermes-plugin/`. `overwatch setup --agent hermes` symlinks `~/.hermes/plugins/overwatch/` → `<repo>/cli/hermes-plugin/`. Hermes follows symlinks. Benefits:
- Plugin code versions with Overwatch.
- Updates land automatically when Overwatch is updated, no manual copy step.
- User can still inspect / read the plugin in `~/.hermes/plugins/overwatch/` like any other plugin.

(For users installing Overwatch via pip later, fall back to copy. Symlink is the dev/repo case.)

### `plugin.yaml`

```yaml
name: overwatch
version: 0.1.0
description: "Drive Overwatch's tmux orchestrator from Hermes — list panes, send keys, read pane output."
author: "Overwatch"
provides_tools:
  - tmux_list_sessions
  - tmux_list_panes
  - tmux_send_keys
  - tmux_read_pane
  - tmux_create_session
  - tmux_kill_pane
provides_hooks: []
```

### `__init__.py`

```python
"""Overwatch tmux orchestrator — Hermes plugin.

Bridges Hermes tool calls to Overwatch's local backend HTTP API.
The toolset is gated by the OVERWATCH_API_BASE env var — when unset,
tools are not offered to the agent.
"""
from __future__ import annotations
import os
from . import schemas, tools

def _has_overwatch_target() -> bool:
    return bool(os.environ.get("OVERWATCH_API_BASE"))

def register(ctx) -> None:
    common = {"toolset": "overwatch", "check_fn": _has_overwatch_target}
    ctx.register_tool(
        name="tmux_list_sessions",
        schema=schemas.TMUX_LIST_SESSIONS,
        handler=tools.tmux_list_sessions,
        description="List all tmux sessions managed by Overwatch.",
        emoji="📋", **common,
    )
    ctx.register_tool(
        name="tmux_list_panes",
        schema=schemas.TMUX_LIST_PANES,
        handler=tools.tmux_list_panes,
        description="List panes in an Overwatch tmux session.",
        emoji="🪟", **common,
    )
    ctx.register_tool(
        name="tmux_send_keys",
        schema=schemas.TMUX_SEND_KEYS,
        handler=tools.tmux_send_keys,
        description="Send keystrokes to an Overwatch tmux pane.",
        emoji="⌨️", **common,
    )
    ctx.register_tool(
        name="tmux_read_pane",
        schema=schemas.TMUX_READ_PANE,
        handler=tools.tmux_read_pane,
        description="Read scrollback content of a tmux pane via Overwatch.",
        emoji="📖", **common,
    )
    ctx.register_tool(
        name="tmux_create_session",
        schema=schemas.TMUX_CREATE_SESSION,
        handler=tools.tmux_create_session,
        description="Create a new Overwatch-managed tmux session.",
        emoji="✨", **common,
    )
    ctx.register_tool(
        name="tmux_kill_pane",
        schema=schemas.TMUX_KILL_PANE,
        handler=tools.tmux_kill_pane,
        description="Terminate an Overwatch tmux pane.",
        emoji="🪓", **common,
    )
```

### `tools.py` (handler shape — one tool shown)

```python
from __future__ import annotations
import json, os
import httpx

def _api_base() -> str:
    return os.environ.get("OVERWATCH_API_BASE", "http://127.0.0.1:8787").rstrip("/")

def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    token = os.environ.get("OVERWATCH_API_TOKEN", "").strip()
    if token: h["Authorization"] = f"Bearer {token}"
    return h

def _ok(data) -> str:  return json.dumps(data, ensure_ascii=False, default=str)
def _err(msg, **e) -> str: return json.dumps({"error": msg, **e}, ensure_ascii=False)

def tmux_send_keys(args: dict, **_) -> str:
    session = (args.get("session") or "").strip()
    keys = args.get("keys") or ""
    if not session or not keys:
        return _err("session and keys are required")
    body = {"session": session, "keys": keys}
    if args.get("pane"): body["pane"] = args["pane"]
    try:
        with httpx.Client(timeout=15.0) as c:
            r = c.post(f"{_api_base()}/api/v1/tmux/send-keys", json=body, headers=_headers())
        if r.status_code >= 400:
            return _err(f"Overwatch API {r.status_code}", body=r.text[:500])
        return _ok(r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)
    except httpx.HTTPError as exc:
        return _err(f"Overwatch HTTP error: {exc}")

# tmux_list_sessions, tmux_list_panes, tmux_read_pane, tmux_create_session, tmux_kill_pane:
# same shape — GET or POST against /api/v1/tmux/* with body validation.
```

### Backend HTTP endpoints

The plugin is only useful if the Overwatch backend exposes the corresponding HTTP endpoints. Audit `src/tmux/`:

```
GET    /api/v1/tmux/sessions                         → list sessions
POST   /api/v1/tmux/sessions                         → create session  (body: { name, command? })
DELETE /api/v1/tmux/sessions/{name}                  → kill session
GET    /api/v1/tmux/sessions/{name}/panes            → list panes
GET    /api/v1/tmux/sessions/{name}/panes/{id}/read  → read scrollback (query: lines=200)
POST   /api/v1/tmux/sessions/{name}/panes/{id}/keys  → send-keys to pane (body: { keys })
DELETE /api/v1/tmux/sessions/{name}/panes/{id}       → kill pane
POST   /api/v1/tmux/send-keys                        → send-keys with session+pane in body (convenience)
```

Some of these may already exist in `src/tmux/` from the existing harness tools. If so, they're reused as-is. If not, expose them. The shape mirrors the existing harness tool surface — calling them is just an HTTP wrapper around what the agent already does internally.

**Auth model.** Overwatch backend is loopback-only (port 8787 on Mac). No auth required by default. The plugin honors `OVERWATCH_API_TOKEN` if set, for future use (e.g. when the backend is reachable over Tailscale). Document: this is a localhost API; if you bind 0.0.0.0, set a token.

**Rate-limit / safety.** `tmux_send_keys` is a powerful tool. Hermes plugins can register `pre_tool_call` hooks to gate tool calls; our plugin doesn't need one (Hermes already has its own confirmation flows for "dangerous" tools), but the Overwatch backend's tmux send-keys endpoint should validate the session name against an allowlist of known Overwatch sessions to avoid drive-by sending to unrelated sessions.

### Configuration changes

The CLI helper writes:

1. **`~/.hermes/.env`** — adds `OVERWATCH_API_BASE=http://127.0.0.1:8787` (and `OVERWATCH_API_TOKEN` if Overwatch has auth enabled).
2. **`~/.hermes/config.yaml`** — adds `overwatch` to `plugins.enabled`:
   ```yaml
   plugins:
     enabled:
       - session-env       # existing
       - overwatch         # added
   ```
   Edit-in-place: read YAML, append, write back, with a `.bak` backup of the prior config.
3. **Symlink** `~/.hermes/plugins/overwatch/` → `<overwatch repo>/cli/hermes-plugin/`.

### Restart requirement

Hermes loads plugins at process boot. Adding/removing the plugin requires restarting the Hermes gateway. The CLI helper runs `hermes restart` (or, fallback, `pkill -f "hermes gateway" && hermes gateway run --replace &`). Document the restart in user-facing output: `→ Restarting Hermes gateway… ✓`.

### Verification steps

After install:

```
hermes plugins list                    # overwatch should be enabled
hermes tools                           # overwatch toolset checked, six tmux_* tools listed
curl -s http://127.0.0.1:8642/v1/models -H "Authorization: Bearer halo-voice-local"
                                       # api_server still up
```

Smoke test from inside Hermes (any entrypoint):

> "List my tmux sessions."

The agent should call `tmux_list_sessions`, which POSTs to Overwatch backend, which returns the live session list. If `OVERWATCH_API_BASE` is unset or the backend is down, the tool either doesn't appear (`check_fn` returns false) or returns `{"error": "Overwatch HTTP error: ConnectionRefused"}` — both are graceful failure modes.

### MCP follow-up (out of scope for v1)

A separate, smaller follow-up: ship Overwatch as an **MCP server** in TypeScript (using the official `@modelcontextprotocol/sdk` Node bindings). This:
- Lets non-Hermes consumers (Claude Code, Cursor, Codex) drive Overwatch's tmux too.
- Hermes can also consume it via `mcp_servers.overwatch:` in `~/.hermes/config.yaml` — though tools end up prefix-namespaced as `mcp_overwatch_*`, which is uglier in the LLM context than the native plugin tools.

For Hermes specifically, the Python plugin is the right primary integration. MCP is the right secondary integration for ecosystem reach. Tracked as future work.

## Build sequence

### Phase 1 — `HermesAgentHarness` + voice + skill bootstrap + reasoning

- Create `src/harness/hermes-agent.ts`, `hermes-prompt.ts`, `hermes-events.ts`, `skill-installer.ts`.
- Implement Runs API client + SSE stream parser (~80 LOC, no new deps).
- Voice-tag wrapping; per-session skill activation.
- **Boot-time `syncOverwatchSkill()`** runs in `src/index.ts` when `HARNESS_PROVIDER=hermes`, with the version-bump+backup logic.
- Add `HARNESS_PROVIDER`, `HERMES_*` env vars and `makeHarness` factory.
- **Extend `HarnessEvent` with `reasoning_delta` kind** (`src/shared/events.ts`).
- **Update `TurnCoordinator` to route `reasoning_delta` to socket-only**, never TTS.
- **Add `turn.reasoning_delta` envelope** in `src/realtime/protocol.ts` and `socket-server.ts`.
- Author `.agents/skills/overwatch/SKILL.md`.
- Update `/health` and `/debug/harness` to be provider-aware.
- **Gate:** `HARNESS_PROVIDER=hermes HERMES_API_KEY=halo-voice-local npm run dev` → connect mobile → speak a turn → response is short (SOUL.md voice rules) → reasoning events flow through socket as `turn.reasoning_delta` → **TTS adapter receives zero bytes from reasoning** (regression test) → skill activation visible only on first turn → boot-time skill sync logs `installed/updated/skipped`.

### Phase 2 — Cron / monitor bridge

- Create `src/scheduler/hermes-jobs-bridge.ts` — poll, diff, emit `monitor.*` envelopes.
- Skip `scheduler-runner.ts` boot in Hermes mode.
- Extend `ScheduledMonitor` with `enabled`, `state`, `lastStatus`, `lastError`, `paused`, `repeat`.
- Update `MonitorsDropdown` for paused/errored visual states.
- **Gate:** create a Hermes job via `hermes cronjob create` → mobile shows it within 5s with correct schedule + next-run. Pause via Hermes CLI → mobile reflects within 5s.

### Phase 3 — Run history + monitor REST shim

- `src/routes/monitors.ts` with the seven endpoints from Part 2.
- `src/scheduler/hermes-job-runs.ts` (fs walker + reader).
- Mobile: `MonitorDetailScreen`, `MonitorRunOutputView`.
- **Gate:** tap a monitor → see detail + run history → tap a run → markdown renders.

### Phase 4 — Monitor create/edit

- Mobile: `MonitorEditForm`, wire to POST/PATCH `/api/v1/monitors`.
- Backend `monitors.ts` validates schedule strings against Hermes formats.
- **Gate:** create a recurring monitor from mobile → appears in `hermes cronjob list` → fires → output appears in detail screen.

### Phase 5 — Notifications: polling + webhook

- Polling: `HermesJobsBridge` already detects `last_run_at` transitions; emit `notification.created` with summarized run output.
- Webhook: `src/scheduler/hermes-webhook.ts` exposes `/api/v1/hermes/webhook`. Setup CLI offers to flip jobs to webhook delivery.
- **Gate:** scheduled job fires → banner notification on phone within 5s (poll) or near-instant (webhook).

### Phase 6 — Skills surface

- `src/scheduler/hermes-skills-bridge.ts` — walk `~/.hermes/skills/`, emit `skill.snapshot`.
- Mobile: `useSkillsStore`, `SkillStatusPill`, `SkillsModal`.
- **Gate:** mobile shows "Hermes • N skills" pill; `overwatch` skill listed in modal.

### Phase 7 — Reasoning UI

- Mobile: extend `useTurnStore` `Message` schema with optional `reasoning?: string`.
- Mobile: handle `turn.reasoning_delta` envelope — append text to current assistant turn's reasoning field.
- Mobile: build `ReasoningBlock` (live + collapsed states).
- Update `TranscriptView` to render `ReasoningBlock` per assistant message.
- **Gate:** send a turn to a reasoning-class model via Hermes → "thinking…" affordance appears during the silent gap → collapses into "Show thinking" once message text starts → tap expands full reasoning trace → **TTS speaks only the final answer, not the reasoning** (regression test).

### Phase 8 — Pluggable harness UI

- `harness.snapshot` envelope on connection.
- `HarnessCapabilities` table; mobile reads it for UI gating.
- Settings: `HarnessProviderPicker`. `POST /api/v1/config/harness {provider}` writes config and triggers restart.
- **Gate:** in settings, switching from `pi-coding-agent` to `hermes` and back works; `SkillStatusPill`, `MonitorEditForm`'s skills field, and `ReasoningBlock` reserved space appear/disappear based on capabilities.

### Phase 9 — Notifications history screen

- Mobile: `NotificationsHistoryScreen`, filter helpers in `useNotificationsStore`.
- Deep link from job-result notification → `MonitorDetailScreen`.
- **Gate:** open history → past job runs listed → tap → land on monitor detail.

### Phase 10 — CLI helpers (Overwatch side)

- `overwatch agent status` — checks active harness; when Hermes is active, reports PID, `/health`, API key, and plugin status.
- `overwatch setup --agent hermes` — writes `HARNESS_PROVIDER=hermes` and `HERMES_API_KEY=...` (read from `~/.hermes/config.yaml`) into `~/.overwatch/config.json` and enables the Overwatch Hermes plugin.
- `overwatch agent set pi-coding-agent` — reverts the active harness.
- **Gate:** `overwatch setup --agent hermes` on a fresh machine flips Overwatch onto Hermes with no manual config editing.

### Phase 11 — Publish Overwatch toolset to Hermes (the bidirectional half)

- Audit `src/tmux/` — confirm/expose the seven HTTP endpoints from Part 7.
- Author `cli/hermes-plugin/{plugin.yaml, __init__.py, schemas.py, tools.py}`.
- Implement six tools: `tmux_list_sessions`, `tmux_list_panes`, `tmux_send_keys`, `tmux_read_pane`, `tmux_create_session`, `tmux_kill_pane`.
- CLI surface:
  - `overwatch setup --agent hermes` symlinks plugin, edits `~/.hermes/config.yaml` (with `.bak`), and writes `OVERWATCH_API_BASE` to `~/.hermes/.env`.
  - `overwatch agent status` reports symlink + config state when Hermes is active.
- Note: this phase is independent of `HARNESS_PROVIDER`. Users who keep Overwatch in `pi-coding-agent` mode can still benefit if the plugin remains installed; the simplified CLI exposes setup through `overwatch setup --agent hermes` instead of a separate Hermes command group.
- **Gate:** ask Hermes via `hermes` CLI: "list my tmux sessions" → it calls `tmux_list_sessions` → returns Overwatch's live session list. Then: "send 'echo hi' to session main" → keys land in the tmux pane, visible in mobile app.

### Phase 12 — Documentation

- `docs/architecture/00X-harness-pluggability.md` — accepted decision, list providers and capabilities.
- `docs/architecture/00Y-hermes-bridge.md` — cron / skills / sessions / reasoning bridge details.
- `docs/architecture/00Z-overwatch-hermes-plugin.md` — bidirectional plugin contract.
- Append to `docs/README.md` and `docs/insights.md`.

## What changes vs. current setup

| | Current | With Hermes integration |
|---|---|---|
| LLM brain | `pi-coding-agent` (Anthropic via OAuth) | Whatever Hermes is configured for (`gpt-5.5`, Anthropic, Ollama, etc.) |
| Tools (Overwatch → agent) | `pi-coding-agent` toolset | `platform_toolsets.api_server` from `~/.hermes/config.yaml` |
| Tools (agent → Overwatch tmux) | Internal harness only | **Native Hermes plugin — works from CLI/dashboard/Discord/Slack** |
| Scheduler | `src/tasks/scheduler-runner.ts` (Overwatch-local) | Hermes `/api/jobs` (bridge polls) |
| Memory | `~/.overwatch/memory` | `~/.hermes/state.db` + Hermes session memory |
| Personality | None / per-prompt | Hermes config (`personalities.*` in `~/.hermes/config.yaml`) |
| Voice formatting | Per-prompt instructions | `<voice>…</voice>` wrapping → SOUL.md handles it |
| Reasoning rendering | Not surfaced | **Rendered in transcript (collapsible), never spoken via TTS** |
| Skill bootstrap | None | `~/.hermes/skills/overwatch/SKILL.md`, **auto-updated on boot with backup** |
| Auth | OAuth file `~/.pi/agent/auth.json` | Bearer token in `~/.hermes/config.yaml` |
| TTS / STT / mobile loop | Unchanged | Unchanged; new screens for monitor detail/edit/history, skill pill, reasoning block |

## Risks

1. **Hermes API stability.** Pre-1.0; event names, schemas, SSE shapes can shift. Mitigation: isolate mappers (`hermes-events.ts`, `hermes-jobs-bridge.ts`); CI smoke test against a stub Hermes server; pin tested commits.
2. **No Hermes job event stream.** All cron observability is poll-based, 0–5s latency. Acceptable; tighten interval if needed.
3. **Skill activation drift.** If Hermes adds api_server-side `set_session_vars`, our client-side activation becomes redundant. Happy outcome — remove the prepend logic.
4. **Filesystem reads for run output.** `~/.hermes/cron/output/{id}/*.md` path could change. Mitigation: integration test that creates a job, runs it, verifies the bridge reads it.
5. **Sessions DB locking.** `state.db` is sqlite WAL; reads are safe but use `PRAGMA query_only=1` and short-lived connections when added (v2).
6. **Two scheduler systems by accident.** If `scheduler-runner` fails to skip-start, jobs fire twice. Mitigation: log active scheduler; assert mutual exclusion in tests.
7. **Local-mode regressions.** Capability gates and the harness factory must not break the default `pi-coding-agent` flow. Mitigation: factory's default branch untouched; CI runs both modes.
8. **Skill loading semantics.** Hermes loads SKILL.md when the agent calls `skill_view`, not at receipt of the activation message. Mitigation: keep skill body short and high-signal so even brief reads change behavior.
9. **Concurrency cap.** Hermes caps at 10 in-flight runs. Coordinator serializes voice turns; surface 429s clearly.
10. **Reasoning leaking to TTS.** Adding `reasoning_delta` to the routing means a coordinator bug could send it to TTS. Mitigation: regression test that asserts TTS receives zero bytes from `reasoning_delta` events. This is the load-bearing invariant.
11. **Plugin restart loops.** Bad plugin code can cause Hermes gateway crash loops. Mitigation: plugin code is small (~150 LOC); CI imports `cli/hermes-plugin/__init__.py` headless to catch syntax errors before symlink.
12. **Plugin and backend version skew.** If Overwatch's HTTP endpoints change but the plugin doesn't, tools break silently. Mitigation: pin plugin version to Overwatch backend version (semver), include version in `plugin.yaml`, log mismatch warnings.
13. **Symlinked plugin directory.** If user moves or deletes Overwatch repo, `~/.hermes/plugins/overwatch/` becomes a dangling symlink → Hermes plugin discovery errors. Mitigation: `overwatch agent status` reports plugin installation state when Hermes is active; rerun `overwatch setup --agent hermes` after moving the repo.

## Open questions

1. **Should Overwatch's tmux endpoints honor an allowlist?** The `tmux_send_keys` plugin tool can target any session. The backend should restrict to known Overwatch-managed sessions (i.e. those `scheduler` or the user explicitly created via Overwatch). Worth deciding before Phase 11. Recommendation: yes — backend keeps a registry of Overwatch-owned session names; reject sends to unknown sessions.
2. **Multi-machine.** A user with Hermes on one Mac (workstation) and Overwatch backend on another (laptop) needs `HERMES_BASE_URL` to point off-box. Bearer auth + Tailscale handles it; document in setup.
3. **Webhook port.** `/api/v1/hermes/webhook` lives on port 8787 (Overwatch backend). Document URL: `http://127.0.0.1:8787/api/v1/hermes/webhook`.
4. **Run output summary heuristic.** When polling detects a fire, we summarize the markdown for the notification body. Recommendation: "first non-empty line, truncated to 240 chars"; iterate based on dogfood.
5. **Mobile-direct mode (Option B).** Punted unless demand emerges.

## Not in scope

- Modifying Hermes itself.
- Discord/Slack/Telegram platform adapters (Hermes already provides them).
- Auto-installing or auto-starting Hermes if not present.
- Mobile-direct connection mode (Option B).
- Publishing Overwatch as an MCP server (follow-up plan after Phase 11).
- Surfacing Hermes session detail / message log in the mobile app (deferred to v2).
- Migrating existing Overwatch-local cron jobs into Hermes on switchover (manual step for v1; document in `overwatch setup --agent hermes`).
