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
- Two-way audio over WebRTC; typed input goes over the Daily data channel as RTVI client-messages.
- HMAC-derives a per-session token from the long-term pairing token before each session and forwards it to the relay.
- Boot path:
  1. Hydrate `pairingStore` from AsyncStorage.
  2. `POST /api/sessions/start` to the relay with `{user_id, pairing_token, session_token}`.
  3. On 200, join the returned Daily room.
  4. Any failure (token derive, 4xx/5xx, missing `daily_room_url`, transport throw) lands in `conversation.connectError` and surfaces as a "Couldn't connect" banner with a Retry button.

Key files: `app/index.tsx` (boot + UI shell), `src/hooks/use-pipecat-session.ts` (RTVI bindings), `src/services/session-token.ts` (HMAC, RN-dep-free so the cross-runtime test can import it), `src/stores/conversation.ts` (single source of truth for transport state, messages, errors), `src/stores/pairing-store.ts`.

### Relay (`relay/`)

- Cloudflare Worker. One file: `src/index.ts`. One durable object: `UserChannel` (`src/user-channel.ts`).
- Two roles connect via WebSocket per user:
  - `wss://relay/api/users/<user_id>/ws/orchestrator?token=<pairing>` — the Pipecat Cloud bot.
  - `wss://relay/api/users/<user_id>/ws/host?token=<pairing>` — the Mac daemon.
- The `UserChannel` DO (id derived from `user_id`) holds both sockets and forwards JSON envelopes between them. The DO does not interpret the protocol — it's a per-user message bus.
- `POST /api/sessions/start` validates the body, then calls Pipecat Cloud's `/agents/<name>/start` API with `{user_id, pairing_token, session_token, default_target}` as the runner body. Returns `{daily_room_url, daily_token}`.

