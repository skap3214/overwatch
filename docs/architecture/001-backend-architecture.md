# Decision 001: Overwatch Backend Architecture

**Status:** ACCEPTED
**Date:** 2026-04-05
**Scope:** Current backend architecture as implemented in the repository
**Related Code:** [../../src/index.ts](../../src/index.ts), [../../src/config.ts](../../src/config.ts), [../../src/harness/claude-code-cli.ts](../../src/harness/claude-code-cli.ts), [../../src/harness/pi-coding-agent.ts](../../src/harness/pi-coding-agent.ts), [../../src/harness/types.ts](../../src/harness/types.ts), [../../src/extensions/scheduler.ts](../../src/extensions/scheduler.ts), [../../src/extensions/memory.ts](../../src/extensions/memory.ts), [../../src/agent/memory/index.ts](../../src/agent/memory/index.ts), [../../src/orchestrator/turn-coordinator.ts](../../src/orchestrator/turn-coordinator.ts), [../../src/tasks/scheduler-runner.ts](../../src/tasks/scheduler-runner.ts), [../../src/notifications/store.ts](../../src/notifications/store.ts), [../../src/realtime/socket-server.ts](../../src/realtime/socket-server.ts), [../../src/stt/deepgram.ts](../../src/stt/deepgram.ts), [../../src/stt/types.ts](../../src/stt/types.ts), [../../src/tts/deepgram.ts](../../src/tts/deepgram.ts), [../../src/tts/types.ts](../../src/tts/types.ts), [../../src/shared/events.ts](../../src/shared/events.ts), [../../src/shared/async-queue.ts](../../src/shared/async-queue.ts)
**Related Docs:** [../plans/mvp-plan-2026-04-05.md](../plans/mvp-plan-2026-04-05.md), [../research/initial-research-2026-04-05.md](../research/initial-research-2026-04-05.md), [../insights.md](../insights.md)

## Decision

Overwatch uses a Node/TypeScript backend with three deliberately separated layers:

1. `orchestrator harness`
2. `speech providers`
3. `future tmux orchestration layer`

The backend is designed so that tmux/session logic is not coupled to any single agent harness, and the client is not coupled to any single speech provider.

## Why This Structure Exists

The backend has two unstable choices that may change later:

- which agent harness powers the orchestrator
- which STT/TTS providers power the voice loop

The backend therefore standardizes on internal interfaces and normalized events rather than exposing raw provider or CLI output to the rest of the system.

This is the key architectural rule:

- tmux/session logic depends on `normalized harness events`
- client logic depends on `backend audio/text events`
- neither should depend directly on Claude CLI JSON shape, Deepgram JSON shape, or Cartesia WebSocket message shape
- for the mobile client, audio ingestion and orchestration transport may be separate concerns

## Implemented Stack

### Runtime

- Language: TypeScript
- Runtime: Node.js
- HTTP server: Hono + `@hono/node-server`
- Config loading: `dotenv`

### Orchestrator Harness

- Primary implementation: Claude Code CLI wrapper
- Fallback implementation planned: `pi-coding-agent`
- Current in-process runtime path used by `src/index.ts`: `pi-coding-agent` with scheduler and memory extensions, coordinated by a serialized turn runner

### STT

- Provider: Deepgram
- Mode: prerecorded upload transcription
- Current UX fit: push-to-talk or hold-to-talk turns, not live partial transcription

### TTS

- Provider: Deepgram
- Mode: WebSocket streaming TTS with buffered incremental text chunks and final flush
- Output currently returned as raw PCM chunks at `24000 Hz`

## Module Boundaries

### 1. Harness Layer

Files:

- `src/harness/types.ts`
- `src/harness/pi-coding-agent.ts`
- `src/harness/claude-code-cli.ts`
- `src/extensions/scheduler.ts`
- `src/extensions/memory.ts`
- `src/agent/memory/index.ts`
- `src/orchestrator/turn-coordinator.ts`
- `src/tasks/scheduler-runner.ts`
- `src/notifications/store.ts`
- `src/realtime/socket-server.ts`

