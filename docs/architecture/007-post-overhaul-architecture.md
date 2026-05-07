# 007 — Post-Overhaul Architecture (Voice + Harness Bridge)

**Status:** Implemented (2026-05-02)
**Source plan:** [../plans/implemented/voice-harness-bridge-overhaul-2026-05-01.md](../plans/implemented/voice-harness-bridge-overhaul-2026-05-01.md)
**Related:** [004-harness-pluggability.md](004-harness-pluggability.md), [008-protocol-and-codegen.md](008-protocol-and-codegen.md), [009-auth-pairing-and-tokens.md](009-auth-pairing-and-tokens.md)

This is the canonical "what is" doc for the system as it stands today. The pre-overhaul shape — STT/TTS/VAD running on the user's Mac, the relay encrypting everything end-to-end with `nacl.box`, the mobile app driving a custom realtime protocol — is gone. None of those components exist anymore.

## One-line summary

The voice loop runs server-side in a Pipecat Cloud Python orchestrator; the user's Mac runs only a TS daemon that owns tmux + the harness fleet; a Cloudflare Worker mints sessions and routes orchestrator ↔ daemon traffic; the mobile app is a thin Pipecat React Native client.

## Topology

```
                      ┌──────────────────────────────┐
                      │  iPhone (RN/Expo, Pipecat    │
                      │  RN client, Daily transport) │
                      └──────────┬───────────────────┘
                                 │
                       WebRTC    │   POST /api/sessions/start
                       audio +   │   (user_id, pairing_token,
                       data      │    session_token)
                                 ▼
                      ┌──────────────────────────────┐
                      │  Pipecat Cloud (Daily room)  │
                      │  agent: overwatch-           │
                      │  orchestrator (us-west)      │
                      │                              │
                      │  pipecat/overwatch_pipeline/ │
                      │   bot.py runs per session    │
                      └──────────┬───────────────────┘
                                 │
            HarnessCommand /     │   wss://
            HarnessEvent JSON    │   ws/orchestrator
            envelopes            │
                                 ▼
                      ┌──────────────────────────────┐
                      │  Cloudflare Worker relay     │
                      │  overwatch-relay.soami.      │
                      │   workers.dev               │
                      │                              │
                      │  USER_CHANNEL durable object │
                      │  routes per-user between     │
                      │  ws/host and ws/orchestrator │
                      │                              │
                      │  POST /api/sessions/start    │
                      │  mints Pipecat Cloud session │
                      └──────────┬───────────────────┘
                                 │
                                 │   wss:// ws/host
                                 ▼
                      ┌──────────────────────────────┐
                      │  Mac session-host daemon     │
                      │  packages/session-host-      │
                      │   daemon (TS, Hono)          │
                      │                              │
                      │  • adapter-protocol server   │
                      │  • harness fleet (pi /       │
                      │    claude-code-cli / hermes) │
                      │  • tmux + monitors REST      │
                      │  • notification store        │
                      └──────────────────────────────┘
```

No voice code lives on the Mac anymore. STT, TTS, VAD, smart-turn, the inference gate, the deferred-update buffer, and the registry-driven event router all run inside the Pipecat Cloud Python pipeline.

## Components

### Mobile (`overwatch-mobile/`)

- React Native + Expo app, Pipecat RN client, Daily transport.
- Two-way audio over WebRTC; typed input and monitor actions go over the Daily data channel as RTVI client-messages.
- HMAC-derives a per-session token from the long-term pairing token before each session and forwards it to the relay.
- Boot path:
  1. Hydrate `pairingStore` from AsyncStorage.
  2. `POST /api/sessions/start` to the relay with `{user_id, pairing_token, session_token}`.
  3. On 200, join the returned Daily room.
  4. Any failure (token derive, 4xx/5xx, missing `daily_room_url`, transport throw) lands in `conversation.connectError` and surfaces as a "Couldn't connect" banner with a Retry button.

