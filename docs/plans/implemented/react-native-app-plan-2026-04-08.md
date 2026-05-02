# Plan: Overwatch React Native iOS App

**Date:** 2026-04-08
**Status:** Implemented (the RN/Expo app shipped; the realtime client was later swapped to the Pipecat RN client + Daily transport in the 2026-05-02 overhaul — see [../../architecture/007-post-overhaul-architecture.md](../../architecture/007-post-overhaul-architecture.md))
**Reuses code from:** `/Users/soami/Desktop/code/yl/workspace-trees/workspace-3/frontend/apps/mobile-app`

## Outcome

A React Native (Expo) iOS app that connects to the Overwatch backend over Tailscale. Push-to-talk voice input, text input, streaming transcript, TTS audio playback. Ships via TestFlight.

## Why React Native / Expo

- The backend is TypeScript. The web frontend is JavaScript. Staying in the same language eliminates platform-context-switching friction.
- We have a proven, shipped mobile app (YouLearn) with battle-tested native audio modules, SSE handling, streaming TTS playback, push-to-talk recording, and Zustand state management. We reuse these directly instead of building from scratch, while targeting Deepgram for Overwatch's backend TTS.
- Expo development builds handle native code, config plugins, and TestFlight distribution without raw Xcode project management.

## Security Model

v1 is single-user on a trusted personal Tailnet. Tailscale device authentication is the only authorization boundary. No user auth, no tokens, no sessions. This is not the long-term security posture — see 002-product-vision.md for the distribution roadmap.

## Connectivity

The app stores the Overwatch backend URL (e.g., `http://100.x.x.x:8787`) in async storage. User enters their Tailscale IP on first launch.

```
iPhone → Tailscale (WireGuard) → Mac:8787 (Overwatch backend)
                                    ├── STT (Deepgram)
                                    ├── Agent (pi-coding-agent)
                                    ├── TTS (Deepgram Aura)
                                    └── tmux control (future)
```

## Backend Contract

### POST /api/v1/voice-turn
- Request: `multipart/form-data` with `audio` field
- Response: SSE stream

### POST /api/v1/text-turn
- Request: `application/json` with `{ "text": "..." }`
- Response: SSE stream

### GET /health
- Connection status check

### SSE stream events

| Event | Guaranteed | Payload | Notes |
|---|---|---|---|
| `transcript` | voice-turn only | `{ text }` | User's transcribed speech |
| `text_delta` | yes | `{ text }` | Streaming token. Multiple per turn, may pause during tool calls |
| `tool_call` | when tools used | `{ name }` | Agent is executing a tool |
| `audio_chunk` | best-effort | `{ base64, mimeType }` | PCM s16le 24kHz. TTS may die during tool call pauses |
| `tts_error` | on TTS failure | `{ message }` | TTS failed, text stream continues |
| `error` | on harness error | `{ message }` | Fatal error |
| `done` | yes | `{}` | Turn complete |

**`assistant_message` is NOT guaranteed.** The pi-coding-agent harness does not emit a final assembled message. The client must reduce `text_delta` events: accumulate into a pending message, finalize on `tool_call` or `done`, start a new message when deltas resume after a tool call.

### Turn cancellation

Cancellation is connection-scoped. The app cancels a turn by closing the `EventSource` connection (or aborting the fetch). The backend's `AbortSignal` fires and all pipeline work stops. No explicit turn ID or cancel API.

## Tech Stack

| Layer | Choice | Source | Rationale |
|---|---|---|---|
| Framework | Expo (dev build) | — | Config plugins, EAS Build, TestFlight |
| Audio playback | `StreamingAudio` native module | Copy from YL `modules/streaming-audio/` | Battle-tested native PCM player with `feedPCM()`, `markEndOfStream()`, play/pause. Already handles iOS audio engine lifecycle. |
| Audio recording | `@siteed/expo-audio-studio` | Same as YL | `onAudioStream` callback delivers PCM chunks at 500ms intervals. Gives real-time audio level data for amplitude visualization. |
| SSE | `react-native-sse` (`EventSource`) | Same as YL | Proven in production. Handles background suspend/resume. |
| State management | Zustand | Same as YL | Matches existing patterns. Stores for turn state, audio, settings. |
| Styling | NativeWind v4 | Same as YL | Tailwind for RN. Dark theme via `darkMode: "class"`. |
| Storage | `@react-native-async-storage/async-storage` | Same as YL | Backend URL persistence, theme preference |
| Haptics | `expo-haptics` | Same as YL | PTT press/release feedback |
| Bottom sheet | `@gorhom/bottom-sheet` | Same as YL | Settings panel |

