# Docs README

Start here before extending Overwatch.

## Current State

- Primary backend language: TypeScript on Node
- Primary orchestrator harness: pi-coding-agent (library, Anthropic API via OAuth)
- Current orchestration support beyond speech: scheduler support, persistent memory under `~/.overwatch/memory`, realtime notifications, scheduled monitor snapshots over the WebSocket control plane, and a bidirectional control-plane slice
- Current STT provider: Deepgram prerecorded transcription
- Current TTS provider: Cartesia WebSocket streaming TTS
- Current backend status: realtime WebSocket endpoint implemented, notification store and scheduler runner implemented, dedicated STT endpoint implemented, web frontend exists as dev fallback, iOS app is next
- Current backend routes: `/health`, `/debug/harness`, `/debug/tts`, `/debug/stt`, `/api/v1/stt`, `/api/v1/ws`
- Direction: native iOS app as primary client, tmux orchestration layer next, then distribution packaging

## Read In This Order

1. [architecture/INDEX.md](architecture/INDEX.md)
2. [plans/mvp-plan-2026-04-05.md](plans/mvp-plan-2026-04-05.md)
3. [research/initial-research-2026-04-05.md](research/initial-research-2026-04-05.md)
4. [insights.md](insights.md)

## Source Of Truth

- [architecture/001-backend-architecture.md](architecture/001-backend-architecture.md)
- [architecture/002-product-vision.md](architecture/002-product-vision.md)

## Notes For Future Agents

- Treat `architecture/` as the source of truth for what is implemented and deliberately chosen.
- Treat `plans/` as proposed sequencing, not necessarily current behavior.
- If you change the frontend/backend contract, update the architecture doc first.