Purpose:

- hide the concrete agent runtime
- provide one `runTurn()` entry point
- return normalized `HarnessEvent` values through an async iterator
- provide scheduler primitives and persistent memory under `~/.overwatch/memory`
- serialize foreground turns and background scheduled jobs through one coordinator
- publish durable notifications for background work

Current interface:

- `OrchestratorHarness.runTurn(request)`

Request shape:

- prompt text
- optional working directory
- optional abort signal

Current normalized event types:

- `session_init`
- `text_delta`
- `assistant_message`
- `tool_call`
- `result`
- `error`

Important implementation note:

- the current Claude CLI wrapper only emits the event types we actually need right now
- it intentionally discards most raw CLI event noise
- if later tmux orchestration needs more event fidelity, add new normalized event types rather than leaking raw Claude JSON throughout the codebase

### 2. STT Layer

Files:

- `src/stt/types.ts`
- `src/stt/deepgram.ts`

Purpose:

- accept uploaded audio bytes from the client-facing backend route
- return a normalized transcript result

Current interface:

- `SttAdapter.transcribe(request)`

Request shape:

- audio bytes
- mime type
- optional language
- optional abort signal

Current implementation details:

- sends a standard HTTP POST to `https://api.deepgram.com/v1/listen`
- uses model `nova-3`
- enables punctuation and smart formatting
- sends Deepgram `keyterm` hints for `Claude`, `Codex`, and `tmux` so those terms are more likely to be transcribed correctly with Nova-3
- returns the transcript plus raw provider JSON

Important constraint:

- this is not a live-streaming STT path
- it is intentionally optimized for v1 push-to-talk UX
- frontend builders should assume the backend only returns a transcript after the user finishes speaking

### 3. TTS Layer

Files:

- `src/tts/types.ts`
- `src/tts/deepgram.ts`
- `src/shared/async-queue.ts`

Purpose:

- accept streaming text chunks from the harness
- feed them into Deepgram incrementally
- emit normalized audio events as chunks arrive

Current interface:

- `TtsAdapter.synthesize(request)`

Request shape:

- async iterable of text chunks
- optional abort signal

Current output event types:

- `audio_chunk`
- `marker`
- `error`

Current Deepgram-specific behavior:

- connects to Deepgram over WebSocket
- uses model `aura-2-aries-en` by default
- sends raw PCM `linear16` at `24000 Hz`
- batches small harness deltas into larger text chunks before sending `Speak` messages
- sends `Flush` at the end of the turn so Deepgram emits the remaining audio

Important frontend implication:

- the current TTS output is raw PCM, not MP3 or WAV
- a frontend cannot consume this directly without a decoding/playback strategy
- another agent building the frontend should either:
  - add a backend audio packaging layer, or
  - add a browser playback path for streamed PCM

For mobile-first web, the safer path is still:

- keep the provider output as streamed PCM
- wrap streamed PCM into a frontend-friendly transport contract before building the polished UI

### 4. Shared Contracts

Files:

- `src/shared/events.ts`
- `src/shared/async-queue.ts`

Purpose:

- define cross-layer event types
- provide a reusable async queue for streaming adapters

This layer is the most important surface for future extensibility.

If another harness or speech provider is added:

- adapt it into the shared event types
- do not let provider-specific events escape into higher layers

## HTTP Surface

File:

- `src/index.ts`

Current implemented routes:

### `GET /health`

Purpose:

- liveness check
- quick confirmation of which harness and provider adapters are wired

Response:

- `status`
- current harness label
- current realtime transport label
- current TTS adapter label
- current STT adapter label

### `GET /debug/harness`

Purpose:

- test the Claude Code CLI wrapper directly
- inspect normalized harness events

Input:

- query param `prompt`

Response:

- JSON array of normalized harness events

Usefulness:

- confirms that non-interactive Claude CLI streaming still works
- helps debug prompt handling before the frontend exists

