# Decision 002: Product Vision and Direction

**Status:** ACCEPTED
**Date:** 2026-04-07
**Scope:** Overall product direction and architecture evolution
**Related Docs:** [001-backend-architecture.md](001-backend-architecture.md), [../plans/mvp-plan-2026-04-05.md](../plans/mvp-plan-2026-04-05.md)

## Decision

Overwatch is a voice-controlled orchestration layer that sits between coding agents running on various devices (local machines, sandboxed cloud environments) and a portable mobile interface. The user interacts with their agents through voice on a phone or tablet, and an orchestrator agent manages the underlying sessions.

## Core Concept

The user has coding agents (Claude Code, Codex, etc.) running in tmux sessions across their devices. Today, controlling those agents from a phone means typing, which is impractical. Overwatch replaces typing with voice: speak a command, the orchestrator interprets it, dispatches it to the right agent or tmux pane, and speaks the result back.

The long-term vision is that any user can set up this system on their own infrastructure and use it on the go from any device.

## Architecture Layers

```
iOS App (voice thin client)
    |
    | (Tailscale / public endpoint)
    |
Overwatch Service (orchestrator + STT + TTS)
    |
    |--- Agent sessions (tmux panes, sandboxed containers)
    |--- tmux control (discover, read, inject, copy between panes)
```

### 1. Mobile Client (iOS app)

- React Native (Expo) iOS app with react-native-audio-api for PCM playback
- Voice recording and TTS audio playback
- Transcript display
- Push notifications (agent needs attention, errors, task completion)
- Connects to the Overwatch service over the network

The mobile client is a thin voice interface. All intelligence and orchestration lives server-side.

### 2. Overwatch Service (backend)

- Node/TypeScript on Hono
- STT: Deepgram (prerecorded upload, push-to-talk)
- TTS: Deepgram Aura (WebSocket streaming PCM)
- Orchestrator harness: pi-coding-agent (Anthropic API, session persistence, coding tools)
- tmux orchestration layer (planned): discover panes, read output, inject text, copy between panes
- User auth and session management

### 3. Agent Runtime Layer

Agents run wherever the user has them:

- **Local machine**: tmux sessions with Claude Code, Codex, or other agents. Overwatch reads and writes to these panes.
- **Sandboxed cloud** (future): per-session containers (E2B, Modal, or self-hosted Docker) for users who want agents without local infrastructure.

## What Changed From the Original Plan

### Harness: Claude Code CLI replaced with pi-coding-agent

The original backend used `claude -p` as a subprocess. This had no session persistence, cold-started every turn, and limited control. Replaced with pi-coding-agent running as a library, which provides:

- Persistent conversation across turns
- Streaming token events
- Coding tools (bash, read, write, edit, grep, find, ls)
- OAuth auth via `~/.pi/agent/auth.json` (no API key management needed)

### Client: web app replaced with native iOS direction

The initial web frontend (src/web/) worked for desktop but hit persistent issues with Safari mobile audio (AudioContext restrictions on iOS). A native iOS app solves:

- Reliable audio recording and playback
- Push notifications
- Background audio
- No browser audio API workarounds

The web frontend remains as a development/desktop fallback.

### Scope: from personal tool to distributable system

The original plan assumed the user's own tmux/Tailscale setup. The updated vision adds a goal of making the entire system easy to set up for other users:

1. Build the iOS app + orchestrator agent (current priority)
2. Make the backend easy to self-host (Docker, clear setup docs)
3. Add sandboxed cloud execution so users without local tmux can still use the system
4. Package the whole thing so someone can go from zero to voice-controlled agents on their phone

## Build Sequence

### Phase 1: Core voice loop (current)

- pi-coding-agent harness with session persistence
- STT + TTS pipeline
- iOS app with push-to-talk, transcript, audio playback

### Phase 2: tmux orchestration

- Pane discovery and registry
- Output capture and text injection
- Cross-pane copy/paste
- Orchestrator agent has tmux tools

### Phase 3: Distribution

- Docker packaging for the backend
- Setup CLI or script for new users
- Sandboxed cloud execution option (E2B or similar)
- App Store distribution

## Rejected Alternatives

### Building a product for users with no local infrastructure first

Rejected because the core use case is voice control of existing agent sessions. The sandboxed cloud path is a later addition, not the foundation.

### Staying with the web frontend for mobile

Rejected because iOS Safari audio restrictions make reliable voice interaction too fragile. Native iOS is the right path for the primary use case (phone as voice remote).

### Using Claude Code CLI as the long-term harness

Rejected because it has no session persistence, spawns a new process per turn, and provides less control than a library-based agent.
