# Plan: Compatibility-First Speech Provider Architecture

**Date:** 2026-04-10
**Status:** Proposed
**Related Docs:** [../architecture/001-backend-architecture.md](../architecture/001-backend-architecture.md), [../research/initial-research-2026-04-05.md](../research/initial-research-2026-04-05.md), [mvp-plan-2026-04-05.md](mvp-plan-2026-04-05.md), [cli-and-relay-plan-2026-04-09.md](cli-and-relay-plan-2026-04-09.md)
**Amends:** [mvp-plan-2026-04-05.md](mvp-plan-2026-04-05.md) — the voice layer has already been consolidated onto Deepgram for both STT and TTS, and this plan now covers the remaining setup simplification and compatibility work beyond that consolidation.

## Outcome

A new Overwatch user can complete the backend + CLI speech-provider setup for push-to-talk mode with a single Deepgram key, with TTS remaining optional and no second speech-provider account required. This plan is about the speech provider layer and setup flow after the Deepgram consolidation, not a full product-wide platform-support expansion; additional local/no-key options can be layered in later wherever the Overwatch backend itself is supported.

## Why

The current product and setup flow now hard-code Deepgram for both STT and TTS:

- backend env schema expects `DEEPGRAM_API_KEY` and `DEEPGRAM_TTS_MODEL` in `src/config.ts`
- backend boot wires `DeepgramSttAdapter` and `DeepgramTtsAdapter` directly in `src/index.ts`
- CLI config stores one `deepgramApiKey` in `packages/cli/src/config.ts`
- setup prompts for one Deepgram key in `packages/cli/src/commands/setup.ts`
- status reports Deepgram as the combined STT + TTS provider in `packages/cli/src/commands/status.ts`
- README partially reflects the consolidation, but some docs may still mention Cartesia and need cleanup

That is already a meaningful setup simplification. The remaining compatibility-first version of Overwatch should:

- keep the existing `SttAdapter` and `TtsAdapter` seams
- preserve the one-key Deepgram cloud default for the easiest setup path
- make TTS optional so users can choose transcript-first mode
- allow local providers to be added later without changing Overwatch itself
- allow different local engines per machine behind stable provider seams

## Compatibility-first architecture

### Design rule

Overwatch should depend on provider interfaces and stable local APIs, not on one engine implementation.

### Default providers

**Current shipped STT default:** Deepgram
- uses the existing prerecorded-upload push-to-talk path
- rationale: already integrated, one-key setup, and good enough for the current product shape

**Current shipped TTS default:** Deepgram Aura streaming TTS
- uses the existing websocket-based Deepgram TTS adapter
- rationale: same provider family as STT, one-key setup, and no second speech vendor required

**Future local recommendation:** local, compatibility-first providers
- STT primary target: `whisper.cpp` HTTP server or another OpenAI-compatible local STT endpoint
- TTS primary target: local Piper process or a thin local HTTP wrapper around Piper
- rationale: local/offline options can be layered in later without changing the app architecture
- TTS should remain optional; users who skip it should still get transcript-first operation and text replies without spoken playback

### Optional providers

**Optional local STT backends:**
- `whisper.cpp`
- `speaches`
- `faster-whisper` server
- Mac-only accelerators later: WhisperKit, MLX Whisper, Parakeet

**Optional local TTS backends:**
- Piper process
- Piper HTTP server
- `speaches` TTS

**Optional cloud backends:**
- STT: Deepgram (already shipped default)
- TTS: Deepgram Aura (already shipped default)
- TTS later: Edge as a no-key cloud fallback if desired, but not required for this plan

### Architectural implication

The backend should talk to a configurable provider selected at startup:

- the current shipped cloud path remains Deepgram for both STT and TTS
- local STT can be implemented later via HTTP to a localhost server
- local TTS can be implemented later via direct process spawn first, then optional HTTP later
- all of those paths should remain behind the existing adapter seams

This keeps the Overwatch codebase portable even when the best local engine differs by machine.

---

## Phase 0: Deepgram consolidation (already landed)

### Current state now in the repo

The main backend already uses:

- `DeepgramSttAdapter` for push-to-talk STT
- `DeepgramTtsAdapter` for websocket Aura TTS
- one shared `DEEPGRAM_API_KEY`
- optional `DEEPGRAM_TTS_MODEL` for voice/model selection