### `GET /debug/tts`

Purpose:

- test Cartesia TTS directly

Input:

- query param `text`

Response:

- JSON array summarizing returned TTS events
- `audio_chunk` events report byte counts, not inline audio payloads


Usefulness:

- confirms the Cartesia credentials and WebSocket flow work

### `POST /debug/stt`

Purpose:

- test Deepgram transcription directly

Input:

- raw request body audio bytes
- `Content-Type` header describing the audio format
- optional `language` query param

Response:

- normalized transcript object plus raw provider JSON

Usefulness:

- confirms the STT credentials and audio upload path work

### `POST /api/v1/stt`

Purpose:

- accept recorded audio upload and return transcript JSON
- support the mobile app flow of `record -> transcribe -> send transcript into the realtime turn channel`

### `GET /api/v1/ws`

Purpose:

- provide the realtime control-plane socket
- carry foreground turn events and background notification events over one bidirectional channel
- serve as the primary orchestration transport for mobile text turns, transcript-derived voice turns, notifications, and acknowledgements

## Current End-To-End State

Implemented and verified:

- Claude Code CLI can be run non-interactively through the backend and parsed into normalized events
- Cartesia returns real TTS audio chunks
- Deepgram returns real STT transcripts for uploaded WAV audio
- the WebSocket control plane serves as the only turn-execution transport

Not implemented yet:

- tmux discovery, registry, capture, send, and copy/paste
- browser/mobile frontend hardening beyond the current control-plane slice

## Frontend-Relevant Constraints

These are the backend truths a frontend agent should assume.

### Stable assumptions

- the backend is intended to be the only thing talking to Claude CLI, Cartesia, and Deepgram
- the client should not call third-party providers directly
- the client should treat the backend as the single voice/orchestration authority
- the backend is designed to be reachable remotely later, for example over Tailscale

### Unstable assumptions

- current debug routes are not the final app contract
- current TTS output format may change from raw PCM to a more browser-friendly transport
- current harness implementation may later switch from Claude CLI wrapper to `pi-coding-agent`

### Recommended frontend contract direction

The mobile client should use:

- `POST /api/v1/stt` for recorded audio transcription
- `GET /api/v1/ws` for all turn execution, notifications, and acknowledgements

This keeps media ingestion separate from the realtime control plane while keeping turn execution on a single transport.

## Configuration

File:

- `src/config.ts`

Current environment variables:

- `PORT`
- `DEEPGRAM_API_KEY`
- `DEEPGRAM_TTS_MODEL`

Current Deepgram TTS voice choice:

- model name defaults in `src/tts/deepgram.ts`

This is a deliberate temporary choice and should be treated as implementation detail, not frontend configuration.

## Why tmux Is Deliberately Not In This Layer Yet

That is intentional because:

- the harness and speech seams needed to be proven first
- tmux/session logic should sit above the harness layer, not inside it

When tmux support lands, it should become a separate backend subsystem with its own modules, probably:

- `src/tmux/`
- `src/registry/`
- `src/bridge/`

Those modules should consume normalized harness events, not raw Claude CLI JSON.

## Rejected Alternatives

### Coupling tmux logic directly to Claude Code CLI

Rejected because it would make future harness swaps expensive and would leak CLI-specific behavior through the backend.

### Coupling the frontend directly to Cartesia or Deepgram

Rejected because it would push provider auth and provider-specific protocol concerns into the client and make later swaps painful.

### Building the frontend before documenting the backend contract

Rejected because the frontend would be forced to invent assumptions about routes, event streams, and audio playback that are likely to change.

## Guidance For The Next Agent

If the next task is “build the frontend,” do this first:

1. read this doc
2. add a real turn route to the backend
3. choose the audio transport contract the browser will consume
4. only then build the mobile-first web UI

If the next task is “build tmux orchestration,” do this:

1. keep tmux modules outside `src/harness/`
2. keep harness events normalized
3. do not add tmux knowledge into the STT/TTS/provider layers
