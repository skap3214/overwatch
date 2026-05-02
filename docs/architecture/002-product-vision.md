# 002 — Product Vision and Direction

**Status:** Current
**Related:** [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md), [004-harness-pluggability.md](004-harness-pluggability.md)

## What Overwatch is

A voice-controlled orchestration layer between coding agents and a phone. The user has agents (Claude Code, Pi, Hermes, Codex-class tools) running in tmux on their Mac. Talking to those agents from a phone normally means typing — Overwatch replaces typing with voice. The user speaks; a server-side voice pipeline (STT, VAD, smart-turn, the inference gate, TTS) runs in Pipecat Cloud; the active harness on the user's Mac executes the turn; events stream back through a relay and are routed to speech, screen, or background buffer based on a registry.

The long-term goal is that anyone can run this on their phone with their own coding agents, with minimal local setup and no API-key juggling beyond a one-time `overwatch setup`.

## Why server-side voice

Voice on the Mac was tractable but fragile: WebRTC plumbing, browser audio quirks on mobile, STT/TTS latency budgets in user-space code, every release of pipecat re-shaped the realtime API surface. Moving the voice loop into a hosted Python orchestrator (Pipecat Cloud) collapses all of that into one place we control and one set of provider keys we manage. The Mac stops being a voice-app and becomes what it actually is — the place where tmux and the agents live.

The current shape and rationale are documented in [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md) and the implemented overhaul plan [../plans/implemented/voice-harness-bridge-overhaul-2026-05-01.md](../plans/implemented/voice-harness-bridge-overhaul-2026-05-01.md).

## Three runtimes, one protocol

| Runtime | Role |
|---|---|
| Phone (RN/Expo, Pipecat RN client) | Voice + typed input thin client. Joins a Daily room; renders transcripts and harness UI. |
| Pipecat Cloud orchestrator (Python) | The voice loop and the harness bridge. Architecture I — no voice LLM in the main flow. |
| Cloudflare Worker relay | Mints sessions, routes orchestrator ↔ daemon traffic via a per-user durable object. |
| Mac session-host daemon (TS/Hono) | Owns tmux + the harness fleet. Speaks the adapter-protocol back to the orchestrator. |

The wire format between all four is JSON-Schema-first; both the TS and Python sides codegen their types. See [008-protocol-and-codegen.md](008-protocol-and-codegen.md).

## Distribution

- **Today (private alpha):** Soami + a small number of trusted testers. We host the cloud orchestrator (Pipecat Cloud) and the relay (Cloudflare). Users install the Mac daemon via `overwatch setup` and run the iOS app.
- **Y2 BYOK / self-host:** documented as a future plan, not built into `install.sh`. The orchestrator is open-source under `pipecat/`; the relay is open-source under `relay/`. Anyone wanting to host their own can.
- **Public open-signup:** not in scope until billing, accounts, and provider-key management are real product surfaces.

## Build sequence (current)

1. Get a real session running through Pipecat Cloud → relay → daemon → Claude Code CLI / Pi / Hermes, with notifications and idle reports flowing.
2. Productionize the iOS app — TestFlight build, real audio routing, error UX for failed connects.
3. Self-host path — a Docker compose for the orchestrator + a self-hosted relay variant, both reading from the same protocol schemas.
4. Sandboxed-cloud agent execution (E2B / Modal) — for users without a local tmux to drive.

## Why a registry for events

The orchestrator never decides ad-hoc whether to speak something. Every event the harness emits is a wire event with a discriminated type; `HARNESS_EVENT_CONFIGS` maps each `<type>` (Tier 1) or `<provider>/<kind>` (Tier 2) to one of `speak`, `inject`, `ui-only`, `drop`. New providers don't need orchestrator changes — they just emit `provider_event` envelopes, the registry decides routing, and unknown events are caught by a default policy that never speaks. This is the load-bearing rule: voice is a deliberate decision per event, never a side effect.

## Rejected alternatives

- **Voice loop on the Mac.** Was the original shape. Killed because the latency, pipecat API churn, and audio plumbing were eating product time that should have been going into harness behavior.
- **Web frontend for mobile.** Killed because iOS Safari audio restrictions made push-to-talk too fragile. Native RN with Pipecat RN client is the only real path.
- **Per-provider voice loops.** Tempting (each agent could have its own STT/TTS preference). Killed because it makes turn-taking, idle-reporting, and cancellation hopelessly stateful per provider. One voice loop, one registry.
- **End-to-end encryption with `nacl.box`.** The pre-overhaul architecture wrapped every relay envelope in nacl.box. Removed because the relay now never sees voice or harness payloads in cleartext that aren't already inside TLS; per-session HMAC tokens prove integrity per command without the operational cost of a separate keypair scheme.