The current Deepgram TTS adapter is already built around Deepgram's websocket control flow:

- send `Speak` messages with buffered text
- send `Flush` to force audio generation
- send `Close` on teardown/abort
- receive binary PCM audio chunks at `24000 Hz`

That means the Cartesia removal work is no longer part of this plan. This plan starts from the consolidated Deepgram baseline and covers what remains after that change.

---

## Phase 1: Refactor configuration around providers

### Goal

Evolve the now-simpler Deepgram-centric config toward a provider-centric config while preserving backward compatibility.

### Files to modify

- `packages/cli/src/config.ts`
- `packages/cli/src/commands/setup.ts`
- `packages/cli/src/commands/start.ts`
- `packages/cli/src/commands/status.ts`
- `src/config.ts`
- `README.md`
- `docs/architecture/001-backend-architecture.md`
- `docs/architecture/002-product-vision.md`

### New config shape

Extend the CLI config file from:

```json
{
  "deepgramApiKey": "...",
  "relayUrl": "...",
  "backendPort": 8787
}
```

Toward:

```json
{
  "sttProvider": "local",
  "ttsProvider": "none",
  "localSttEngine": "whisper.cpp",
  "localTtsEngine": "piper",
  "sttBaseUrl": "http://127.0.0.1:8080",
  "ttsBaseUrl": "http://127.0.0.1:5000",
  "deepgramApiKey": "...",
  "deepgramTtsModel": "aura-2-aries-en",
  "relayUrl": "https://overwatch-relay.soami.workers.dev",
  "backendPort": 8787
}
```

Mirror the same provider-oriented schema in backend env/config parsing. The backend env loader should accept:

- `STT_PROVIDER=local|deepgram`
- `TTS_PROVIDER=none|local|deepgram|edge` (edge can remain reserved for later)
- `LOCAL_STT_ENGINE=whisper.cpp|speaches|faster-whisper|whisperkit|mlx-whisper|parakeet`
- `LOCAL_TTS_ENGINE=piper|speaches`
- `LOCAL_STT_BASE_URL=http://127.0.0.1:8080`
- `LOCAL_TTS_BASE_URL=http://127.0.0.1:5000`
- existing `DEEPGRAM_API_KEY`
- existing `DEEPGRAM_TTS_MODEL`

### Backward compatibility rules

Keep old configs working:

- if `deepgramApiKey` exists and no `sttProvider` is set, default `sttProvider = "deepgram"`
- if `deepgramApiKey` exists and no `ttsProvider` is set, default `ttsProvider = "deepgram"`
- otherwise default to `sttProvider = "local"` and `ttsProvider = "none"`

### CLI setup UX changes

Replace the current key prompts with provider selection:

1. Ask for STT provider:
   - `Local (recommended)`
   - `Deepgram`

2. If local STT is chosen, ask for engine:
   - `whisper.cpp (recommended)`
   - `speaches`
   - `Custom OpenAI-compatible endpoint`

3. Ask for TTS provider:
   - `None`
   - `Deepgram (recommended, uses the same API key as STT)`
   - `Local Piper`

4. If `None` is chosen, disable spoken playback and keep transcript/text-only behavior.

5. Only prompt for API keys if the chosen provider requires them. Deepgram STT + TTS should reuse the same key.

6. If local providers are chosen, show install instructions and optional auto-detection results instead of demanding credentials.

### Acceptance criteria

- a fresh config can keep the current one-key Deepgram setup or opt into local providers later
- existing configs continue to work unchanged
- `overwatch status` reports providers and engines, not just keys
- `README.md` no longer says a second TTS provider account is required

---

## Phase 2: Add provider factories in the backend

### Goal

Stop constructing adapters directly in `src/index.ts`.

### Files to create

- `src/stt/factory.ts`
- `src/tts/factory.ts`

### Files to modify

- `src/index.ts`
- `src/config.ts`

### Implementation

Create a factory for each provider seam.

`src/stt/factory.ts` should export something like:

```ts
import type { AppConfig } from "../config.js";
import type { SttAdapter } from "./types.js";
import { DeepgramSttAdapter } from "./deepgram.js";
import { LocalHttpSttAdapter } from "./local-http.js";

export function createSttAdapter(config: AppConfig): SttAdapter {
  if (config.sttProvider === "deepgram") {
    return new DeepgramSttAdapter({ apiKey: config.DEEPGRAM_API_KEY });
  }

  return new LocalHttpSttAdapter({
    baseUrl: config.LOCAL_STT_BASE_URL,
    engine: config.LOCAL_STT_ENGINE,
  });
}
```

