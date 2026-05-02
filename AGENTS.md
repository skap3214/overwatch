# AGENTS.md

## Project Overview

Overwatch is a voice + harness-bridge orchestrator for tmux-hosted coding agents
(Claude Code, Pi, Hermes; future Codex / cursor-agent). The voice loop runs
in the cloud (Pipecat Cloud, Python) and the harness fleet stays on the user's
Mac via the session-host daemon (TypeScript). The mobile app is a thin
WebRTC client.

See `docs/plans/voice-harness-bridge-overhaul-2026-05-01.md` for the full
end-state architecture.

## Repo layout

```
protocol/                       Canonical JSON Schema for the wire protocol.
                                Codegen target for both runtimes.
pipecat/                        Python pipecat pipeline. Deployed to Pipecat Cloud.
packages/
├── session-host-daemon/        TS daemon that runs on the user's Mac.
│                               Owns tmux + harness adapters. No voice code.
├── cli/                        TS CLI (overwatch setup/start/status/update).
└── shared/                     TS shared types + crypto + protocol codegen output.
overwatch-mobile/               RN/Expo app — Pipecat RN client.
relay/                          CF Workers relay — narrowed: signaling +
                                Pipecat Cloud session minting + orchestrator-
                                Mac harness command bridge.
docs/                           Research, plans, architecture decisions.
```

## Documentation System

| Path | Purpose |
| --- | --- |
| `docs/research/` | Research findings, comparisons, and technical explorations |
| `docs/plans/` | Implementation plans and proposed execution sequences |
| `docs/architecture/` | Accepted and implemented architecture decisions only |
| `docs/insights.md` | Small observations and gotchas worth revisiting |

## Documentation Rules

1. Before starting work, read the existing docs to avoid duplicating research or contradicting prior decisions.
2. After completing meaningful work, update the relevant docs.
3. If new information changes a previous finding, update the original doc and note what changed and why.
4. Cross-reference related docs whenever a plan, research note, or implemented decision depends on another document.

## Distribution

Private alpha — Soami + a small number of trusted testers. We host the cloud
orchestrator (Pipecat Cloud); users install only the Mac daemon and the mobile
app. OSS code is public; BYOK and self-host (Y2) paths are documented but not
built into `install.sh`.

## Protocol changes

Edit JSON Schemas in `/protocol/schema/` and run `npm run protocol:gen` to
regenerate TS + Python types. CI fails on drift via `npm run protocol:check`.
Never edit generated files by hand.