### What we DON'T need from YL

- Firebase Auth / Google Sign-In / Apple Sign-In (no auth in v1)
- LiveKit / WebRTC (no real-time voice mode)
- S3 streaming upload (backend handles STT, not the client)
- TanStack Query (no server state caching needed)
- expo-router (single screen, no navigation)
- Drizzle / SQLite (no offline storage)

## Code to Copy from YL

### Must copy (native modules)

| Source | Target | Notes |
|---|---|---|
| `modules/streaming-audio/` | `modules/streaming-audio/` | Entire module — JS interface + native Swift/Kotlin. This is the PCM player. |

### Must adapt (hooks and utilities)

| Source | What to take | What to change |
|---|---|---|
| `lib/tts.ts` → `pcm16ToWav()` | WAV header utility | Use as-is |
| `lib/media-playback.ts` → `ensurePlaybackAudioSession()` | Audio session setup | Use as-is |
| `app/_layout.tsx` → `setAudioModeAsync(...)` config | Global audio mode | Use as-is |
| `hooks/use-media-coordinator.ts` | Single-active-media enforcer | Simplify — only need recording vs playback |
| `components/stt/recorder.tsx` | Recording config pattern | Adapt: remove S3 upload, LiveActivity, keep `onAudioStream` + amplitude |
| `lib/theme.ts` | HSL design tokens | Override with monochrome palette |
| `tailwind.config.js` | NativeWind config | Override colors, add monospace font |

### Don't need to copy

- `hooks/use-stt-recording.ts` — too coupled to YL's S3 + Deepgram WebSocket flow. Overwatch backend handles STT server-side.
- `streaming-stt.ts` — same reason. STT is backend-side.
- `hooks/use-podcast-store.ts`, `use-read-aloud-store.ts` — podcast-specific.
- `providers/livekit-room-provider.tsx` — WebRTC, not needed.

## Project Structure

```
overwatch-mobile/
  app.config.ts                     — Expo config + plugins
  app/
    _layout.tsx                     — Root layout, audio session init, providers
    index.tsx                       — Main screen (single screen app)
  src/
    stores/
      turn-store.ts                 — Zustand: turnState, messages, pendingText, abortController
      connection-store.ts           — Zustand: backendURL, connectionStatus
      audio-store.ts                — Zustand: isPlaying, playerRef
    hooks/
      use-overwatch-turn.ts         — Orchestrates a single turn: SSE consumption, text_delta reduction, audio feeding
      use-audio-player.ts           — Wraps StreamingAudio module: feedPCM, stop, markEndOfStream
      use-audio-recorder.ts         — Wraps @siteed/expo-audio-studio: start/stop, amplitude
    services/
      api.ts                        — fetch calls: health, voiceTurn (FormData), textTurn (JSON)
      sse.ts                        — Thin wrapper around react-native-sse EventSource for POST-like SSE
    components/
      TranscriptView.tsx            — FlatList of messages
      InputBar.tsx                  — TextInput + send button
      PTTButton.tsx                 — Push-to-talk with state-driven appearance
      StatusBar.tsx                 — Connection dot + label
      SettingsSheet.tsx             — Bottom sheet for backend URL
    types.ts                        — Message, SSEEvent, TurnState
    theme.ts                        — Monochrome design tokens
  modules/
    streaming-audio/                — Copied from YL, native PCM player
  tailwind.config.js
```

## Key Implementation Details

### PCM Playback (`use-audio-player.ts`)

Uses the `StreamingAudio` native module, same as YL's TTS playback:

```typescript
import StreamingAudio from '@/modules/streaming-audio';

function startSession() {
  StreamingAudio.startSession({ sampleRate: 24000, channels: 1 });
}

function feedChunk(base64: string) {
  // Decode base64 to Uint8Array
  const bytes = Buffer.from(base64, 'base64');
  StreamingAudio.feedPCM(bytes);
}

function endPlayback() {
  StreamingAudio.markEndOfStream();
}

function stopImmediately() {
  StreamingAudio.flushAndReset();
  StreamingAudio.endSession();
}
```

No AudioContext, no buffer scheduling, no sample rate mismatch issues. The native module handles all of that.

### Audio Recording (`use-audio-recorder.ts`)

Uses `@siteed/expo-audio-studio`, same config as YL's recorder:

```typescript
import { useAudioRecorder } from '@siteed/expo-audio-studio';

const recorder = useAudioRecorder({
  sampleRate: 16000,
  channels: 1,
  encoding: 'pcm_16bit',
  interval: 500,
  onAudioAnalysis: (analysis) => {
    // Update amplitude visualization from analysis.rms
  },
});

// Start recording
await recorder.startRecording();

// Stop and get the file
const result = await recorder.stopRecording();
// result.fileUri → send as FormData to /api/v1/voice-turn
// result.mimeType → pass as content type
```

The recorder outputs a file (WAV or m4a depending on config). Send it directly to the backend.

### SSE Consumption

`react-native-sse`'s `EventSource` doesn't support POST, but we need POST for both endpoints. Two approaches:

**Option A: Use fetch + manual line parsing (like the web frontend)**
Works but doesn't get the background suspend/resume behavior from `react-native-sse`.

**Option B: Use fetch for POST, parse SSE manually, but add AppState suspend/resume**
This is the pragmatic choice for v1:

```typescript
async function consumeTurn(url: string, body: BodyInit, headers: HeadersInit, signal: AbortSignal) {
  const res = await fetch(url, { method: 'POST', body, headers, signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        yield { type: eventType, data: JSON.parse(line.slice(6)) };
        eventType = null;
      }
    }
  }
}
```

### Text Delta Reduction (in `turn-store.ts`)

```typescript
// Zustand store
interface TurnState {
  messages: Message[];
  pendingText: string;
  pendingMessageId: string | null;
  turnState: 'idle' | 'recording' | 'processing' | 'playing';

  handleTextDelta: (text: string) => void;
  handleToolCall: (name: string) => void;
  handleDone: () => void;
}

// handleTextDelta:
// If no pendingMessageId, create new assistant message, set pendingMessageId
// Append text to pendingText, update message in place

// handleToolCall:
// Clear pendingMessageId + pendingText (finalize current message)
// Add tool_call message

// handleDone:
// Clear pendingMessageId + pendingText
```

### Audio Session (in `_layout.tsx`)

Copy from YL — set once at app startup:

```typescript
import { setAudioModeAsync } from 'expo-audio';

await setAudioModeAsync({
  interruptionMode: 'doNotMix',
  shouldPlayInBackground: true,
  playsInSilentMode: true,
  shouldRouteThroughEarpiece: false,
});
```

## Expo Configuration

### app.config.ts

```typescript
export default {
  expo: {
    name: 'Overwatch',
    slug: 'overwatch-mobile',
    version: '1.0.0',
    scheme: 'overwatch',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    ios: {
      bundleIdentifier: 'com.overwatch.mobile',
      supportsTablet: false,
      infoPlist: {
        NSMicrophoneUsageDescription: 'Overwatch uses the microphone for push-to-talk voice commands.',
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
        UIBackgroundModes: ['audio'],
      },
    },
    plugins: [
      ['@siteed/expo-audio-studio'],
      ['expo-audio', { microphonePermission: 'Overwatch uses the microphone for push-to-talk voice commands.' }],
    ],
  },
};
```

Key points:
- `NSAllowsArbitraryLoads` — required for plain HTTP to Tailscale IPs
- `NSMicrophoneUsageDescription` — required or iOS kills the app on mic access
- `UIBackgroundModes: ['audio']` — keeps audio playing when app is backgrounded
- `userInterfaceStyle: 'dark'` — force dark mode

### Development build

```bash
npx expo prebuild
npx expo run:ios        # simulator
npx expo run:ios -d     # device
```

Or EAS Build:

```bash
eas build --profile development --platform ios
```

## UI Design

Monochrome aesthetic via NativeWind, adapted from the web frontend's `app.css`:

- Background: `#0c0c0c`, surface: `#151515`, border: `#222`
- Text hierarchy through opacity only: primary `#d4d4d4`, dim `#666`, faint `#333`
- Font: system monospace (`Menlo` / `Courier`) — bundling Martian Mono is optional
- PTT button: 60pt, square with 1px border (matching web's sharp corners), inverts to white when recording
- Text input: dark surface, monospace, no border-radius
- Messages: user messages right-aligned with subtle surface, assistant messages left-aligned with left border line

### States

| State | PTT Button | Input Bar | Status |
|---|---|---|---|
| idle | mic icon, dark | enabled | connected |
| recording | stop icon, white fill | disabled | recording... |
| processing | spinner | disabled | thinking... |
| playing | stop icon | disabled | speaking... |

## Build Sequence

### Phase 1: Scaffold + native module + connectivity

- `npx create-expo-app overwatch-mobile`
- Copy `modules/streaming-audio/` from YL
- Install deps: `@siteed/expo-audio-studio`, `expo-audio`, `react-native-sse`, `zustand`, `nativewind`, `@gorhom/bottom-sheet`, `expo-haptics`, `@react-native-async-storage/async-storage`, `buffer` (polyfill)
- Configure `app.config.ts` with plugins, plist keys, background audio
- Copy audio session setup from YL `_layout.tsx`
- Build settings sheet for backend URL (async storage)
- Implement health check polling → connection store
- `npx expo prebuild && npx expo run:ios`
- **Gate:** app builds, connects to Overwatch backend over Tailscale, shows "connected"

### Phase 2: Text input + SSE streaming + transcript

- Implement SSE parser (fetch + manual line parsing)
- Implement `api.ts` with `textTurn()` 
- Implement `turn-store.ts` with text_delta reduction
- Build TranscriptView (FlatList), InputBar, StatusBar
- Wire up: type message → POST text-turn → stream SSE → render transcript
- **Gate:** type a message, see streaming assistant response in transcript

### Phase 3: Audio playback

- Implement `use-audio-player.ts` wrapping `StreamingAudio`
- `startSession({ sampleRate: 24000, channels: 1 })` at turn start
- `feedPCM(bytes)` on each `audio_chunk` SSE event
- `markEndOfStream()` on `done`
- `flushAndReset()` + `endSession()` on interruption
- Wire into turn-store: transition to `playing` on first audio chunk
- **Gate:** type a message, hear the response spoken back. Tap PTT during playback to stop.

### Phase 4: Voice recording

- Implement `use-audio-recorder.ts` wrapping `@siteed/expo-audio-studio`
- Record on PTT press, stop on PTT release
- Send recorded file via FormData to voice-turn endpoint
- Wire amplitude visualization from `onAudioAnalysis`
- **Gate:** full voice loop works: speak → transcript → agent → TTS playback

### Phase 5: Polish + TestFlight

- Haptic feedback: `Haptics.impactAsync(Medium)` on PTT press, `Haptics.impactAsync(Light)` on release
- Connection error handling: retry health check, show reconnection prompt
- Media coordinator: prevent recording while playing and vice versa
- App icon and splash screen
- EAS Build → TestFlight

## Backend Changes Required

1. **Verify audio MIME type handling** — `@siteed/expo-audio-studio` outputs WAV (pcm_16bit) or m4a depending on config. Ensure the voice-turn route passes the correct MIME type to Deepgram. Deepgram accepts `audio/wav`, `audio/mp4`, `audio/m4a`.
2. **No other changes needed.**

## What This Plan Does NOT Cover

- Push notifications
- tmux pane management UI
- App Store distribution  
- Relay server for non-Tailscale users
- Android (Expo makes this easy to add later, but not in scope)

## Risks

1. **`StreamingAudio` module portability** — the module was built for YL's monorepo. It may have implicit dependencies on YL's Expo SDK version or build config. First task in Phase 1 is to get it compiling in a standalone project.
2. **`@siteed/expo-audio-studio` recording format** — need to confirm Deepgram accepts the exact output format (sample rate, encoding, container) without transcription quality issues.
3. **SSE via fetch ReadableStream** — `ReadableStream` support in React Native's `fetch` polyfill varies. If it doesn't work, fall back to `react-native-sse` with a GET-based polling approach, or use XHR with `onprogress`.
4. **Base64 decoding performance** — decoding large base64 audio chunks in JS may be slow. Use `react-native-quick-base64` or the `buffer` polyfill's `Buffer.from()` for native-speed decoding.

Sources:
- [StreamingAudio module](file:///Users/soami/Desktop/code/yl/workspace-trees/workspace-3/frontend/apps/mobile-app/modules/streaming-audio/)
- [YL TTS implementation](file:///Users/soami/Desktop/code/yl/workspace-trees/workspace-3/frontend/apps/mobile-app/lib/tts.ts)
- [YL recorder component](file:///Users/soami/Desktop/code/yl/workspace-trees/workspace-3/frontend/apps/mobile-app/components/stt/recorder.tsx)
- [react-native-audio-api docs](https://docs.swmansion.com/react-native-audio-api/)
- [Expo audio docs](https://docs.expo.dev/versions/latest/sdk/audio/)
- [Expo SSE issue](https://github.com/expo/expo/issues/27526)