`src/tts/factory.ts` should export something like:

```ts
import type { AppConfig } from "../config.js";
import type { TtsAdapter } from "./types.js";
import { DeepgramTtsAdapter } from "./deepgram.js";
import { PiperProcessTtsAdapter } from "./piper-process.js";
import { NullTtsAdapter } from "./null.js";

export function createTtsAdapter(config: AppConfig): TtsAdapter {
  if (config.ttsProvider === "none") {
    return new NullTtsAdapter();
  }

  if (config.ttsProvider === "deepgram") {
    return new DeepgramTtsAdapter({
      apiKey: config.DEEPGRAM_API_KEY,
      model: config.DEEPGRAM_TTS_MODEL,
    });
  }

  return new PiperProcessTtsAdapter({
    voice: config.LOCAL_TTS_VOICE,
    engine: config.LOCAL_TTS_ENGINE,
    baseUrl: config.LOCAL_TTS_BASE_URL,
  });
}
```

Then `src/index.ts` should call `createSttAdapter(config)` and `createTtsAdapter(config)` instead of directly instantiating Deepgram adapters in the entry point.

### Acceptance criteria

- `src/index.ts` contains no provider-specific boot logic beyond factory usage
- backend provider selection is entirely config-driven
- health output reports the selected provider class names cleanly

---

## Phase 3: Implement a generic local STT adapter

### Goal

Support local STT without embedding one engine implementation into Overwatch.

### Files to create

- `src/stt/local-http.ts`

### Why local HTTP first

Overwatch's current STT path is not streaming. It is a push-to-talk upload path:

- upload audio bytes
- receive a final transcript

That makes a generic local HTTP adapter the simplest compatibility-first seam. In v1, that seam should be deliberately narrow: Overwatch only supports local STT servers that expose an OpenAI-compatible transcription API. That lets Overwatch talk to:

- `whisper.cpp` server when exposed through an OpenAI-compatible wrapper or compatible endpoint
- `speaches`
- `faster-whisper` server implementations that expose OpenAI-compatible transcription routes
- WhisperKit local server later
- custom user-provided OpenAI-compatible STT endpoints

### Adapter behavior

`LocalHttpSttAdapter` should:

- POST to `LOCAL_STT_BASE_URL + /v1/audio/transcriptions`
- send multipart form-data with `file`, `model`, and optional `language`
- assume an OpenAI-compatible response contract in v1
- normalize responses into Overwatch's existing `SttResult`
- include engine name in `raw` for debugging

Servers that do not expose this contract are out of scope for v1 and should be adapted separately instead of adding endpoint-specific branches inside Overwatch.

### Recommended request contract

Use OpenAI-compatible transcription requests for maximum interoperability:

- `POST /v1/audio/transcriptions`
- form-data with `file`, `model`, and optional `language`

This gives access to multiple backends through one adapter contract.

### Suggested implementation detail

Make the adapter endpoint-aware, not brand-aware:

```ts
interface LocalHttpSttAdapterOptions {
  baseUrl?: string;
  engine?: string;
  model?: string;
}
```

If `baseUrl` is `http://127.0.0.1:8080`, the adapter can call:

- `http://127.0.0.1:8080/v1/audio/transcriptions`

### Acceptance criteria

- Overwatch can transcribe with no Deepgram key when pointed at a compatible local STT server
- `/api/v1/stt` still returns `{ transcript, raw }`
- relay voice path keeps working because it already depends on `/api/v1/stt`, not Deepgram directly

---

## Phase 4: Implement a compatibility-first local TTS adapter

### Goal

Add an optional TTS path that works with Overwatch's current audio chunk model, while also supporting a no-TTS mode.

### Files to create

- `src/tts/piper-process.ts`
- `src/tts/null.ts`

### Why null + Piper first

Overwatch should support two TTS states immediately:

- `none` for users who do not want spoken playback
- `piper` for users who want the recommended local spoken playback path

`NullTtsAdapter` should simply emit no audio events and no errors. That keeps the turn lifecycle intact while making spoken playback optional.

Overwatch's TTS layer currently expects chunked audio events while the model is speaking:

- `audio_chunk`
- `marker`
- `error`