Key files: `app/index.tsx` (boot + UI shell), `src/hooks/use-pipecat-session.ts` (RTVI bindings and UI snapshot reducers), `src/services/session-token.ts` (HMAC, RN-dep-free so the cross-runtime test can import it), `src/services/monitors-api.ts` (request/response correlation for `monitor_action`), `src/stores/conversation.ts` (single source of truth for transport state, messages, errors), `src/stores/harness-store.ts`, `src/stores/monitors-store.ts`, `src/stores/skills-store.ts`, `src/stores/notifications-store.ts`, `src/stores/pairing-store.ts`.

### Relay (`relay/`)

- Cloudflare Worker. One file: `src/index.ts`. One durable object: `UserChannel` (`src/user-channel.ts`).
- Two roles connect via WebSocket per user:
  - `wss://relay/api/users/<user_id>/ws/orchestrator?token=<pairing>` — the Pipecat Cloud bot.
  - `wss://relay/api/users/<user_id>/ws/host?token=<pairing>` — the Mac daemon.
- The `UserChannel` DO (id derived from `user_id`) holds both sockets and forwards JSON envelopes between them. The DO does not interpret the protocol — it's a per-user message bus.
- `POST /api/sessions/start` validates the body, then calls Pipecat Cloud's `/agents/<name>/start` API with `{user_id, pairing_token, session_token, default_target}` as the runner body. Returns `{daily_room_url, daily_token}`.

