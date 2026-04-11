# Plan: Pipecat Real-Time Voice Mode

**Date:** 2026-04-09
**Status:** Proposed
**Related Docs:** [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [react-native-app-plan-2026-04-08.md](react-native-app-plan-2026-04-08.md)
**Reuses architecture from:** `/Users/soami/Desktop/code/int/halo-2/`

## Outcome

A hands-free conversation mode for the Overwatch mobile app. The user can talk to the orchestrator agent without pressing any buttons — speak naturally, get interrupted, hear responses in real time. Push-to-talk remains as an alternative mode.

## Why Pipecat

The current push-to-talk flow is HTTP request/response: record → upload → STT → agent → TTS → stream back. Every turn has the full round-trip latency. Pipecat gives us:

- **Real-time streaming**: STT transcribes as the user speaks, TTS starts playing before the agent finishes generating
- **Barge-in**: user can interrupt the agent mid-sentence
- **VAD-based turn detection**: no button press needed, Silero VAD detects speech start/stop
- **Proven pattern**: halo-2 already runs this exact architecture in production

## Architecture

### Where things run

Everything runs on the **Mac**. The iPhone is a thin audio client — it sends and receives audio over WebRTC but does no processing. This is different from halo-2 where the Pi was both the audio device and the Pipecat host. Here the roles are split:

- **iPhone**: microphone + speaker only. Connects via WebRTC, sends raw audio, receives TTS audio.
- **Mac** (your laptop/desktop): runs all three services over Tailscale.

```
┌─────────────────────┐
│   iPhone (thin)     │
│   WebRTC client     │
│   mic + speaker     │
└────────┬────────────┘
         │ Tailscale (WireGuard)
         │ WebRTC audio stream
         │
┌────────▼────────────────────────────────────────┐
│   Mac (all services)                            │
│                                                 │
│   ┌─────────────────────────────────────────┐   │
│   │  Pipecat Voice Service  :43102          │   │
│   │  (Python/FastAPI)                       │   │
│   │  Deepgram STT (streaming)               │   │
│   │  OverwatchBridgeLLMService              │   │
│   │  Deepgram Aura TTS (streaming)          │   │
│   │  SmallWebRTC transport                  │   │
│   └──────────────┬──────────────────────────┘   │
│                  │ SSE (bridge contract)         │
│                  │ localhost:8787                 │
│   ┌──────────────▼──────────────────────────┐   │
│   │  Overwatch Backend  :8787               │   │
│   │  (Node/Hono, existing)                  │   │
│   │  /api/v1/bridge (new)                   │   │
│   │  /api/v1/voice-turn (existing PTT)      │   │
│   │  /api/v1/text-turn (existing)           │   │
│   │  pi-coding-agent (persistent session)   │   │
│   └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Three services, two protocols

1. **iPhone** ↔ **Pipecat voice service** (Mac:43102): WebRTC audio + data channel over Tailscale
2. **Pipecat voice service** ↔ **Overwatch backend** (Mac:8787): SSE bridge over localhost

The iPhone never talks to the Overwatch backend directly in conversation mode — all audio flows through the Pipecat service. In push-to-talk mode, the iPhone still talks directly to the Overwatch backend over HTTP as it does today.

### Comparison with halo-2

| | Halo-2 (Pi) | Overwatch |
|---|---|---|
| Audio device | Pi (mic + speaker) | iPhone (mic + speaker) |
| Pipecat host | Pi (same device) | Mac (separate device) |
| Transport | Local audio buffers (Pi) / SmallWebRTC (browser) | SmallWebRTC (iPhone → Mac) |
| STT | Deepgram (Pi) / Whisper MLX (cloud) | Deepgram (Mac) |
| LLM bridge | SSE to Hermes Bridge | SSE to Overwatch backend |
| TTS | Deepgram Aura → LocalTTSPlayer (Pi) / WebRTC (browser) | Deepgram Aura → WebRTC (iPhone) |

The Overwatch backend remains the main Node/Hono control plane, but the speech-provider assumptions in this plan should stay aligned with the current backend choice of Deepgram for both STT and TTS. We still add a bridge endpoint that the Pipecat service calls.

## Bridge Contract

Copied from halo-2's `shared/schemas/bridge-contract.ts` with minimal changes.

### Request

```
POST /api/v1/bridge
Content-Type: application/json

{
  "sessionId": "string",    // persistent across turns
  "text": "string",         // user utterance from STT
  "timestamp": "ISO 8601"
}
```

### Response: SSE stream

```
event: token
data: {"text": "Sure, let me"}

event: token
data: {"text": " check that"}

event: tool_call
data: {"name": "bash", "narration": "Running the command now"}

event: tool_result
data: {"name": "bash", "output": "..."}

event: done
data: {}
```

### Event types

| Event | Payload | Notes |
|---|---|---|
| `token` | `{ text }` | Streaming assistant text. Fed to TTS immediately. |
| `tool_call` | `{ name, narration? }` | Agent is executing a tool. Optional narration is spoken. |
| `tool_result` | `{ name, output? }` | Tool finished. |
| `done` | `{}` | Turn complete. |
| `error` | `{ message }` | Fatal error. |

### Timeouts

- Stream timeout: 30s (entire response)
- Inter-event timeout: 10s (gap between events)
- Barge-in: client closes the HTTP connection → backend AbortSignal fires

### Cancellation

The Pipecat service closes the SSE connection when the user starts speaking (barge-in). The backend's `AbortSignal` fires and the pi-coding-agent turn is cancelled. Same pattern as the current push-to-talk cancellation.

## Components to Build

### 1. Bridge endpoint on existing backend

A new route `/api/v1/bridge` on the Overwatch Node backend. It:
- Receives `{ sessionId, text }` as JSON
- Forwards `text` to the pi-coding-agent harness via `runTurn()`
- Streams back SSE events: `token` (from `text_delta`), `tool_call`, `done`
- Does NOT run TTS — the Pipecat service handles TTS directly

This is essentially the existing `text-turn` route but without the TTS layer and with the bridge event format.

### 2. Pipecat voice service (Python)

New directory: `overwatch-voice/`

Copy halo-2's `cloud/pipecat-service/` structure and adapt:

```
overwatch-voice/
  src/
    main.py                    — FastAPI app, WebRTC signaling, pipeline setup
    services/
      overwatch_bridge_llm.py  — OverwatchBridgeLLMService (adapted from HermesBridgeLLMService)
  requirements.txt
  Dockerfile
```

Pipeline chain (same as halo-2 cloud, updated to match the current Overwatch backend speech stack):
```python
transport.input()
  → Deepgram STT (nova-3, streaming, 300ms endpointing)
  → user_aggregator
  → OverwatchBridgeLLMService (SSE bridge to Node backend)
  → Deepgram Aura TTS (24kHz linear16 websocket streaming)
  → transport.output()
  → assistant_aggregator
```

Key differences from halo-2:
- Bridge URL points to `http://localhost:8787/api/v1/bridge` (Overwatch backend)
- No DeviceCommander / LED intents / audio chimes
- No speaker verification
- No wakeword detection
- Simpler — just the voice pipeline

### 3. React Native client integration

Add `@pipecat-ai/react-native-small-webrtc-transport` to the mobile app.

New components:
- `src/hooks/use-voice-session.ts` — manages WebRTC connection to the Pipecat service
- `src/components/VoiceModeToggle.tsx` — switch between push-to-talk and conversation mode
- Update `_layout.tsx` to support both modes

In conversation mode:
- No PTT button needed — just a "connected" indicator and a mute button
- Transcript still shows in the same TranscriptView
- User can tap to interrupt (closes data channel briefly)

### 4. Shared types

```
overwatch-mobile/src/types/bridge.ts
```

TypeScript types for the bridge contract, copied from halo-2's `shared/schemas/bridge-contract.ts`.

## What We Copy from Halo-2

| Source | Target | Changes |
|---|---|---|
| `cloud/pipecat-service/src/main.py` | `overwatch-voice/src/main.py` | Remove announce endpoint, simplify |
| `cloud/pipecat-service/src/services/hermes_bridge_llm.py` | `overwatch-voice/src/services/overwatch_bridge_llm.py` | Remove DeviceCommander, point at Overwatch bridge URL |
| `shared/schemas/bridge-contract.ts` | `overwatch-mobile/src/types/bridge.ts` | Remove speaker ID, simplify |

## What We DON'T Need from Halo-2

- Pi state machine (no hardware)
- Wakeword detection (no ambient listening)
- Speaker verification (single user)
- Device commands / LED intents (no hardware)
- LocalTTSPlayer (audio goes over WebRTC)
- SpeechActivityBridge (standard VAD is enough)
- Eight Sleep / Sonos integrations
- Pi-agent service

## VAD Configuration

Copy halo-2's Silero VAD settings as a starting point:
- Confidence: 0.7
- Start speech: 0.2s
- Stop speech: 0.6s
- Min volume: 0.6

Tune based on testing — phone mics may need different thresholds than Pi hardware.

## Connectivity

Both services run on the Mac. The phone connects to whichever service it needs via Tailscale.

**Conversation mode** (Pipecat):
```
iPhone → Tailscale → Mac:43102 (WebRTC signaling + audio)
Mac:43102 → localhost:8787/api/v1/bridge (SSE, internal)
```

**Push-to-talk mode** (existing, unchanged):
```
iPhone → Tailscale → Mac:8787 (HTTP voice-turn / text-turn)
```

The user's Tailscale IP (e.g. `100.89.176.59`) is already configured in the app. Conversation mode will use the same IP on a different port. Both services must be running for conversation mode; only the Node backend is needed for push-to-talk.

## Build Sequence

### Phase 1: Bridge endpoint

- Add `/api/v1/bridge` route to the Overwatch Node backend
- Same pi-coding-agent harness, but outputs bridge SSE events (token/tool_call/done) instead of text_delta/audio_chunk
- No TTS — just text events
- Test with curl

### Phase 2: Pipecat voice service

- Create `overwatch-voice/` with Python/FastAPI
- Copy and adapt HermesBridgeLLMService from halo-2
- Pipeline: Deepgram STT → OverwatchBridgeLLMService → Deepgram Aura TTS → SmallWebRTC output
- Test with halo-2's web test client (browser WebRTC)

### Phase 3: React Native integration

- Add `@pipecat-ai/react-native-small-webrtc-transport` and `@daily-co/react-native-webrtc`
- Build `use-voice-session.ts` hook
- Add conversation mode toggle to the app
- Wire transcript display to data channel messages
- Native rebuild required (WebRTC native code)

### Phase 4: Polish

- Barge-in handling (interrupt agent mid-sentence)
- Reconnection on WebRTC drop
- Audio focus management (conversation mode vs push-to-talk)
- VAD threshold tuning for phone mic
- Visual indicators for VAD state (listening, speaking, processing)

## Risks

1. **SmallWebRTC on React Native** — `@pipecat-ai/react-native-small-webrtc-transport` is relatively new (v1.6.0). May have edge cases on iOS. Halo-2 uses it for the browser client, not React Native.
2. **Two Python + Node services** — adds operational complexity. Both must be running for conversation mode. Push-to-talk still works with just the Node backend.
3. **Audio session conflicts** — switching between push-to-talk (recording mode) and conversation mode (WebRTC) may fight over the iOS audio session. Need careful audio session management.
4. **Latency over Tailscale** — WebRTC over Tailscale adds a hop vs direct LAN. Should be fine for Tailscale's WireGuard mesh but worth testing.
5. **pi-coding-agent session sharing** — both push-to-talk and conversation mode hit the same agent session. Need to ensure the bridge endpoint uses the same persistent session as the existing endpoints.

## Not in Scope

- Android support
- Wake word detection on phone
- Multi-user / multi-device sessions
- Cloud deployment of the Pipecat service
- Recording / playback of conversations