Current Deepgram behavior emits raw PCM chunks at `24000 Hz`, which the mobile client already knows how to play. Piper can output raw PCM to stdout, so it remains a plausible future local replacement.

This is a better first implementation than depending on an HTTP TTS wrapper because:

- fewer moving parts
- broader cross-platform installation story
- no extra server requirement for the MVP of local TTS
- easier to preserve chunked playback semantics

### Adapter behavior

`PiperProcessTtsAdapter` should:

- spawn the `piper` executable
- write sentence-sized or chunk-buffered text to stdin
- read raw PCM from stdout
- emit `audio_chunk` events with `audio/pcm;rate=22050` or the chosen Piper voice rate
- emit `error` if the process is missing or synthesis fails

### Important compatibility note

Do not try to make Piper identical to the current Deepgram TTS path in the first pass. Normalize enough metadata for the client to play audio correctly.

This is not just a backend note: the current React Native audio path starts playback sessions at a hard-coded 24000 Hz and effectively relies on the current Deepgram PCM output shape. That means local Piper will likely play at the wrong speed unless client playback changes land in the same slice.

The mobile and web playback code should rely on the declared MIME type and parsed sample rate, not on an assumed Deepgram sample rate.

### Required client changes for local TTS

Treat these as part of the same implementation slice, not follow-up polish:

- update `overwatch-mobile/src/hooks/use-realtime-connection.ts` to pass `mimeType` through to the audio player instead of dropping it
- update `overwatch-mobile/src/hooks/use-audio-player.ts` so `startSession(...)` accepts a dynamic sample rate derived from the chunk metadata
- add a small parser/utility that converts values like `audio/pcm;rate=22050` into playback config
- preserve `24000 Hz` for Deepgram, but support Piper's declared output rate as well

Local Piper should not ship until those playback changes are implemented and manually verified.

### Minimal rollout rule

For the first version of local TTS:

- allow only one local engine: Piper
- keep Deepgram as the cloud option
- do not add Edge or extra wrappers yet

### Acceptance criteria

- Overwatch can run with `ttsProvider = none` and complete turns with no spoken playback
- Overwatch can stream TTS locally with no second TTS vendor key when Piper is installed
- `turn.audio_chunk` continues to flow through the existing realtime protocol when TTS is enabled
- `turn.tts_error` still fires on failure instead of crashing the turn

---

## Phase 5: Add local dependency detection and setup UX

### Goal

Make local providers discoverable and understandable during setup.

### Files to modify

- `packages/cli/src/commands/setup.ts`
- `packages/cli/src/commands/status.ts`
- `README.md`

### Setup behavior

For local STT:

- detect whether a known local server is reachable at the configured base URL
- if not reachable, print install instructions for the selected engine

For local TTS:

- detect whether `piper` exists in `PATH`
- if not present, print install instructions instead of failing silently
- if the user chooses `None`, skip all TTS dependency checks and explain that spoken playback is disabled

### Recommended setup copy

Use language like:

- `STT provider: Deepgram (recommended, same key used by current TTS)`
- `TTS provider: None, Deepgram (recommended), or Local Piper`
- `Future local option: whisper.cpp / Piper`

Do not describe a second TTS vendor as required for basic usage.

### `status` command changes

Change output from the current single-line provider summary into explicit speech-state reporting, for example:

- `STT: deepgram configured`
- `TTS: deepgram configured`
- or `TTS: none`
- or `STT: local (whisper.cpp) ready`
- or `TTS: local (piper) ready`

### README changes

Update these sections:

- quick setup
- agent setup prompt
- manual setup
- architecture summary
- API key table

New README stance:

- the current default path is one-key Deepgram for STT + TTS
- TTS is optional
- local providers are future optional extensions, not required for the main setup path

### Acceptance criteria

- first-run setup no longer blocks on provider credentials
- docs accurately describe local-first defaults
- status makes it obvious what is configured and what is missing

---

## Phase 6: Optional engine-specific accelerators after the compatibility baseline lands

### Goal

Add better local engines without changing the Overwatch architecture.

### Candidate follow-on providers

**STT:**
- WhisperKit local server for Apple Silicon
- MLX Whisper local server for Apple Silicon
- Parakeet local backend for Apple Silicon or specialized installs
- `speaches` as unified localhost server for STT + TTS

**TTS:**
- HTTP-backed Piper wrapper
- `speaches` TTS
- Edge cloud fallback