Worker secrets in production: `PIPECAT_PUBLIC_KEY` (the org's public key, format `pk_…`). Optional: `PIPECAT_AGENT_NAME` (default `overwatch-orchestrator`), `PIPECAT_API_BASE` (default `https://api.pipecat.daily.co/v1`).

### Orchestrator (`pipecat/overwatch_pipeline/`)

The Pipecat Cloud agent. One pipeline composition lives in `bot.py`:

```
transport.input
  → TypedInputDecoder        # RTVI server-message → UserTextInputFrame
  → DeepgramSTTService       # Nova-3 streaming
  → IdleReportProcessor      # injects "agent is idle" updates
  → PreLLMInferenceGate      # admit/deny based on InferenceGateState
  → HarnessBridgeProcessor   # ↔ HarnessAdapterClient (RelayClient)
  → HarnessRouterProcessor   # registry-driven dispatch
  → PostLLMInferenceGate     # mark-done bookkeeping
  → SayTextVoiceGuard        # last-line speakable filter
  → CartesiaTTSService       # Sonic streaming
  → transport.output
```

Architecture I — there is no voice LLM in the main flow. The harness on the Mac is the LLM. Inbound `HarnessEvent`s flow through `HarnessRouterProcessor`, which consults `HARNESS_EVENT_CONFIGS` to decide one of four voice actions: `speak`, `inject`, `ui-only`, `drop`. The default policy for unmapped events never returns `speak` — promotion to spoken voice requires an explicit registry entry.

Files of note:

| Concern | File |
|---|---|
| Pipeline composition | `bot.py` |
| Harness adapter wire client | `harness_adapter_client.py` (`RelayClient`, `LocalUDSClient` stub) |
| Bridge processor (the only place that emits `HarnessCommand`s) | `harness_bridge.py` |
| Event router | `harness_event_router.py` (the FrameProcessor) |
| Routing registry + lookup | `harness_router.py` (`HARNESS_EVENT_CONFIGS`, `lookup_config`) |
| Inference gate state | `inference_gate.py` |
| Idle reporting | `idle_report.py` |
| Deferred updates injected into next prompt | `deferred_update_buffer.py` |
| Token validator (boundary check) | `auth/token_validator.py` |
| Typed-input decoder | `typed_input_decoder.py` |
| Settings (env-loaded) | `settings.py` |
| Voice catalog | `voices.py` |
| Codegenned types | `protocol/generated/` (don't edit) |

Required env vars (loaded by `settings.load`): `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`. Optional: `RELAY_URL`, `CARTESIA_VOICE_ID`, `SESSION_TOKEN_SECRET`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `ENVIRONMENT`, `REGISTRY_DEFAULT_MODE`. All of these are stored in the `overwatch` Pipecat Cloud secret set.

### Mac daemon (`packages/session-host-daemon/`)

A single Hono server + WebSocket client. Roles:

- **`AdapterProtocolServer`** (`src/adapter-protocol/server.ts`) — connects out to `wss://relay/api/users/<id>/ws/host`, validates inbound envelopes (token + protocol-version + command-allowlist), dispatches to the active harness, and streams events back. Subscribes to `notificationStore` and surfaces scheduled-task notifications as `provider_event(overwatch/notification)` so the orchestrator can speak them.
- **Harness fleet** (`src/harness/`) — three providers behind one async-iterable interface; see [004](004-harness-pluggability.md).
- **Local REST API** — `/api/v1/monitors`, `/api/v1/tmux`, `/api/v1/hermes/webhook`, `/health`, `/debug/harness`. Mobile uses these for monitors/tmux UX.
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

`HarnessCommand` is `submit_text | submit_with_steer | cancel`. `HarnessEvent` is a two-tier discriminated union: Tier 1 canonical events (`text_delta`, `assistant_message`, `reasoning_delta`, `tool_lifecycle`, `session_init`, `session_end`, `error`, `cancel_confirmed`) plus Tier 2 `provider_event` for everything provider-specific. Adapters never silently drop wire events — anything that doesn't map to Tier 1 surfaces as Tier 2.

Schemas live in `protocol/schema/*.json`; codegen runs both ways. See [008-protocol-and-codegen.md](008-protocol-and-codegen.md).

## Auth

Phone derives `session_token = HMAC-SHA256(pairing_token, "{session_id}|{expires_at}")` and forwards it everywhere. Orchestrator verifies at boundary (refuses to start the pipeline on bad/expired token); daemon verifies on every command envelope. Phone, orchestrator, and daemon all share the same pairing-token-derived secret. See [009-auth-pairing-and-tokens.md](009-auth-pairing-and-tokens.md) for the full chain.

## Cancellation contract

The bridge owns `_active_correlation_id`. New user input while a turn is in flight emits `submit_with_steer { cancels_correlation_id }`. The daemon abort-races the in-flight harness against a 2 s timer; on success it emits `cancel_confirmed`, on miss it emits `error("cancel_confirmed timeout")`. `StaleSuppression` ensures any frames from the cancelled correlation id are dropped after the cancel is acknowledged.

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
| Orchestrator | `pcc deploy --yes --force` from `pipecat/` | Reads `pcc-deploy.toml`. Cloud build, secret set `overwatch`, region `us-west`. |
| Relay | `wrangler deploy` from `relay/` | DO migration v2 created `UserChannel`, deleted legacy `Room`. |
| Mobile | `eas build -p ios` (or `expo run:ios`) | Native build required — Daily WebRTC needs the prebuild + native compile, not just Metro. |
| Daemon | `overwatch start` (launchd-managed) | Bootstrapped via `overwatch setup`. |

Live state at time of writing: orchestrator deployment `2441b7cd`, relay version `36ef18f4`. End-to-end relay → Pipecat Cloud → orchestrator boot path was verified against a synthetic session-start (the orchestrator correctly rejected a bogus token via `auth/token_validator.py`).

## Invariants

These are the load-bearing rules. Violating them breaks correctness, not just style.

1. **Only user input ever produces `submit_with_steer` or `cancel`.** Background events (e.g. monitor fired, scheduled task done) route through the registry, never as commands.
2. **Unknown events never produce audio.** Default policy for unmapped events is `ui-only` in dev, `drop` in prod. Promoting to `speak` requires an explicit `HARNESS_EVENT_CONFIGS` entry.
3. **Reasoning is never spoken.** `reasoning_delta` is mapped to `inject`, not `speak`.
4. **Adapters never silently drop wire events.** Anything that doesn't map to Tier 1 surfaces as Tier 2 `provider_event`.
5. **Schema is the single source of truth.** Generated TS/Python files are read-only; edit `protocol/schema/` and re-run `npm run protocol:gen`. CI guard via `npm run protocol:check`.
6. **The bridge is the only processor that emits `HarnessCommand`s.** The router only emits frames downstream (`LLMTextFrame`, `OutputTransportMessageFrame`).
7. **Tokens are verified at every boundary they cross.** Phone derives, orchestrator verifies on session start, daemon verifies on every command.

## Where to look first when something breaks

| Symptom | First place |
|---|---|
| Phone shows "Couldn't connect" | relay logs (`wrangler tail`) — check `/api/sessions/start` response |
| Phone joins room, no audio either way | Pipecat Cloud logs — DeepgramSTTService / CartesiaTTSService init |
| Phone joins, voice works, but harness commands don't reach Mac | daemon stdout — adapter-protocol-server connect log; relay logs for ws/host upgrades |
| Token rejected | `pcc agent logs ... -s <session-id>` — `auth.token_validator` line; daemon `~/.overwatch/audit.jsonl` |
| Notifications don't speak | daemon logs — `notificationStore` subscribe; orchestrator `HARNESS_EVENT_CONFIGS["overwatch/notification"]` |
| Codegen drift in CI | `npm run protocol:check` locally; commit the regen output |
