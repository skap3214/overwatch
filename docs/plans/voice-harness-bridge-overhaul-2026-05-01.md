# Plan: Voice Pipeline + Harness Bridge Overhaul

**Date:** 2026-05-01
**Status:** Proposed
**Branch model:** Clean overhaul branch (`overhaul/voice-harness-bridge`). No runtime backward compatibility with the current WS audio path. Rollback is `git checkout main`, not a feature flag.
**Distribution scope:** Private alpha. Soami + ~3–5 trusted testers. One hosted orchestrator environment we operate. No public open-signup, no billing, no accounts. OSS code remains public; BYOK and self-host (Y2) paths are documented as future plans only.
**Related Research:** [../research/voice-pipeline-pipecat-gradient-bang-2026-05-01.md](../research/voice-pipeline-pipecat-gradient-bang-2026-05-01.md)
**Related Architecture:** [../architecture/004-harness-pluggability.md](../architecture/004-harness-pluggability.md), [../architecture/006-overwatch-hermes-plugin.md](../architecture/006-overwatch-hermes-plugin.md), [../architecture/003-gateway-service.md](../architecture/003-gateway-service.md)
**Supersedes:** [pipecat-voice-mode-2026-04-09.md](./pipecat-voice-mode-2026-04-09.md) (the earlier plan ran the pipecat pipeline on the user's Mac; this plan moves it to Pipecat Cloud and reframes the orchestrator boundary)

---

## 0. Thesis

Pipecat owns the voice loop. Hermes / Claude Code / Pi / Codex each own their context window. **Nobody owns the boundary between them.** Overwatch's contribution is a typed harness-event protocol + a voice-action registry + a thin-client orchestrator that together make any agent harness conversational, hands-free, and interruptible — without forking the harness. The voice loop is well-trodden ground; the harness boundary is the open problem and the load-bearing piece of this plan.

This is a clean overhaul. The legacy WS-audio path, custom mobile audio modules, local STT/TTS adapters, and the in-process orchestrator on the Mac are deleted in this branch. There is no runtime feature-flag fallback; correctness is asserted by the new path's own tests.

## 1. Outcome

After this overhaul, a private-alpha user can:

- Press to talk *or* speak naturally with VAD + smart-turn endpointing on a hands-free always-listening mode.
- Interrupt the assistant mid-sentence; the in-flight harness turn cancels with confirmed cancellation, harness state is suppressed for stale events, and a new turn fires within ~300 ms of the user resuming.
- Have multiple coding agents (Claude Code, Hermes, Pi) emit events into a single voice loop without losing fidelity. New harnesses (Codex, cursor-agent, future entries) plug in via a one-line registry entry and a TS adapter, with zero changes to pipeline core.
- Hear meaningful harness events (assistant text, tool calls, errors, rate limits, auth issues) routed to TTS, mobile UI, or buffered for next-turn injection per a declarative registry.
- Run all of this with the orchestrator hosted by us in the cloud (Pipecat Cloud), the harness on their own Mac, and the audio on direct WebRTC with hardware AEC.

## 2. Non-goals

| Non-goal | Rationale |
|---|---|
| Voice Agent LLM (Architecture II) | We ship Architecture I — pure router, no voice-loop LLM. The harness is the only LLM in the pipeline. Architecture II is a future experiment. |
| Multi-Mac orchestration | Single-computer scope. The `HarnessAdapterClient.target` field is multi-target ready; multi-Mac ships as its own future plan. |
| Self-hosted pipecat install path (Y2) on the Mac | Pipecat Cloud is the chosen runtime. Y2 has the same code; documenting the manual install is a future docs task. |
| BYOK Pipecat Cloud install path | Same — documented as future docs only, not built into `install.sh`. |
| User accounts, billing, paywall | Hosted-by-us is private-alpha free; monetization is a future product layer. |
| Multi-tenant production isolation security work | We are a private alpha; per-session pipecat instances + per-user tokens are sufficient. Hardening is a future plan if/when public distribution arrives. |
| Immediate-run injection (gradient-bang's `LLMMessagesAppendFrame(run_llm=True)`) | Architecture I's harness has no native "inject and re-infer now" primitive on Claude Code CLI. Deferred injection (buffered prepend on next user turn) is the supported flavor. |
| Auto-steering on background events | The orchestrator never cancels the harness's in-flight turn on its own. Only user input (voice or typed) triggers cancellation or steer. |
| Open-signup multi-tenant hosted product | Out of scope — private alpha only. |
| iOS App Store distribution polish | Existing TestFlight flow is sufficient. |

## 3. End-state architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   PHONE (RN/Expo Prebuild)                                                   │
│   PipecatClient (client-js) + RNDailyTransport + react-native-webrtc         │
│   Single Zustand store, derived speaking state, server-mute,                 │
│   spoken/unspoken cursor, deferred bot-message finalization                  │
│   Voice (PTT or always-listening) and typed input both flow through          │
│   the same orchestrator-side bridge.                                         │
│                                                                              │
│       │ WebRTC media + data channel (audio + RTVI server messages)           │
│       │ DTLS-SRTP                                                            │
│       │                                                                      │
│       │  (one-time pairing only) WS over CF Workers Relay                    │
│       │  with nacl.box. Issues per-user token shared with Mac daemon.        │
│       │                                                                      │
└───────┼──────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   PIPECAT CLOUD (we host, Python)                                           │
│   Per-session bot instance; isolated by Pipecat Cloud's scheduler.          │
│                                                                             │
│   Pipeline:                                                                 │
│     transport.input  (Daily WebRTC)                                         │
│     ─▶ DeepgramSTTService (streaming Nova-3)                                │
│     ─▶ user_aggregator [SileroVADAnalyzer + LocalSmartTurnAnalyzerV3        │
│                          + TextInputBypassFirstBotMuteStrategy              │
│                          + filter_incomplete_user_turns=True]               │
│     ─▶ PreLLMInferenceGate                ◀──── shared InferenceGateState   │
│     ─▶ HarnessBridgeProcessor             ───▶ HarnessAdapterClient         │
│     ─▶ PostLLMInferenceGate               ◀──── shared InferenceGateState   │
│     ─▶ TokenUsageMetricsProcessor                                           │
│     ─▶ SayTextVoiceGuard                                                    │
│     ─▶ CartesiaTTSService (streaming Sonic)                                 │
│     ─▶ transport.output                                                     │
│                                                                             │
│   Parallel processors (not in main flow):                                   │
│     IdleReportProcessor, DeferredUpdateBuffer                               │
│                                                                             │
│   Owned modules:                                                            │
│     HarnessRouter (registry-driven; no auto-cancellation)                   │
│     HARNESS_EVENT_CONFIGS (declarative)                                     │
│     HarnessAdapterClient interface + RelayClient implementation             │
│     Cancellation contract (correlation-id-scoped, confirmed cancellation)   │
│     Protocol schema validators (pydantic, codegen from JSON Schema)         │
│     OTel exporter, structured logs                                          │
│                                                                             │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     │ encrypted JSON over CF Workers Relay
                                     │ (per-user token + per-session token,
                                     │  command allowlist enforced on daemon)
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   USER'S MAC                                                                │
│   packages/session-host-daemon  (TypeScript, no voice code)                 │
│                                                                             │
│     ├── tmux ownership (existing)                                           │
│     ├── Harness adapters (Claude Code stream-json + JSONL fallback,         │
│     │                     Hermes SSE, Pi in-process subscribe)              │
│     ├── Catch-all logger per adapter (env-gated JSONL of every wire event)  │
│     ├── Cancellation execution per provider (signal/cancel/SIGTERM)         │
│     ├── Cancellation confirmation emitter (cancel_confirmed event)          │
│     ├── Stale-event suppression by correlation_id                           │
│     ├── Local audit log of every cloud-originated command (JSONL, 30 days)  │
│     ├── Realtime/relay client (existing nacl.box, narrowed)                 │
│     ├── Notification store + scheduler + monitor sources (existing)         │
│     ├── Skills system (existing, unchanged)                                 │
│     └── CLI / setup / launchd / gateway lifecycle (existing)                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 4. Layers

### 4.1 Mobile orchestrator client (`overwatch-mobile/`)

**Replaces:** the current custom WS protocol, custom audio modules, split-state stores, hand-rolled turn coordination.

**Composition:**

- **Audio + transport**: `@pipecat-ai/client-js` (PipecatClient core, transport-agnostic) + `@pipecat-ai/react-native-daily-transport` (RNDailyTransport wrapping `@daily-co/react-native-daily-js` and `@daily-co/react-native-webrtc`).
- **State**: a single Zustand store (`stores/conversation.ts`) where `isAgentSpeaking` / `isUserSpeaking` are derived from the active assistant message's `final` flag, never stored directly. Tool-call lifecycle messages, transcript entries, errors, server messages all live in one timeline.
- **Hooks** collapsing into `use-pipecat-session.ts`:
  - subscribes to RTVI events (`onUserTranscript`, `onBotLlmText`, `onBotTtsStarted/Stopped`, `onUserMuteStarted/Stopped`, `onServerMessage`)
  - exposes a three-state transport indicator (`disconnected | connecting | connected`)
  - drives the `client-ready ↔ bot-ready` handshake with retry/timeout (workaround for [pipecat#4086](https://github.com/pipecat-ai/pipecat/issues/4086))
- **Voice and typed input both produce a `user_text` server message** delivered to the orchestrator. The orchestrator decides whether to send the harness a `submit_text` or `submit_with_steer` based on in-flight state. Mobile does not preempt — it just submits.
- **PTT button**: reads `isRemoteMuted` from RTVI mute events; press fires a `turn.interrupt` server-message + opens the mic locally.
- **Always-listening toggle** in settings: when off, mic is gated by PTT only; when on, mic is always sent and the orchestrator's VAD + smart-turn decide turn boundaries.
- **Visual feedback**:
  - Spoken/unspoken cursor — each assistant message is sliced into `{ spoken, unspoken }` based on a char cursor advanced by `bot-tts` events; unspoken portion renders dimmed.
  - Deferred bot-message finalization — 1500 ms timer after `bot-tts-stopped` before calling `finalizeLastMessage`; cleared if `bot-tts-started` fires again. Prevents split bubbles on TTS pauses.
  - Tool-call interleaving — function-call messages timestamped 1 ms before their parent assistant message so they sort correctly.
- **Native modules deleted**: `modules/fast-recorder`, `modules/streaming-audio`. Replaced by `@daily-co/react-native-webrtc` audio tracks.
- **Pairing UI**: existing QR scanner unchanged; flow now also receives the orchestrator endpoint URL + per-user token.

### 4.2 Transport layer

**WebRTC end-to-end** between phone and Pipecat Cloud. Daily transport bundled with Pipecat Cloud.

- AEC, jitter buffer, codec negotiation, packet-loss concealment, congestion control all come from WebRTC. The 2 s post-bot cooldown that the current architecture needs to compensate for echo collapses to AEC's natural ~200–400 ms tail.
- TURN provided by Daily.
- The CF Workers relay no longer carries audio. It survives as: signaling for phone↔Mac pair-time setup, an encrypted JSON command/event channel between cloud orchestrator and Mac daemon. Existing `nacl.box` encryption preserved.
- Mobile↔orchestrator non-audio events flow over the WebRTC data channel managed by `PipecatClient`.

### 4.3 Cloud orchestrator (`pipecat/`)

**New top-level package** containing the Python pipecat pipeline definition, deployed to Pipecat Cloud as a Docker image.

```
pipecat/
├── pyproject.toml
├── Dockerfile                              ← Pipecat Cloud deploy artifact
├── pcc-deploy.toml                         ← Pipecat Cloud config
├── overwatch_pipeline/
│   ├── __init__.py
│   ├── bot.py                              ← entrypoint; pipeline composition
│   ├── inference_gate.py                   ← InferenceGateState, PreLLM/PostLLM gates
│   ├── harness_router.py                   ← registry-driven event routing
│   ├── harness_bridge.py                   ← user→harness, harness→pipeline bridge
│   ├── harness_adapter_client.py           ← interface + RelayClient impl
│   ├── deferred_update_buffer.py           ← buffers `inject` events for next user turn
│   ├── idle_report.py                      ← idle-report processor
│   ├── say_text_voice_guard.py             ← suppresses double-output during say-text
│   ├── frames.py                           ← UserTextInputFrame, HarnessEventFrame, etc.
│   ├── voices.py                           ← Cartesia voice registry
│   ├── settings.py                         ← env config; STT/TTS keys; relay URL
│   ├── protocol/
│   │   └── types_generated.py              ← codegenned from /protocol/schema/
│   ├── observability/
│   │   ├── otel.py                         ← OTel sdk, manual spans
│   │   ├── metrics.py                      ← TokenUsageMetricsProcessor + custom
│   │   └── logging_config.py               ← structured loguru
│   └── auth/
│       └── token_validator.py              ← per-user + per-session token check
└── tests/
    ├── unit/
    │   ├── test_inference_gate.py
    │   ├── test_harness_router.py          ← registry routing, voiceAction dispatch
    │   ├── test_cancellation_contract.py   ← state machine, timeouts, suppression
    │   ├── test_deferred_buffer.py
    │   └── test_idle_report.py
    └── integration/
        ├── e2e_harness.py                  ← ScriptedHarness, deterministic runs
        ├── test_voice_relay_integration.py
        └── conftest.py
```

**Pipeline composition (`bot.py`):**

```
NETWORK (Daily WebRTC, managed by Pipecat Cloud)
   │
[ transport.input() ]
   │
[ DeepgramSTTService(model="nova-3", interim_results=True) ]
   │
[ IdleReportProcessor ]                                        ◀── parallel
   │
[ PreLLMInferenceGate(state=gate_state) ]
   │
[ user_aggregator
    vad_analyzer = SileroVADAnalyzer(),
    turn_analyzer = LocalSmartTurnAnalyzerV3(stop_secs=3.0, max_duration_secs=8.0),
    mute_strategy = TextInputBypassFirstBotMuteStrategy(),
    filter_incomplete_user_turns = True
  ]
   │
[ HarnessBridgeProcessor ]                  ↔  HarnessAdapterClient (RelayClient)
   │                                              ↕ harness commands / events
   │                                              ↕ to/from Mac session-host daemon
[ PostLLMInferenceGate(state=gate_state) ]
   │
[ TokenUsageMetricsProcessor ]
   │
[ SayTextVoiceGuard ]
   │
[ CartesiaTTSService(model="sonic", voice_id=DEFAULT_VOICE) ]
   │
[ transport.output() ]
   │
   └─ assistant_aggregator (no auto-summarization — harness owns its context)
```

**Key state:**

- `InferenceGateState` — single instance shared between Pre and Post gates. Five fields (`bot_speaking`, `user_speaking`, `llm_in_flight`, `cooldown_until`, `pending`) plus `cancel_pending` (a set of correlation_ids awaiting `cancel_confirmed`). Four-condition `_can_run_now()` plus a fifth: no cancellations pending.
- `DeferredUpdateBuffer` — accumulates `voiceAction: "inject"` event payloads; on next user-initiated turn, prepends them to the user's text as `<context source="..." kind="...">...</context>` blocks before submission to the harness.
- `IdleReportProcessor` — 9 s after last `BotStoppedSpeakingFrame` if user has spoken at least once; 45 s cooldown between reports; suppressed when buffer non-empty or harness is busy.

**No `LLMService` in the pipeline.** This is the explicit Architecture I shape: the harness on the user's Mac is the LLM, accessed through `HarnessBridgeProcessor` → `HarnessAdapterClient`. The pipeline's job is to handle audio I/O, turn detection, interruption mechanics, and event routing.

### 4.4 Harness boundary — the load-bearing layer

This is the novel contribution and the reason this plan exists.

#### 4.4.1 Two-tier `HarnessEvent` union

Tier 1 = canonical cross-provider events. Tier 2 = `provider_event` envelope for everything provider-specific. Defined canonically in `protocol/schema/` (JSON Schema, see §4.4.6) and codegenned to TS + Python.

Tier 1 variants:
- `session_init` — sessionId, tools, model
- `text_delta` — streaming assistant text
- `reasoning_delta` — streaming reasoning/thinking text
- `assistant_message` — full assistant turn
- `tool_lifecycle` — `phase: "start" | "progress" | "complete"`, `name`, `tool_use_id?`, `input?`, `result?`
- `session_end` — `subtype: "success" | "error"`, `result?`, `cost_usd?`, `usage?`
- `error` — `message`
- `cancel_confirmed` — `correlation_id` of the cancelled turn

Tier 2:
- `provider_event` — `provider`, `kind`, `payload`, `raw`

Adapters never silently drop a wire event. Anything that doesn't map to Tier 1 is emitted as `provider_event`.

#### 4.4.2 `HarnessCommand` union (orchestrator → daemon)

The orchestrator's command surface to the daemon. This is also schema-defined; codegenned to both runtimes.

```
HarnessCommand =
  | { kind: "submit_text",
      correlation_id: str,
      target: str,
      payload: { text: str } }

  | { kind: "submit_with_steer",
      correlation_id: str,
      target: str,
      payload: {
        text: str,
        cancels_correlation_id: str   // the in-flight turn this preempts
      } }

  | { kind: "cancel",
      correlation_id: str,
      target: str,
      payload: {
        target_correlation_id: str
      } }
```

That is the *entire* command surface. Three kinds. No `append_context` — buffered injection happens inside the orchestrator's `DeferredUpdateBuffer` and is concatenated into the next `submit_text`.

The daemon's command allowlist enforces this exactly: any other `kind` value is rejected with a logged audit entry.

#### 4.4.3 `HARNESS_EVENT_CONFIGS` registry and voice-action semantics

Declarative `dict` keyed by canonical Tier-1 type or `"<provider>/<kind>"` for Tier 2.

```python
# pipecat/overwatch_pipeline/harness_router.py
from dataclasses import dataclass
from typing import Literal, Optional

VoiceAction = Literal["speak", "inject", "ui-only", "drop"]

@dataclass(frozen=True)
class HarnessEventConfig:
    voice_action: VoiceAction
    priority: int = 5                # 1 (low) — 10 (critical)
    coalesce_with: Optional[str] = None
    debounce_ms: Optional[int] = None
    provider: str = "*"

HARNESS_EVENT_CONFIGS: dict[str, HarnessEventConfig] = {
    # Tier 1 — cross-provider canonical
    "text_delta":               HarnessEventConfig("speak",   priority=8),
    "assistant_message":        HarnessEventConfig("speak",   priority=8, coalesce_with="text_delta"),
    "reasoning_delta":          HarnessEventConfig("inject",  priority=3),
    "tool_lifecycle:start":     HarnessEventConfig("speak",   priority=6),
    "tool_lifecycle:progress":  HarnessEventConfig("ui-only", priority=4),
    "tool_lifecycle:complete":  HarnessEventConfig("inject",  priority=4),
    "session_init":             HarnessEventConfig("inject",  priority=1),
    "session_end":              HarnessEventConfig("ui-only", priority=2),
    "error":                    HarnessEventConfig("speak",   priority=9),
    # Tier 2 — Claude Code provider-specific
    "claude-code/compact_boundary":  HarnessEventConfig("ui-only", priority=2,  provider="claude-code"),
    "claude-code/files_persisted":   HarnessEventConfig("inject",  priority=2,  debounce_ms=500, provider="claude-code"),
    "claude-code/rate_limit":        HarnessEventConfig("speak",   priority=7,  provider="claude-code"),
    "claude-code/auth_status":       HarnessEventConfig("speak",   priority=9,  provider="claude-code"),
    "claude-code/task_progress":     HarnessEventConfig("ui-only", priority=3,  provider="claude-code"),
    "claude-code/hook_response":     HarnessEventConfig("drop",    priority=1,  provider="claude-code"),
    "claude-code/prompt_suggestion": HarnessEventConfig("ui-only", priority=2,  provider="claude-code"),
    "claude-code/plugin_install":    HarnessEventConfig("ui-only", priority=3,  provider="claude-code"),
    "claude-code/tool_use_summary":  HarnessEventConfig("inject",  priority=3,  provider="claude-code"),
    # Tier 2 — Hermes
    "hermes/run_completed":          HarnessEventConfig("ui-only", priority=2,  provider="hermes"),
    # Tier 2 — Pi (populated as catch-all logger uncovers events; see §10)
    "pi/session_stats":              HarnessEventConfig("ui-only", priority=1,  provider="pi"),
    # Tier 2 — Overwatch-internal (notifications, monitor sources, scheduler events)
    "overwatch/monitor_fired":       HarnessEventConfig("inject",  priority=5,  provider="overwatch"),
    "overwatch/notification":        HarnessEventConfig("speak",   priority=6,  provider="overwatch"),
    "overwatch/scheduled_task_done": HarnessEventConfig("inject",  priority=4,  provider="overwatch"),
}

# Default policy when an event has no registry entry.
DEFAULT_VOICE_ACTION_DEV  = HarnessEventConfig("ui-only", priority=1)  # see + log
DEFAULT_VOICE_ACTION_PROD = HarnessEventConfig("drop",    priority=1)  # log-only
# Selected by env. Never `speak` — unknown events must never produce audio.
```

The registry is a `const`. No runtime mutation. Voice-action dispatch:

| `voice_action` | Behavior |
|---|---|
| `speak` | Event's text content is queued to TTS, gated by the inference gate. `coalesce_with` merges into one TTS utterance. `text_delta` events accumulate in a sentence buffer; `error` events preempt. |
| `inject` | Event payload appended to `DeferredUpdateBuffer`. On the next user-initiated turn, all buffered entries are concatenated as `<context kind="..." source="..." priority="...">...</context>` blocks and prepended to the user's text before submission to the harness. The harness sees this as part of the user's prompt. |
| `ui-only` | Forwarded to mobile via RTVI `server-message` `{ type: "harness_event", event: ... }`. Mobile renders as transcript pill / status row / collapsible card depending on event type. |
| `drop` | No-op. Single `debug` log line for audit. |

**Invariants enforced in `HarnessRouter.dispatch`:**

1. **Only user input ever produces a `submit_with_steer` or `cancel`.** Background events route through the registry's four `voice_action` values. The orchestrator never auto-cancels the harness based on its own events.
2. **Unknown events never produce audio.** The default policy is `ui-only` (dev) or `drop` (prod). Promoting an unknown event to `speak` requires an explicit registry entry.
3. **Every event is logged.** Even `drop` produces a structured debug log; unknown events produce an `unknown_event` log channel for registry-promotion review.

#### 4.4.4 `HarnessAdapterClient` and `HarnessBridgeProcessor`

The single most important abstraction in this plan. Decouples the orchestrator from the location of the harness adapter (relay vs localhost) and enables the Y2 migration without code change.

```python
# pipecat/overwatch_pipeline/harness_adapter_client.py
from typing import Protocol, AsyncIterator

class HarnessAdapterClient(Protocol):
    async def submit(self, command: HarnessCommand) -> None: ...
    def events(self) -> AsyncIterator[HarnessEvent]: ...

class RelayClient(HarnessAdapterClient):
    """Routes through CF Workers relay to user's Mac daemon. Uses per-user + per-session tokens."""

class LocalUDSClient(HarnessAdapterClient):
    """Routes via Unix domain socket on localhost. Used in Y2 self-host mode."""
```

Pick at startup via env (`HARNESS_ADAPTER_CLIENT=relay|local-uds`). The pipeline never imports either implementation directly — only the Protocol.

`HarnessBridgeProcessor` is the only place in the pipeline that emits `HarnessCommand`s. It receives:

- `UserMessageFrame` (from `user_aggregator` after STT + VAD + smart-turn for voice input)
- `UserTextInputFrame` (from a custom processor that decodes the mobile's typed-input RTVI server-message; bypasses VAD/mute via `TextInputBypassFirstBotMuteStrategy`)

For each, it consults `InferenceGateState`:

```
on user_input_frame(text, correlation_id):
    if gate.llm_in_flight:
        # User is interrupting an active turn.
        active_id = gate.current_correlation_id
        await drain_buffer_into(text)  # prepend any pending inject context
        await client.submit(submit_with_steer(text, cancels_correlation_id=active_id))
        gate.mark_cancel_pending(active_id)
    else:
        await drain_buffer_into(text)
        await client.submit(submit_text(text))
        gate.mark_llm_in_flight(correlation_id)
```

Voice and typed input flow through the *same* in-flight check. The only difference is whether the input bypassed the VAD/STT chain.

#### 4.4.5 Cancellation contract

Cancellation is a hard provider contract, not a best-effort. State machine:

| State | Meaning |
|---|---|
| `interrupt_requested` | Orchestrator decided to cancel a correlation_id |
| `audio_stopped` | Local TTS output torn down — UX gesture, not cancellation |
| `cancel_requested` | Daemon received `cancel` (or `submit_with_steer.cancels_correlation_id`) and dispatched provider-specific cancel |
| `cancel_confirmed` | Adapter confirmed harness has stopped (process exit, promise rejection, run-status change). Emitted as a Tier-1 `cancel_confirmed` event with the `correlation_id`. |
| `cancel_failed` | Confirmation timed out (2 s) or adapter reported irrecoverable failure |
| `stale_events_suppressed` | Any harness events with a cancelled `correlation_id` arriving after `cancel_confirmed` are dropped at the daemon (preferred) or at the orchestrator (defense-in-depth) |

Rules:

- **Correlation-id-scoped.** Cancel targets a specific `correlation_id`. Session-level cancel exists only as an adapter-internal fallback (e.g., if the harness lost track of the correlation_id mapping).
- **`cancel_confirmed` is required before a new turn fires for the same harness.** `InferenceGateState` blocks `_can_run_now()` while any correlation_id is in `cancel_pending`.
- **`cancel_failed` is a hard error.** The orchestrator emits `error{message: "cancel timeout"}`, the user audibly hears the failure, and the harness is marked "in unknown state" until the user explicitly resets via the mobile UI.
- **Stale-event suppression is by correlation_id**, not by timing. The daemon maintains a small ring buffer of recently-cancelled correlation_ids and drops matching events.

Per-provider implementation (verified during pre-flight certification, §10):

- **Pi**: `session.cancel(correlationId)` and an emitted `cancel_confirmed` when the cancelled `submit` promise rejects.
- **Claude Code CLI**: SIGTERM the subprocess; the process exit (code != 0 with our cancel-marker env var set) is `cancel_confirmed`. Verify `--include-partial-messages` doesn't leave the next `--continue` corrupted.
- **Hermes**: requires `POST /v1/runs/{id}/cancel` (verify exists); on success, emit `cancel_confirmed`. If endpoint unavailable, Hermes ships **experimental** (see §10).

#### 4.4.6 Protocol schema — single source of truth

The wire protocol is defined canonically in `/protocol/schema/` at repo root, JSON Schema 2020-12. Both runtimes consume the same definitions via codegen.

```
protocol/
├── schema/
│   ├── harness-event.schema.json           ← Tier 1 + Tier 2 union
│   ├── harness-command.schema.json         ← submit_text / submit_with_steer / cancel
│   ├── server-message.schema.json          ← orchestrator ↔ mobile RTVI extensions
│   └── envelope.schema.json                ← top-level envelope, includes protocol_version
├── codegen.config.json
└── README.md
```

- **TS generation**: `json-schema-to-typescript` → `packages/shared/src/protocol/types.generated.ts` (consumed by the daemon and by the relay).
- **Python generation**: `datamodel-code-generator` → `pipecat/overwatch_pipeline/protocol/types_generated.py` (pydantic models).
- **Wire validation**: `ajv` on the TS side, `pydantic` on the Python side. Inbound messages validated; outbound constructed via generated types so they cannot be malformed at the source.
- **Provider-specific passthrough**: `provider_event.payload` is `additionalProperties: true` — flexible to SDK churn.
- **Versioning**: top-level `protocol_version` field; daemon and orchestrator both refuse mismatched majors during `bot-ready` handshake.

Codegen runs in `npm run protocol:gen` (TS root) and `make protocol-gen` (Python). CI runs both and fails if generated files drift from schema.

### 4.5 Session-host daemon (`packages/session-host-daemon/`)

**Lifted from:** the existing `src/` directory minus voice code.

```
packages/session-host-daemon/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                            ← entry; launchd-supervised
│   ├── adapter-protocol/
│   │   ├── server.ts                       ← receives HarnessCommand from relay
│   │   ├── token-validator.ts              ← per-user + per-session token check
│   │   ├── command-allowlist.ts            ← rejects unknown command kinds
│   │   ├── audit-log.ts                    ← JSONL log of every cloud-originated command
│   │   ├── catch-all-logger.ts             ← env-gated JSONL of every wire event
│   │   ├── stale-suppression.ts            ← correlation_id ring buffer
│   │   └── cancellation.ts                 ← per-provider cancel dispatch + confirmation
│   ├── harness/                            ← lifted from src/harness/
│   │   ├── claude-code-cli.ts              ← + JSONL session-file fallback
│   │   ├── hermes-agent.ts
│   │   ├── hermes-events.ts                ← removes default-case drop;
│   │   │                                     emits provider_event for unmapped
│   │   ├── pi-coding-agent.ts
│   │   ├── providers/                      ← Composio-style PluginModule shape
│   │   ├── capabilities.ts                 ← declares per-provider voice-cert tier
│   │   ├── skill-installer.ts
│   │   └── types.ts                        ← shared HarnessEvent types
│   ├── shared/
│   │   └── protocol/                       ← imported from packages/shared (codegen output)
│   ├── tmux/                               ← lifted from src/tmux/, unchanged
│   ├── notifications/                      ← lifted; emits provider_event "overwatch/notification"
│   ├── scheduler/                          ← lifted; emits provider_event "overwatch/scheduled_task_*"
│   ├── extensions/                         ← lifted (skills system), unchanged
│   ├── tasks/                              ← lifted, unchanged
│   ├── agent/                              ← lifted, unchanged
│   ├── routes/                             ← REST + WS endpoints, narrowed
│   ├── relay-client/
│   │   └── client.ts                       ← existing realtime client, narrowed
│   ├── config.ts
│   └── index.ts
├── tests/
└── README.md
```

**What changes inside the daemon:**

- **Voice modules removed**: `src/orchestrator/turn-coordinator.ts`, `src/realtime/`, `src/stt/`, `src/tts/` are deleted.
- **Harness adapters refactored** to never silently drop events. Every wire event maps to either a Tier-1 `HarnessEvent` or a Tier-2 `provider_event`. The catch-all logger writes the raw wire event next to the typed event for audit.
- **Cancellation execution** module per provider. Each emits `cancel_confirmed` after provider acknowledges; 2 s timeout produces `cancel_failed`.
- **Adapter protocol server** — receives `HarnessCommand` from the cloud orchestrator, validates the per-user + per-session token, validates the command kind against the allowlist (`submit_text | submit_with_steer | cancel`), audit-logs, dispatches.
- **Stale-event suppression** — a small ring buffer of recently-cancelled correlation_ids; matching outbound events are dropped before they reach the relay.
- **Notifications, scheduler, monitor sources** — keep their existing implementations, but additionally emit `provider_event { provider: "overwatch", kind: "..." }` so they flow through the same registry.
- **Skills system** — orthogonal; unchanged.

### 4.6 Relay (`relay/`)

**Narrowed scope:**

- **What it carries:**
  - QR pair-time signaling (existing): mobile↔Mac key exchange.
  - Per-session orchestrator-Mac command/event channel (new): encrypted JSON, signed with per-user + per-session tokens. Cloud orchestrator authenticates as the "user X session Y" peer; Mac daemon trusts commands tagged with its paired user's per-user token + a valid per-session token.
- **What it no longer carries:**
  - Audio. Removed entirely. The `voice.audio` envelope is deleted.
  - Mobile↔orchestrator RTVI events. Those flow over the WebRTC data channel.
- **Encryption**: existing `nacl.box` per-pair encryption preserved.

The relay's CF Worker implementation drops most message types; protocol shrinks to ~1/3 of its current surface.

## 5. Codebase migration map

```
src/                                        →  packages/session-host-daemon/src/
├── orchestrator/turn-coordinator.ts        →  DELETE (replaced by cloud pipeline)
├── realtime/                               →  DELETE
├── stt/                                    →  DELETE (cloud uses DeepgramSTTService)
├── tts/                                    →  DELETE (cloud uses CartesiaTTSService)
├── harness/                                →  packages/session-host-daemon/src/harness/
├── shared/events.ts                        →  superseded by /protocol/schema/ + codegen
├── tmux/                                   →  packages/session-host-daemon/src/tmux/
├── notifications/                          →  packages/session-host-daemon/src/notifications/
├── scheduler/                              →  packages/session-host-daemon/src/scheduler/
├── extensions/                             →  packages/session-host-daemon/src/extensions/
├── tasks/                                  →  packages/session-host-daemon/src/tasks/
├── agent/                                  →  packages/session-host-daemon/src/agent/
├── routes/                                 →  packages/session-host-daemon/src/routes/
├── web/                                    →  packages/session-host-daemon/src/web/  (or DELETE if unused)
├── config.ts                               →  packages/session-host-daemon/src/config.ts
├── index.ts                                →  packages/session-host-daemon/src/index.ts

(new)                                          protocol/                       ← canonical JSON Schema + codegen
(new)                                          pipecat/                        ← Python orchestrator package
(new)                                          packages/session-host-daemon/   ← TS daemon package
(new)                                          packages/shared/src/protocol/   ← TS codegen output
```

End-state repo layout:

```
overwatch/
├── protocol/                       ← JSON Schema canonical protocol
├── pipecat/                        ← Python, deployed to Pipecat Cloud
├── packages/
│   ├── session-host-daemon/        ← TS, runs on user's Mac
│   ├── cli/                        ← TS, existing
│   └── shared/                     ← TS, existing crypto + types + protocol codegen
├── overwatch-mobile/               ← RN, refactored
├── relay/                          ← CF Workers, narrowed
├── docs/
├── install.sh
└── package.json                    ← workspace root
```

## 6. Onboarding (private alpha)

End-state user experience for a fresh install. We host the orchestrator; the user only installs the Mac daemon and the mobile app.

```
1. User runs: eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"
   Installs: Homebrew, node, tmux, pi, Overwatch into ~/.overwatch/app, session-host daemon binary.
   No Python install (cloud-hosted).

2. User runs: overwatch setup
   ├─ Choose harness (existing)
   ├─ Configure terminal (existing)
   ├─ Configure Pi auth (existing)
   ├─ Configure Deepgram credentials — using our provided alpha key
   ├─ NEW: Request orchestrator pairing token from our hosted endpoint
   │       (writes ORCHESTRATOR_TOKEN + ORCHESTRATOR_URL to daemon config)
   └─ Install bundled skill (existing)

3. User runs: overwatch start
   Launches launchd-supervised session-host daemon.
   Daemon connects to relay, registers with cloud orchestrator using token, prints QR.

4. User scans QR with overwatch-mobile.
   Phone ↔ Mac pair via existing nacl flow.
   Phone receives orchestrator URL + per-user token.

5. Phone connects WebRTC to Pipecat Cloud, presenting per-user token.
   Phone signs an ephemeral per-session token (HMAC of per-user token + session_id).
   Cloud orchestrator validates, opens HarnessAdapterClient session to user's Mac via relay.

6. User talks (voice) or types in InputBar (typed). End-to-end works.
```

**Distribution scope** — explicit:

- Soami + ~3–5 trusted testers receive the orchestrator pairing endpoint.
- No public open-signup. New testers are added by hand to the alpha allowlist.
- BYOK and self-host (Y2) remain valid code paths but aren't built into `install.sh`. They are documented in `docs/` for technical users who want to run the same code on their own Pipecat Cloud account or locally.

## 7. Trust model

**Two-token system, both bootstrapped from the existing nacl QR pairing.**

- **Per-user token** — long-term, stored on phone (secure storage) and Mac daemon. Created at QR-pair time, included in the daemon's payload to the cloud orchestrator on first connect.
- **Per-session token** — ephemeral, derived as `HMAC(per_user_token, session_id || timestamp)`. Computed by the phone at session start, presented to the cloud orchestrator. Expires when the WebRTC session closes.

**Daemon-side enforcement:**

- Every inbound `HarnessCommand` must carry both tokens; the daemon verifies the per-user token matches its paired user and the per-session token is HMAC-valid against a session_id within an active session window.
- **Command allowlist**: only `submit_text`, `submit_with_steer`, `cancel` accepted. Any other `kind` is rejected, audit-logged, and an `error` event returned.
- **Correlation_id required on every command.** Commands without one are rejected.
- **Audit log**: every cloud-originated command is appended to `~/.overwatch/audit.jsonl` with timestamp, command kind, correlation_id, target, and payload size (not full payload, to avoid logging user prompts). 30-day rotation.

**Re-pairing invalidates previous tokens.** Running `overwatch setup` again rotates the per-user token; old tokens are rejected by the daemon. The phone receives the new token via fresh QR.

**Failure modes and bounds:**

- Cloud breach scope: per-user tokens of currently paired users. Per-session tokens have a TTL (orchestrator-restart-resistant if the session is still alive, expire on session close). Bounded.
- Phone loss: re-pair from Mac, which rotates per-user token.
- Relay breach: cannot decrypt; sees ciphertext only.
- Orchestrator-issues-bad-command: command allowlist on daemon catches it; audit log shows the attempt.

This is deliberately scoped for private alpha. Hardening (full PKI, ephemeral key rotation, signed audit log, etc.) becomes its own plan if/when public distribution arrives.

## 8. Test strategy

### 8.1 Python orchestrator (`pipecat/tests/`)

Stack: `pytest>=8.4`, `pytest-asyncio` (`asyncio_mode = "auto"`), `pytest-timeout`. Real `asyncio.sleep` for time-sensitive tests with calibrated short intervals (50–300 ms).

**Critical test cases:**

1. **User-voice interrupt during in-flight turn.** ScriptedHarness streaming text; user voice transcript fires; assert `submit_with_steer` is emitted with the in-flight correlation_id, `cancel_confirmed` arrives, new turn starts, no events from cancelled turn reach TTS.
2. **User-typed interrupt during in-flight turn.** Same as above but via `UserTextInputFrame` from a server-message; assert identical behavior.
3. **Cancellation timeout.** ScriptedHarness ignores the cancel signal; assert `cancel_failed` after 2 s, audible error to user, gate stays blocked until user reset.
4. **Stale-event suppression.** Inject events with cancelled correlation_id after `cancel_confirmed`; assert dropped, never reach TTS or UI.
5. **OOB inject during active turn.** Monitor event arrives during in-flight turn; assert added to `DeferredUpdateBuffer`, no harness command emitted, no audio. On next user turn, assert buffer drained and prepended to `submit_text`.
6. **STT error not silently swallowed.** Mock `DeepgramSTTService` to throw; assert pipeline emits error frame, gate state resets to idle.
7. **Coordinator state after harness throws.** Mock `HarnessAdapterClient.submit` to throw; assert `gate.llm_in_flight = False`, next call succeeds.
8. **Concurrent inference-gate triggers — only one wins.** Two near-simultaneous user turns; assert exactly one inference fires.
9. **Registry routing fidelity.** For each `voice_action`, assert correct downstream behavior (`speak` → TTS frame, `ui-only` → server message, `drop` → no-op with log, `inject` → buffer entry).
10. **Unknown event default policy.** Inject an event with no registry entry in dev mode; assert `ui-only` + `unknown_event` log. Same in prod mode; assert `drop` + log. Never `speak` either way.
11. **Protocol schema validation.** Inbound malformed `HarnessEvent`; assert pydantic rejects, audit logs, doesn't crash.

**Test infrastructure:**

- `ScriptedHarness`: feeds a script of `[(text_delta, "..."), (tool_lifecycle, {...}), (assistant_message, "..."), (cancel_confirmed, ...), (session_end, "success")]` through a `HarnessAdapterClient` mock.
- `e2e_harness.py`: real `InferenceGateState` + real `HarnessRouter` + real `DeferredUpdateBuffer`, mocked transport boundaries.

### 8.2 Session-host daemon (`packages/session-host-daemon/tests/`)

Native `node --test`. New test cases:

- Adapter protocol server: receives valid `HarnessCommand`, dispatches, emits events.
- Per-user + per-session token validation: rejects commands with wrong/missing/expired tokens.
- Command allowlist: rejects non-`submit_text`/`submit_with_steer`/`cancel` kinds.
- Audit log: every cloud-originated command appears in JSONL output with required fields.
- Stale-event suppression: events with cancelled correlation_id are dropped at daemon.
- Per-adapter cancellation: `cancel` produces `cancel_confirmed` within 2 s for each shipped provider.
- Catch-all logger: every wire event (mocked) appears in JSONL output.
- Each adapter (`claude-code-cli`, `hermes-events`, `pi-coding-agent`): every documented wire event maps to either Tier-1 or `provider_event`; nothing silently dropped.

### 8.3 Mobile (`overwatch-mobile/tests/`)

Existing test stack. New tests:

- Single conversation store: assistant message finalizes derived `isAgentSpeaking`.
- Server-mute integration: `UserMuteStarted` from RTVI disables PTT.
- Spoken/unspoken cursor advances correctly on `bot-tts` events.
- Voice and typed input both produce identical orchestrator-side server-messages.

### 8.4 End-to-end

A test harness that boots the Python orchestrator (locally, against a mocked Daily transport), the session-host daemon (against a `ScriptedHarness`), and the mobile in-process simulation. Asserts the full path: simulated audio → STT → harness command → harness event → TTS frame → mobile, plus an interrupt scenario asserting `cancel_confirmed` propagation.

## 9. Observability

**Tracing — OpenTelemetry, both runtimes:**

- Python orchestrator: `opentelemetry-sdk` with `OTLPSpanExporter`. Manual spans on:
  - `inference_gate.acquire`
  - `harness_router.dispatch` (with `voice_action`, `priority`, `provider`, `kind` attributes)
  - `harness_bridge.submit`
  - `harness_adapter_client.submit`
  - `cancellation.wait_for_confirmation`
  - `cartesia_tts.synthesize`
  - `deepgram_stt.transcribe`
- TS daemon: `@opentelemetry/sdk-node`. Manual spans on:
  - `adapter_protocol.handle_command`
  - `cancellation.execute` (per-provider)
  - each `HarnessAdapter` event emission

Spans correlate via `correlation_id` propagated through `HarnessCommand`. Trace flow: mobile session → Pipecat Cloud span → relay carry → daemon span → adapter span → events flow back annotated with parent trace.

**Metrics — Prometheus-compatible:**

- Python: `prometheus_client` exposing
  - `voice_stt_latency_seconds` (histogram)
  - `voice_tts_ttfa_seconds` (histogram)
  - `voice_inference_gate_wait_seconds` (histogram, by `reason`)
  - `voice_interruption_count` (counter)
  - `voice_cancel_confirmed_latency_seconds` (histogram, by `provider`)
  - `voice_cancel_failed_total` (counter, by `provider`)
  - `harness_event_count{provider, kind, voice_action}` (counter)
  - `harness_command_latency_seconds` (histogram, by `target`, `kind`)
  - `unknown_event_count{provider, kind}` (counter — drives registry-promotion review)
- TS daemon: `prom-client` for command throughput + per-adapter event rate + cancel-confirmation latency.
- Pipecat Cloud's built-in metrics consumed via their exporter.

**Error tracking — Sentry:**

- Both runtimes. Trace context attached.

**Logs — structured:**

- Python: `loguru` configured for JSON output. Per-component prefixes (`router`, `gate`, `bridge`, `tts`, `stt`, `cancel`).
- TS: `pino` with structured `traceId` field on every voice-loop log.

**No "instrument-only-on-entry-points" anti-pattern.** Every async boundary in the voice path is instrumented from day one.

## 10. Pre-flight provider certification

A provider is **voice-certified** for v1 only if it passes all five checks. A provider can ship as **experimental** if it passes events + session_end + survives interrupts but fails confirmed cancellation; experimental providers are usable but flagged in mobile UI as "interruption may be unreliable."

| # | Check | Test method |
|---|---|---|
| 1 | No silently dropped wire events | Catch-all logger run for ≥30 min of real use; every wire event maps to Tier-1 or `provider_event`. |
| 2 | Confirmed active-turn cancellation | Submit a long-running turn; cancel mid-stream; assert `cancel_confirmed` emitted within 2 s; assert no events with cancelled correlation_id afterward. |
| 3 | `inject` (deferred buffered prepend) compatible | All providers pass automatically — buffered injection is a string concat in the orchestrator. Only verify the harness sees the prepended text in the next prompt. |
| 4 | Reliable `session_end` emission | Every successful and failed run emits exactly one `session_end` with correct `subtype`. |
| 5 | Survives interrupted turns | Cancel mid-turn N=10 times; assert next user turn produces a clean response (no carry-over context corruption). |

**Status of each provider for v1 ship:**

- **Pi**: target voice-certified. Verification work: enumerate full `session.subscribe()` event taxonomy; verify `session.cancel()` emits a confirmation.
- **Claude Code CLI**: target voice-certified. Verification work: SIGTERM cleanup behavior with `--include-partial-messages`; JSONL session-file fallback for reattach.
- **Hermes**: ships **experimental** unless `POST /v1/runs/{id}/cancel` (or equivalent) lands during the implementation window. Mobile UI flags Hermes as experimental in the harness picker.

A provider failing check 1, 4, or 5 is **not in the registry** and not exposed in the mobile harness picker. The user can still launch it via CLI as before; it just doesn't participate in voice mode.

The five-check matrix runs on every PR that touches an adapter, plus on a nightly soak.

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pipecat Cloud RN client `client-ready` handshake bug (#4086) | Med | High (no audio) | Implement retry + 5 s timeout from day one; degraded-mode UI if it persists |
| Cloud orchestrator outage when our Pipecat Cloud account is impaired | Low | High (alpha down) | Document self-host (Y2) as a fallback the user can switch to in <30 min; expose `ORCHESTRATOR_URL` config |
| One provider fails cancellation cert | Med | Med | Experimental tier ships it behind a flag; voice-certified bar holds for the others |
| Hermes cancel endpoint never lands | Med | Low | Ship Hermes experimental; degraded-mode UI in mobile picker |
| Cartesia API instability or pricing change | Low | Med | Pipecat's `TTSService` interface is uniform; swap to ElevenLabs or Deepgram as a config flip if needed |
| Per-session token desync after orchestrator restart | Low | Low | Phone re-derives per-session token on reconnect; orchestrator stateless across restarts |
| Python knowledge gap on the team | Med | Low | Pipecat's API surface is small; no advanced async patterns required beyond what gradient-bang demonstrates |
| Daemon → orchestrator latency over relay degrades voice loop | Low | Med | Hot path is audio + STT + TTS, all phone↔cloud. Relay carries only command + event JSON; latency is on harness control path, not voice |
| Catch-all logger reveals upstream SDK churn faster than we can keep up | Med | Low | Two-tier union absorbs new events as `provider_event`. Default policy `drop` (prod) prevents accidents. Registry promotion is a regular maintenance activity. |
| Schema codegen drift (TS and Python out of sync with `protocol/schema/`) | Low | Med | CI runs codegen and fails the build on drift |

## 12. What this plan delivers

- Mobile app refactored onto Pipecat RN client with single conversation store, server-authoritative mute, spoken/unspoken cursor, deferred bot-message finalization, three-state transport indicator, mode toggle for PTT vs always-listening. Voice and typed input flow through one orchestrator-side bridge.
- Cloud orchestrator: Python pipecat package deployed to Pipecat Cloud as a Docker image, hosted by us. Pipeline is the gradient-bang shape adapted for the no-LLMService Architecture I.
- The novel piece: two-tier `HarnessEvent` union + `HARNESS_EVENT_CONFIGS` registry + `HarnessAdapterClient` interface with `RelayClient` implementation + `submit_text`/`submit_with_steer`/`cancel` command surface + correlation-id-scoped cancellation contract. Every harness event mapped or surfaced as `provider_event`; nothing silently dropped.
- Canonical JSON Schema in `/protocol/schema/` with TS + Python codegen and wire validation on both ends.
- Session-host daemon as a TS package: existing `src/` lifted, voice modules deleted, harness adapters refactored to never drop events, adapter protocol server with token validation + command allowlist + audit log + stale suppression added, catch-all logger added, per-provider cancellation execution added.
- Relay narrowed to signaling + harness command/event bridge; no more audio.
- Tests: ~30 unit + integration tests across the two runtimes covering interruption, cancellation contract, queueing, OOB injection, registry routing, adapter coverage.
- Observability: OTel tracing + Prometheus metrics + Sentry both runtimes from day one, with full hot-path coverage including cancellation latency.
- Pre-flight five-check certification matrix gates v1 ship; voice-certified vs experimental tiers documented per provider.

## 13. What is not in this plan

(See §2 for the canonical non-goals list. Restating boundaries so reviewers don't ask.)

- No voice-loop LLM. The HarnessRouter is purely registry-driven. Architecture II is a separate future plan.
- No multi-Mac orchestration. The `HarnessCommand.target` field is multi-target ready but only one Mac's address is wired up at setup.
- No self-hosted pipecat distribution work. Documented as a config-flip escape hatch; not built into `install.sh`.
- No BYOK install path. Same — documented only.
- No user-account / billing surface. Hosted-by-us is private-alpha-free; monetization is its own future plan.
- No voice picker UI. One default Cartesia voice ships; settings option is a future detail.
- No PSTN, SIP, or telephony bridges.
- No multi-tenant production hardening (full PKI, ephemeral key rotation, signed audit log). Sufficient for private alpha; future plan if/when public.
- No auto-cancellation by the orchestrator. Only user input ever produces `submit_with_steer` or `cancel`.
- No immediate-run injection (`run_llm=True` style). Only deferred buffered prepend.

---

## Appendix A — File-level checklist

For implementation tracking. Each line is a discrete unit of work.

### Protocol (`/protocol/`)

- [ ] `protocol/schema/envelope.schema.json`
- [ ] `protocol/schema/harness-event.schema.json` (Tier 1 + Tier 2)
- [ ] `protocol/schema/harness-command.schema.json` (`submit_text`, `submit_with_steer`, `cancel`)
- [ ] `protocol/schema/server-message.schema.json` (RTVI extensions)
- [ ] `protocol/codegen.config.json`
- [ ] `npm run protocol:gen` script (TS via `json-schema-to-typescript`)
- [ ] `make protocol-gen` (Python via `datamodel-code-generator`)
- [ ] CI step: regenerate and fail on drift
- [ ] `protocol/README.md`

### Python orchestrator (`pipecat/`)

- [ ] `pyproject.toml`, `Dockerfile`, `pcc-deploy.toml` scaffolding
- [ ] `overwatch_pipeline/bot.py` — pipeline composition + Pipecat Cloud entrypoint
- [ ] `overwatch_pipeline/inference_gate.py` — `InferenceGateState` + `PreLLMInferenceGate` + `PostLLMInferenceGate` (with cancel_pending tracking)
- [ ] `overwatch_pipeline/harness_router.py` — registry, voice-action dispatch, default policies, invariants
- [ ] `overwatch_pipeline/harness_bridge.py` — user voice + typed input → command emission
- [ ] `overwatch_pipeline/harness_adapter_client.py` — Protocol + `RelayClient` impl + `LocalUDSClient` stub
- [ ] `overwatch_pipeline/deferred_update_buffer.py` — buffered inject prepend
- [ ] `overwatch_pipeline/cancellation.py` — cancel-confirmed wait + timeout
- [ ] `overwatch_pipeline/idle_report.py`
- [ ] `overwatch_pipeline/say_text_voice_guard.py`
- [ ] `overwatch_pipeline/frames.py` — `UserTextInputFrame`, `HarnessEventFrame`, `HarnessCommandFrame`
- [ ] `overwatch_pipeline/voices.py` — Cartesia voice registry
- [ ] `overwatch_pipeline/auth/token_validator.py` — per-user + per-session token check
- [ ] `overwatch_pipeline/protocol/types_generated.py` (codegen output)
- [ ] `overwatch_pipeline/observability/{otel.py, metrics.py, logging_config.py}`
- [ ] Tests: `test_inference_gate.py`, `test_harness_router.py`, `test_cancellation_contract.py`, `test_deferred_buffer.py`, `test_idle_report.py`
- [ ] Integration: `e2e_harness.py`, `test_voice_relay_integration.py`

### Session-host daemon (`packages/session-host-daemon/`)

- [ ] Package scaffolding (`package.json`, `tsconfig.json`, workspace wiring in root)
- [ ] Move `src/harness/`, `src/tmux/`, `src/notifications/`, `src/scheduler/`, `src/extensions/`, `src/tasks/`, `src/agent/`, `src/routes/`, `src/web/`, `src/config.ts`, `src/index.ts`
- [ ] Import generated protocol types from `packages/shared/src/protocol/`
- [ ] Refactor `src/harness/claude-code-cli.ts` — emit `provider_event` for unmapped wire events; add JSONL session-file fallback
- [ ] Refactor `src/harness/hermes-events.ts` — remove default-case drop; emit `provider_event`
- [ ] Refactor `src/harness/pi-coding-agent.ts` — emit `provider_event` for thinking-deltas, tool_execution_end, extension events; call `getSessionStats()` post-turn
- [ ] `src/adapter-protocol/server.ts` — receive `HarnessCommand`, dispatch, emit events
- [ ] `src/adapter-protocol/token-validator.ts` — per-user + per-session token check
- [ ] `src/adapter-protocol/command-allowlist.ts`
- [ ] `src/adapter-protocol/audit-log.ts` — JSONL of every cloud-originated command, 30-day rotation
- [ ] `src/adapter-protocol/catch-all-logger.ts`
- [ ] `src/adapter-protocol/stale-suppression.ts` — correlation_id ring buffer
- [ ] `src/adapter-protocol/cancellation.ts` — per-provider cancel dispatch + `cancel_confirmed` emission with 2 s timeout
- [ ] `src/harness/capabilities.ts` — declares per-provider voice-cert tier
- [ ] Integrate notification + scheduler + monitor sources to emit `provider_event { provider: "overwatch", ... }`
- [ ] Update `cli/` for orchestrator pairing token in `overwatch setup`
- [ ] Tests for adapter-protocol server, token validation, command allowlist, audit log, cancellation, catch-all logger, stale suppression
- [ ] Delete `src/orchestrator/`, `src/realtime/`, `src/stt/`, `src/tts/`

### Mobile (`overwatch-mobile/`)

- [ ] Add deps: `@pipecat-ai/client-js`, `@pipecat-ai/react-native-daily-transport`, `@daily-co/react-native-daily-js`, `@daily-co/react-native-webrtc`, `@react-native-async-storage/async-storage`, `react-native-background-timer`, `react-native-get-random-values`
- [ ] Delete `modules/fast-recorder/` and `modules/streaming-audio/`
- [ ] Create `src/hooks/use-pipecat-session.ts` (single hook over `PipecatClient`)
- [ ] Delete `src/hooks/{use-audio-player, use-audio-recorder, use-overwatch-turn, use-realtime-connection}.ts`
- [ ] Create `src/stores/conversation.ts` (single Zustand store, derived speaking state)
- [ ] Refactor `src/components/PTTButton.tsx` to consume RTVI server-mute
- [ ] Refactor `src/components/InputBar.tsx` to send `user_text` server-message (typed path)
- [ ] Refactor `src/components/TranscriptView.tsx` to derived state
- [ ] Implement spoken/unspoken cursor in `MessageContent`
- [ ] Implement deferred 1500 ms bot-message finalization in conversation store
- [ ] Implement three-state transport hook
- [ ] Always-listening mode toggle in settings
- [ ] Mobile UI tag for experimental-tier providers in harness picker
- [ ] Update QR pairing flow to receive orchestrator URL + per-user token
- [ ] Phone-side per-session token derivation (HMAC) at session start
- [ ] Tests

### Relay (`relay/`)

- [ ] Delete `voice.audio` envelope handler
- [ ] Add orchestrator-as-peer authentication path
- [ ] Narrow message types to: pairing, signaling, harness command, harness event, error
- [ ] Tests for orchestrator-mediated harness command/event routing

### Repo / infra

- [ ] Workspace restructure: `packages/session-host-daemon/`, `pipecat/` (Python, separate), `protocol/` (root)
- [ ] Update `install.sh` to drop voice-related Mac-side install steps
- [ ] Update `overwatch setup` flow per §6
- [ ] Update `AGENTS.md` and `README.md` for new architecture and private-alpha framing
- [ ] Update `docs/architecture/INDEX.md` to reference this plan
- [ ] Move/supersede notes on `docs/plans/pipecat-voice-mode-2026-04-09.md`