### Rule for follow-on work

Do not wire these directly into the app surface unless they fit the existing provider factory model. The architecture should stay:

- config selects provider
- factory builds adapter
- adapter satisfies existing interface

### Acceptance criteria

- adding a new engine does not require mobile protocol changes
- adding a new engine does not require reworking the CLI config format again

---

## Scope boundary with Pipecat voice mode

This plan only changes the push-to-talk + relay/backend speech-provider path described in `src/index.ts`, `/api/v1/stt`, and the existing chunked TTS flow. It does not change the Pipecat conversation-mode pipeline described in `docs/plans/pipecat-voice-mode-2026-04-09.md`, although that doc should now be revisited because the main backend has already consolidated onto Deepgram for both STT and TTS. If conversation mode should adopt the same one-provider Deepgram story or become compatibility-first later, write a follow-up plan that explicitly amends the Pipecat design.

## Rollout order

Implement in this order:

1. Provider-centric config schema
2. Backend factories
3. Generic local HTTP STT adapter
4. Piper process TTS adapter
5. Setup/status/docs refresh
6. Optional accelerated engines later

This order gives value early while keeping each step reversible.

---

## Verification checklist

### Local-only smoke test

1. Configure:
   - `sttProvider = local`
   - `localSttEngine = whisper.cpp`
   - `ttsProvider = none`
2. Start local STT backend
3. Run `overwatch start`
4. Send a push-to-talk message from the phone
5. Verify:
   - `/api/v1/stt` returns a transcript
   - the transcript enters the turn pipeline
   - no `turn.audio_chunk` events are required
   - no cloud credentials are needed

### Local STT + local TTS smoke test

1. Configure:
   - `sttProvider = local`
   - `localSttEngine = whisper.cpp`
   - `ttsProvider = local`
   - `localTtsEngine = piper`
2. Start local STT backend
3. Ensure `piper` is installed
4. Run `overwatch start`
5. Send a push-to-talk message from the phone
6. Verify:
   - `/api/v1/stt` returns a transcript
   - the transcript enters the turn pipeline
   - `turn.audio_chunk` events are emitted
   - no cloud credentials are needed

### Cloud default smoke test

1. Configure:
   - `sttProvider = deepgram`
   - `ttsProvider = deepgram`
2. Provide a valid Deepgram API key
3. Run the same push-to-talk flow
4. Verify the existing one-key cloud behavior works unchanged

### Mixed-mode smoke test

1. Configure local STT + Deepgram TTS
2. Configure Deepgram STT + local Piper TTS
3. Verify both combinations work

---

## Risks and mitigations

### Risk: too many provider-specific code paths

Mitigation:
- keep factories small
- keep adapter interfaces narrow
- prefer generic local adapters over bespoke engine wiring

### Risk: local TTS audio format mismatch

Mitigation:
- make MIME type explicit on every `audio_chunk`
- update playback code to trust the chunk MIME/sample rate instead of assuming the current Deepgram output forever

### Risk: local engine setup becomes its own support burden

Mitigation:
- default to one local STT engine and one local TTS engine in docs
- make all other engines optional, not part of the first-run path

### Risk: docs drift

Mitigation:
- update `README.md`, `docs/architecture/001-backend-architecture.md`, and `docs/architecture/002-product-vision.md` in the same change set as the implementation

---

## Recommended first slice

If implementation time is limited, do only this first:

1. provider-centric config
2. local HTTP STT adapter
3. null TTS adapter (`ttsProvider = none`)
4. mobile playback metadata changes (`mimeType` + dynamic sample rate plumbing)
5. Piper process TTS adapter
6. setup/status/docs update

Important: steps 4 and 5 are one shippable slice for local Piper. Without the mobile playback metadata work, local Piper is not safe to ship.

If even that is too much for the first pass, stop after step 3 and ship local STT + no-TTS mode first.

## Definition of done

This plan is complete when:

- a fresh user can install Overwatch and use voice with a single Deepgram key, or with local/provider alternatives as they are added later
- the current Deepgram STT + TTS path keeps working as the default provider story
- README and setup flow describe one-key Deepgram as the default, with TTS optional and local Piper documented as a future optional path
- the backend architecture is provider-driven rather than hard-coded in the entry point to a single adapter pair
- local Piper only ships together with the required mobile playback metadata changes
