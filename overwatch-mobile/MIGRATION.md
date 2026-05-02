# Mobile migration to Pipecat + WebRTC

This branch (`overhaul/voice-harness-bridge`) introduces the new pipecat-based
voice path on mobile. The legacy WebSocket / custom-audio-modules path is
**still present and functional** alongside the new path. The cutover is
intentionally incremental.

## What's new

- `src/hooks/use-pipecat-session.ts` — single hook over `PipecatClient` +
  `RNDailyTransport`. Drives the new `conversation` store.
- `src/stores/conversation.ts` — single Zustand store. `isAgentSpeaking` /
  `isUserSpeaking` are derived from the active message's `final` flag, never
  stored.
- `package.json` — adds `@pipecat-ai/client-js`,
  `@pipecat-ai/react-native-daily-transport`, `@daily-co/react-native-daily-js`,
  `@daily-co/react-native-webrtc`, `react-native-background-timer`.

## What's still legacy (delete during cutover)

- `src/hooks/use-audio-player.ts`
- `src/hooks/use-audio-recorder.ts`
- `src/hooks/use-overwatch-turn.ts`
- `src/hooks/use-realtime-connection.ts`
- `src/stores/audio-store.ts`
- `src/stores/turn-store.ts`
- `modules/fast-recorder/`
- `modules/streaming-audio/`

These are still imported by `src/components/PTTButton.tsx`,
`src/components/TranscriptView.tsx`, `src/components/SessionsPanel.tsx`,
and `app/index.tsx`. Cutover plan:

1. `npm install` to fetch the new deps.
2. Run `expo prebuild --clean` to regenerate native projects (Daily WebRTC needs
   native modules; Expo Go is no longer supported).
3. Replace the legacy hook usages in components one at a time, starting with
   `PTTButton` (simplest, highest visibility).
4. Delete the legacy hooks/stores/modules once nothing references them.
5. `expo prebuild --clean` again to drop the unused native modules.

## PTTButton refactor sketch

```ts
import { usePipecatSession } from "../hooks/use-pipecat-session";
import { useConversationStore } from "../stores/conversation";

const { setMicEnabled, sendInterruptIntent, status } = usePipecatSession();
const isRemoteMuted = useConversationStore((s) => s.isRemoteMuted);

// Press handler:
//   if isRemoteMuted: do nothing
//   else: setMicEnabled(true) + sendInterruptIntent()
// Release handler:
//   setMicEnabled(false)
```

## Per-session token derivation

The phone derives a per-session token at `connect()` time as
`HMAC(pairing_token, session_id || expires_at)`. Implementation lives in
`src/services/session-token.ts` (TODO during cutover; currently the pairing
token itself is passed through as the session token for the alpha).
