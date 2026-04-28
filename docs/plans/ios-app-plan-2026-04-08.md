# Plan: Overwatch iOS App

**Date:** 2026-04-08
**Status:** Superseded by [react-native-app-plan-2026-04-08.md](react-native-app-plan-2026-04-08.md)
**Related Docs:** [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [../architecture/001-backend-architecture.md](../architecture/001-backend-architecture.md)

## Outcome

A native Swift iOS app that connects to the Overwatch backend over Tailscale, providing push-to-talk voice control and text input for the orchestrator agent, with streaming transcript display and TTS audio playback.

## Why Native Swift

- The core challenge is real-time streaming PCM audio playback. AVAudioEngine gives direct buffer-level control, which browser APIs and React Native audio abstractions fight against.
- The UI is one screen — SwiftUI handles it trivially. A framework adds overhead with no benefit.
- Push notifications, background audio, and audio session management are first-class in native iOS.
- We already hit persistent Safari AudioContext issues with the web frontend. Native solves this cleanly.

## Security Model

v1 is explicitly a single-user tool on a trusted personal Tailnet. Tailscale device authentication is the only authorization boundary — if your device is on the Tailnet, it can reach the backend. There is no user auth, no tokens, no sessions.

This is deliberate for v1. The broader product vision (002-product-vision.md) calls for auth and session management, but that is a v2 concern for when the system becomes distributable. This plan should not be read as the long-term security posture.

## Connectivity

The iOS app connects directly to the Overwatch backend over Tailscale. No relay server, no SSH tunneling, no encryption layer needed — Tailscale handles NAT traversal, WireGuard encryption, and device authentication.

The app stores the Overwatch backend URL (e.g., `http://100.x.x.x:8787`) as a user-configurable setting. For v1, the user enters their Tailscale IP manually. Future versions could use Tailscale's device discovery API or mDNS.

```
iPhone → Tailscale (WireGuard) → Mac:8787 (Overwatch backend)
                                    ├── STT (Deepgram)
                                    ├── Agent (pi-coding-agent)
                                    ├── TTS (Deepgram Aura)
                                    └── tmux control (future)
```

## Backend Contract

The iOS app is a thin client. It uses two existing backend endpoints:

### POST /api/v1/voice-turn
- Request: `multipart/form-data` with `audio` field (recorded audio blob)
- Response: SSE stream

### POST /api/v1/text-turn
- Request: `application/json` with `{ "text": "..." }`
- Response: Same SSE stream (minus the `transcript` event)

### GET /health
- Used for connection status checking

### SSE stream events

The pi-coding-agent harness emits these events:

| Event | Guaranteed | Payload | Notes |
|---|---|---|---|
| `transcript` | voice-turn only | `{ text }` | User's transcribed speech |
| `text_delta` | yes | `{ text }` | Streaming assistant token. Multiple per turn, may arrive in batches separated by tool calls |
| `tool_call` | when tools used | `{ name }` | Agent is executing a tool |
| `audio_chunk` | best-effort | `{ base64, mimeType }` | PCM s16le 24kHz. TTS may die mid-turn (e.g. WebSocket timeout during tool call) |
| `tts_error` | on TTS failure | `{ message }` | TTS failed, text stream continues |
| `error` | on harness error | `{ message }` | Fatal error |
| `done` | yes | `{}` | Turn complete |

**`assistant_message` is NOT guaranteed.** The pi-coding-agent harness does not emit a final assembled message. The client must own the `text_delta` reduction logic: accumulate deltas into an in-progress assistant message, finalize it on `tool_call` or `done`, and start a new message when deltas resume after a tool call.

### Audio format
- `audio_chunk` events contain base64-encoded PCM s16le at 24000 Hz
- The app must decode base64, convert s16le to float, and feed into AVAudioPlayerNode

### Turn cancellation

The backend aborts STT, harness, and TTS work when the client disconnects the HTTP request. The iOS app cancels a turn by calling `.cancel()` on the Swift concurrency `Task` that owns the `URLSession.bytes(for:)` call. Task cancellation propagates to the URLSession request, which closes the connection. The backend's `AbortSignal` fires and all pipeline work stops.

There is no explicit turn ID or cancel API. Cancellation is connection-scoped. The app must ensure state isolation per turn: discard any SSE events that arrive between calling cancel and starting the next turn.

## App Architecture

### Project structure

```
OverwatchApp/
  OverwatchApp.swift          — App entry point
  Models/
    AppState.swift             — Observable state: connection, turn status, transcript
    Message.swift              — Transcript message model (user, assistant, tool_call, error)
  Services/
    OverwatchClient.swift      — HTTP client: voice-turn, text-turn, health check
    SSEParser.swift            — Parse SSE stream from URLSession bytes
    AudioRecorder.swift        — AVAudioEngine mic recording → compressed audio buffer
    AudioPlayer.swift          — Decode base64 PCM → AVAudioPlayerNode streaming playback
  Views/
    ContentView.swift          — Main screen layout
    TranscriptView.swift       — Scrolling message list
    InputBar.swift             — Text input + send button
    PTTButton.swift            — Push-to-talk button with recording/processing/playing states
    StatusBar.swift            — Connection indicator + harness label
    SettingsView.swift         — Backend URL configuration
  Info.plist                   — Microphone usage description
```

### Key components

**AppState** (ObservableObject)
- `connectionStatus`: disconnected / connected / error
- `turnState`: idle / recording / processing / playing
- `messages`: array of Message (user text, assistant text, tool calls, errors)
- `pendingAssistantText`: String — accumulates `text_delta` events into an in-progress assistant message. On `tool_call` or `done`, the pending text is finalized into a Message and reset. On new `text_delta` after a `tool_call`, a new pending message starts. This is the same reducer pattern used in the web frontend.
- `activeTurnTask`: reference to the current Swift concurrency `Task`, used for cancellation via `task.cancel()`. Since the client uses `URLSession.bytes(for:)` with structured concurrency, cancellation propagates through the async context — the URLSession request is automatically cancelled when the Task is cancelled.
- `backendURL`: stored in UserDefaults

**OverwatchClient**
- `checkHealth(baseURL:)` → verifies backend is reachable
- `sendVoiceTurn(baseURL:, audioData:)` → POST multipart, returns AsyncStream of SSE events
- `sendTextTurn(baseURL:, text:)` → POST JSON, returns AsyncStream of SSE events
- Uses `URLSession.bytes(for:)` for streaming SSE responses

**SSEParser**
- Consumes `URLSession.AsyncBytes`
- Parses `event:` and `data:` lines
- Yields typed `SSEEvent` values: `.transcript(String)`, `.textDelta(String)`, `.toolCall(String)`, `.audioChunk(base64: String, mimeType: String)`, `.ttsError(String)`, `.error(String)`, `.done`
- No `.assistantMessage` — the client reduces `text_delta` events into messages (see "SSE stream events" above)

**AudioRecorder**
- Uses AVAudioEngine with an input node tap
- Records to AAC in m4a container (compact, good quality) or WAV/CAF as a fallback
- AVAudioConverter does not support WebM/Opus — that is not a viable path on Apple platforms. Stick to native Apple formats.
- Deepgram accepts audio/mp4, audio/wav, and audio/x-caf natively.
- Start/stop controlled by PTT button

**AudioPlayer**
- Creates AVAudioEngine + AVAudioPlayerNode
- Uses the shared AVAudioSession configured as `.playAndRecord` (see Audio Session Configuration below)
- On each `audioChunk` SSE event:
  1. Base64 decode → Data
  2. Interpret as s16le samples → convert to Float32
  3. Create AVAudioPCMBuffer at 24000 Hz
  4. Schedule on AVAudioPlayerNode
- Buffers are scheduled with `scheduleBuffer(_:completionCallbackType:completionHandler:)` for gapless playback
- Stopping playback: `playerNode.stop()` immediately silences all scheduled buffers

## UI Design

The UI mirrors the web frontend's monochrome aesthetic, adapted for iOS conventions:

- Dark background (#0c0c0c), monochrome palette
- Martian Mono font (bundled or system monospace fallback)
- Full-screen layout: status bar at top, scrolling transcript in the middle, input bar + PTT button at bottom
- PTT button: large circular touch target (minimum 70pt), inverts to white when recording
- Text input: monospace, dark surface, sits left of the PTT button
- Safe area respected for notch/Dynamic Island devices
- No navigation — single screen, settings accessed via a gear icon in the status bar

### States

| State | PTT Button | Input Bar | Status |
|---|---|---|---|
| idle | mic icon, dark | enabled | connected |
| recording | stop icon, white fill, pulse | disabled | recording... |
| processing | spinner | disabled | thinking... |
| playing | stop icon | disabled | speaking... |

Tapping PTT during `playing` stops audio and returns to `idle`.

## Audio Session Configuration

```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
try session.setActive(true)
```

- `.playAndRecord` allows both mic input and speaker output
- `.defaultToSpeaker` routes audio to the main speaker (not the earpiece)
- `.allowBluetooth` supports AirPods/headphones

## Build Sequence

### Phase 1: Project setup and connectivity
- Create Xcode project with SwiftUI
- Add settings screen for backend URL input
- Implement health check with connection status indicator
- Verify connectivity to Overwatch backend over Tailscale

### Phase 2: Text input flow
- Implement OverwatchClient.sendTextTurn with SSE streaming
- Implement SSEParser
- Wire up text input → backend → transcript display
- No audio yet — just text in, text out

### Phase 3: Audio playback
- Implement AudioPlayer with AVAudioEngine + AVAudioPlayerNode
- Decode base64 PCM s16le → AVAudioPCMBuffer
- Wire audioChunk SSE events to the player
- Test gapless streaming playback

### Phase 4: Voice recording
- Implement AudioRecorder with AVAudioEngine
- Record to m4a (AAC) or wav
- Wire PTT button → record → send via voice-turn endpoint
- Full voice loop: speak → transcript → agent → TTS playback

### Phase 5: Polish
- Interruption handling (phone calls, other audio) via AVAudioSession interruption notifications
- PTT during playback: (1) call `playerNode.stop()` to silence audio, (2) call `activeTurnTask.cancel()` on the Swift Task to abort the backend pipeline, (3) reset state to idle, (4) start new recording. This ensures the backend stops working on the old turn.
- Haptic feedback on PTT press/release
- App icon and launch screen
- TestFlight distribution

## Backend Changes Required

Minimal:

1. **CORS headers** — the iOS app makes direct HTTP requests, not browser fetches. CORS is not needed, but ensure no browser-only assumptions in the response headers.
2. **Accept m4a audio** — if the recorder outputs AAC/m4a, ensure the STT route passes the correct MIME type (`audio/mp4` or `audio/m4a`) to Deepgram. Deepgram already supports these formats.
3. **Health endpoint** — already exists, no changes needed.

## What This Plan Does NOT Cover

- Push notifications (requires APNs setup, backend changes to detect when agent needs attention)
- Background audio (continuing playback when app is backgrounded)
- tmux pane management UI (depends on tmux orchestration layer being built first)
- App Store distribution (requires Apple Developer account, review process)
- Relay server for users without Tailscale (v2 concern)
- Android version

## Risks and Open Questions

1. **Audio format from recorder** — M4A (AAC) vs WAV: M4A is smaller but adds encoding overhead. WAV is lossless and zero-latency to produce. Need to test which gives better transcription quality for short voice commands.
2. **Latency** — the end-to-end chain (record → upload → STT → agent → TTS → stream back → play) will have noticeable latency. This is inherent to the architecture and acceptable for v1. Optimizations (streaming STT, faster agent models) are future work.
3. **Tailscale reliability** — if Tailscale drops the connection mid-turn, the SSE stream breaks. The app should detect this via URLSession error handling and show a reconnection prompt, not hang silently.
4. **AVAudioEngine PCM buffer scheduling** — scheduling many small buffers in rapid succession on AVAudioPlayerNode needs testing to confirm gapless playback without glitches or underruns.
5. **TTS gaps during tool calls** — the Deepgram TTS stream may stall or end up waiting on a final flush during long tool executions, causing TTS to only speak the pre-tool-call text. The backend handles this gracefully (text stream continues, TTS error is non-fatal), but the user may still experience silence for the post-tool-call response. Acceptable for v1.