Worker secrets in production: `PIPECAT_PUBLIC_KEY` (the org's public key, format `pk_…`). Optional: `PIPECAT_AGENT_NAME` (default `overwatch-orchestrator`), `PIPECAT_API_BASE` (default `https://api.pipecat.daily.co/v1`).

### Orchestrator (`pipecat/overwatch_pipeline/`)

The Pipecat Cloud agent. `bot.py` builds real Daily/STT/TTS/relay clients,
then delegates processor ordering to `pipeline_factory.py` so production and
the regression harness share the same composition:

```
transport.input
  → TypedInputDecoder        # RTVI client-message → UserTextInputFrame / MonitorActionFrame
  → InterruptionEmitter      # VAD / interrupt-intent → InterruptionFrame broadcast
  → DeepgramSTTService       # Nova-3 streaming
  → UserTurnProcessor        # smart-turn stop strategy for pause-safe turns
  → IdleReportProcessor      # injects "agent is idle" updates
  → PreLLMInferenceGate      # admit/deny based on InferenceGateState
  → HarnessBridgeProcessor   # ↔ HarnessAdapterClient (RelayClient), forwards daemon ServerMessages
  → HarnessRouterProcessor   # registry-driven dispatch
  → PostLLMInferenceGate     # mark-done bookkeeping
  → SayTextVoiceGuard        # last-line speakable filter
  → configured streaming TTS # Cartesia Sonic or xAI WebSocket
  → transport.output
```

Architecture I — there is no voice LLM in the main flow. The harness on the Mac is the LLM. Inbound `HarnessEvent`s flow through `HarnessRouterProcessor`, which consults `HARNESS_EVENT_CONFIGS` to decide one of four voice actions: `speak`, `inject`, `ui-only`, `drop`. The default policy for unmapped events never returns `speak` — promotion to spoken voice requires an explicit registry entry.

Files of note:

| Concern | File |
|---|---|
| Pipeline composition | `bot.py` |
| Pipeline composition factory + test seam | `pipeline_factory.py` |
| Harness adapter wire client | `harness_adapter_client.py` (`RelayClient`, `LocalUDSClient` stub) |
| Bridge processor (the only place that emits `HarnessCommand`s) | `harness_bridge.py` |
| Event router | `harness_event_router.py` (the FrameProcessor) |
| Routing registry + lookup | `harness_router.py` (`HARNESS_EVENT_CONFIGS`, `lookup_config`) |
| Inference gate state | `inference_gate.py` |
| Idle reporting | `idle_report.py` |
| Deferred updates injected into next prompt | `deferred_update_buffer.py` |
| Held user turns while admission is blocked | `pending_user_input_buffer.py` |
| Token validator (boundary check) | `auth/token_validator.py` |
| Typed-input decoder | `typed_input_decoder.py` |
| Settings (env-loaded) | `settings.py` |
| TTS provider selection | `tts_provider.py` |
| Cartesia voice catalog | `voices.py` |
| Codegenned types | `protocol/generated/` (don't edit) |

Required env vars (loaded by `settings.load`): `DEEPGRAM_API_KEY`, plus the API key for the default TTS path. `TTS_PROVIDER` defaults to `cartesia`, so `CARTESIA_API_KEY` is required by default. `TTS_PROVIDER=xai` requires `XAI_API_KEY` instead. Individual installs set their preferred TTS provider in `~/.overwatch/config.json` via `overwatch setup --tts cartesia|xai`; the gateway includes that value in the pairing QR, the phone persists it with the pairing, and `/api/sessions/start` forwards it as `tts_provider` after relay validation. If a user requests xAI, the deployment must have `XAI_API_KEY` configured. Optional voice settings: `CARTESIA_VOICE_ID`, `XAI_TTS_VOICE` (default `eve`), `XAI_TTS_LANGUAGE` (default `en`), `XAI_TTS_SAMPLE_RATE`, and `XAI_TTS_OPTIMIZE_STREAMING_LATENCY` (default on). Optional runtime settings: `RELAY_URL`, `SESSION_TOKEN_SECRET`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `ENVIRONMENT`, `REGISTRY_DEFAULT_MODE`, `STT_ENDPOINTING_MS`, `STT_UTTERANCE_END_MS`. Deepgram endpointing defaults to 1000 ms and utterance-end defaults to 2000 ms so short pauses inside one sentence do not fragment into multiple harness turns. These deployment-level values are stored in the `overwatch` Pipecat Cloud secret set.

### Mac daemon (`packages/session-host-daemon/`)

A single Hono server + WebSocket client. Roles:

- **`AdapterProtocolServer`** (`src/adapter-protocol/server.ts`) — connects out to `wss://relay/api/users/<id>/ws/host`, validates inbound envelopes (token + protocol-version + command-allowlist), dispatches to the active harness, streams events back, and emits mobile UI snapshots (`harness_snapshot`, `monitor_snapshot`, `skills_snapshot`, `notification`). Subscribes to `notificationStore` and surfaces scheduled-task notifications as both typed `notification` server messages for hydration and `provider_event(overwatch/notification)` so the orchestrator can speak them.
- **Harness fleet** (`src/harness/`) — three providers behind one async-iterable interface; see [004](004-harness-pluggability.md).
- **Local REST API** — `/api/v1/monitors`, `/api/v1/tmux`, `/api/v1/hermes/webhook`, `/health`, `/debug/harness`. The monitor REST shim remains useful locally, but mobile monitor UX now goes over the relay/orchestrator path via `monitor_action` → `manage_monitor`.
- **Hermes bridges** (`src/scheduler/`) — only run when `HARNESS_PROVIDER=hermes`. See [005](005-hermes-bridge.md).

Required env vars (loaded by `src/config.ts`): `OVERWATCH_USER_ID` and `ORCHESTRATOR_PAIRING_TOKEN` — bootstrapped via `overwatch setup`. The daemon refuses to connect to the relay without them and logs a clear message.

Per-target catch-all logger fires for every event sent to the orchestrator when `CATCH_ALL_LOGGER=1` — writes to `~/.overwatch/catch-all/<target>/<date>.jsonl`. Useful for discovering unmapped events that should be promoted from `provider_event` to a Tier-1 mapping.

### CLI (`packages/cli/`)

`overwatch setup`, `overwatch start`, `overwatch status`, `overwatch agent` — orchestrate machine-level installation, pairing, the launchd gateway, and provider selection. The CLI never speaks the voice loop; it just owns local state.

## Wire protocol

Every message between phone, relay, orchestrator, and daemon shares the `Envelope`:

```json
{
  "protocol_version": "1.0",
  "kind": "harness_command" | "harness_event" | "server_message",
  "id": "<ulid>",
  "timestamp": "2026-05-02T22:38:09Z",
  "session_token": "<hmac>",
  "payload": { ... }
}
```

`protocol_version` is checked on receive both directions. Mismatched MAJOR → orchestrator drops with a warning, daemon responds with an explicit `error_response`.

`HarnessCommand` is `submit_text | submit_with_steer | cancel | manage_monitor`. `manage_monitor` is only for authenticated UI monitor actions; it does not enter the user-turn inference path. `HarnessEvent` is a two-tier discriminated union: Tier 1 canonical events (`text_delta`, `assistant_message`, `reasoning_delta`, `tool_lifecycle`, `session_init`, `session_end`, `error`, `cancel_confirmed`, `agent_busy`, `agent_idle`) plus Tier 2 `provider_event` for everything provider-specific. Adapters never silently drop wire events — anything that doesn't map to Tier 1 surfaces as Tier 2.

Mobile-facing `ServerMessage`s include the legacy `harness_state` snapshot for inference-gate bootstrapping plus richer UI messages: `harness_snapshot` (active provider, target namespace, provider registry, capabilities, in-flight state), `monitor_snapshot` (monitor rows plus action metadata), `skills_snapshot`, `notification`, and correlated `monitor_action_result`.

## Provider Event Mapping

Canonical Tier-1 mappings render consistently across Pi, Claude Code, and Hermes: `session_init` hydrates session/provider detail, `reasoning_delta` appends to the reasoning block, `tool_lifecycle` updates tool rows, `session_end` finalizes the active assistant turn, `error` surfaces an error row/notification, `cancel_confirmed` clears interruption state, and `agent_busy` / `agent_idle` gate user turns and monitor/manual controls.

Provider-specific Tier-2 events use these namespaces:

| Provider | Registry id | Event namespace | UI mapping notes |
|---|---|---|---|
| Pi | `pi-coding-agent` | `pi` | `memory_updated` becomes memory/provider activity; `scheduler_fired` becomes monitor activity when local monitors exist; `session_stats` becomes a lightweight stats row; unknown message updates are generic provider activity. |
| Claude Code | `claude-code-cli` | `claude-code` | `compact_boundary`, `files_persisted`, `task_progress`, `prompt_suggestion`, `plugin_install`, and `tool_use_summary` render as compact provider activity/status rows. `rate_limit` and `auth_status` also create warning/error notifications. `hook_response` stays dropped unless product explicitly wants hook output visible. |
| Hermes | `hermes` | `hermes` | `tool.started`, `tool.completed`, `reasoning.available`, `message.delta`, `message.completed`, `run.completed`, and `run.failed` are normalized to Tier 1. `memory.updated` becomes memory activity; `cron.triggered` becomes monitor activity. UI/router code should not depend on `hermes/run_completed`; the live mapper uses `run.completed` → `session_end`. |
| Overwatch internal | n/a | `overwatch` | `notification`, `monitor_fired`, and `scheduled_task_done` hydrate notifications/monitor activity and may feed deferred context for the next user turn. |

Schemas live in `protocol/schema/*.json`; codegen runs both ways. See [008-protocol-and-codegen.md](008-protocol-and-codegen.md).

## Auth

Phone derives `session_token = HMAC-SHA256(pairing_token, "{session_id}|{expires_at}")` and forwards it everywhere. Orchestrator verifies at boundary (refuses to start the pipeline on bad/expired token); daemon verifies on every command envelope. Phone, orchestrator, and daemon all share the same pairing-token-derived secret. See [009-auth-pairing-and-tokens.md](009-auth-pairing-and-tokens.md) for the full chain.

## Cancellation contract

The bridge owns `_active_correlation_id`. New user input while a turn is in flight emits `submit_with_steer { cancels_correlation_id }`. The daemon abort-races the in-flight harness against a 2 s timer; on success it emits `cancel_confirmed`, on miss it emits `error("cancel_confirmed timeout")`. `StaleSuppression` ensures any frames from the cancelled correlation id are dropped after the cancel is acknowledged.

## Busy and Compaction Contract

`harness_in_flight` and `harness_busy` are separate gate states. In-flight means an answer turn is running and user input may preempt via `submit_with_steer`. Busy means the adapter is doing non-turn work, currently pi-coding-agent compaction, and the orchestrator must not send `submit_text`, `submit_with_steer`, or `cancel`.

Adapters that can observe non-turn busy windows emit `agent_busy { phase: "compaction" | "tool" | "system" }` and later `agent_idle`. Today only the pi adapter maps native `compaction_start` / `compaction_end` to those Tier-1 events. While busy, the bridge stores the latest user text in `PendingUserInputBuffer` (last write wins) and leaves `DeferredUpdateBuffer` intact. On `agent_idle`, the held user turn is admitted automatically with any real injected context prepended. `interrupt_intent` still broadcasts Pipecat `InterruptionFrame`s so local TTS/output audio is stopped; it just does not poke the busy harness.

## Observability

- **Honeycomb** — orchestrator exports OTLP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` are set. `bot.py:_setup_observability` wires `BatchSpanProcessor`.
- **Sentry** — orchestrator initializes Sentry SDK if `SENTRY_DSN` is set.
- **Daemon audit log** — every command envelope (accepted or rejected) appends to `~/.overwatch/audit.jsonl` (`AuditLog`).
- **Catch-all logger** — see daemon section above.
- **Pipecat Cloud logs** — `pcc agent logs overwatch-orchestrator` (filter by `-d <deployment-id>` or `-s <session-id>`).
- **Wrangler tail** — `wrangler tail` from `relay/`.

## Deploy

| Surface | Command | Notes |
|---|---|---|
| Orchestrator | `./scripts/deploy-orchestrator.sh` from repo root | Runs `./scripts/predeploy.sh` first, then `pcc deploy --yes --force` from `pipecat/`. Raw `pcc deploy` is not the agent deploy path. |
| Relay | `wrangler deploy` from `relay/` | DO migration v2 created `UserChannel`, deleted legacy `Room`. |
| Mobile | `eas build -p ios` (or `expo run:ios`) | Native build required — Daily WebRTC needs the prebuild + native compile, not just Metro. |
| Daemon | `overwatch start` (launchd-managed) | Bootstrapped via `overwatch setup`. |

Live state at time of writing: orchestrator cloud build `702f392c` (2026-05-06), relay version `4bf6b3e0`. End-to-end relay → Pipecat Cloud → orchestrator boot path was verified against a synthetic session-start (the orchestrator correctly rejected a bogus token via `auth/token_validator.py`).

## Invariants

These are the load-bearing rules. Violating them breaks correctness, not just style.

1. **Only user input ever produces `submit_with_steer` or `cancel`.** Background events (e.g. monitor fired, scheduled task done) route through the registry, never as commands.
2. **Unknown events never produce audio.** Default policy for unmapped events is `ui-only` in dev, `drop` in prod. Promoting to `speak` requires an explicit `HARNESS_EVENT_CONFIGS` entry.
3. **Reasoning is never spoken.** `reasoning_delta` is mapped to `inject`, not `speak`.
4. **Adapters never silently drop wire events.** Anything that doesn't map to Tier 1 surfaces as Tier 2 `provider_event`.
5. **Schema is the single source of truth.** Generated TS/Python files are read-only; edit `protocol/schema/` and re-run `npm run protocol:gen`. CI guard via `npm run protocol:check`.
6. **The bridge is the only processor that emits `HarnessCommand`s.** The router only emits frames downstream (`LLMTextFrame`, `OutputTransportMessageFrame`).
7. **Tokens are verified at every boundary they cross.** Phone derives, orchestrator verifies on session start, daemon verifies on every command.
8. **No harness commands during adapter busy windows.** `agent_busy` blocks command admission but not local audio interruption; held user input remains user input and is delivered once after `agent_idle`.
9. **Orchestrator deploys are gated.** `scripts/predeploy.sh` must pass before `scripts/deploy-orchestrator.sh` invokes Pipecat Cloud deploy.

## Where to look first when something breaks

| Symptom | First place |
|---|---|
| Phone shows "Couldn't connect" | relay logs (`wrangler tail`) — check `/api/sessions/start` response |
| Phone joins room, no audio either way | Pipecat Cloud logs — DeepgramSTTService / CartesiaTTSService init |
| Phone joins, voice works, but harness commands don't reach Mac | daemon stdout — adapter-protocol-server connect log; relay logs for ws/host upgrades |
| Token rejected | `pcc agent logs ... -s <session-id>` — `auth.token_validator` line; daemon `~/.overwatch/audit.jsonl` |
| Notifications don't speak | daemon logs — `notificationStore` subscribe; orchestrator `HARNESS_EVENT_CONFIGS["overwatch/notification"]` |
| Codegen drift in CI | `npm run protocol:check` locally; commit the regen output |
