# AGENTS.md

## Project Overview

Overwatch is a voice + harness-bridge orchestrator for tmux-hosted coding agents
(Claude Code, Pi, Hermes; future Codex / cursor-agent). The voice loop runs
in the cloud (Pipecat Cloud, Python) and the harness fleet stays on the user's
Mac via the session-host daemon (TypeScript). The mobile app is a thin
WebRTC client.

Start with `docs/architecture/007-post-overhaul-architecture.md` for the canonical
"what is" doc. Topology, components, wire protocol, deploy, invariants. The
implemented plan that produced this shape is at
`docs/plans/implemented/voice-harness-bridge-overhaul-2026-05-01.md`.

## Repo layout

```
protocol/                       Canonical JSON Schema for the wire protocol.
                                Codegen target for both runtimes.
pipecat/                        Python pipecat pipeline. Deployed to Pipecat Cloud.
packages/
├── session-host-daemon/        TS daemon that runs on the user's Mac.
│                               Owns tmux + harness adapters. No voice code.
├── cli/                        TS CLI (overwatch setup/start/status/update).
└── shared/                     TS shared types + protocol codegen output.
overwatch-mobile/               RN/Expo app — Pipecat RN client.
relay/                          CF Workers relay — Pipecat Cloud session
                                minting + per-user UserChannel DO routing
                                orchestrator ↔ daemon traffic.
docs/                           Research, plans, architecture decisions.
```

## Documentation System

| Path | Purpose |
| --- | --- |
| `docs/research/` | Research findings, comparisons, and technical explorations |
| `docs/plans/` | Active or proposed plans that haven't shipped yet |
| `docs/plans/implemented/` | Plans that have shipped — frozen historical context |
| `docs/architecture/` | Accepted and implemented architecture — current state of the system |
| `docs/insights.md` | Small observations and gotchas worth revisiting |

## Documentation Rules

1. Before starting work, read the relevant architecture doc (start at `docs/architecture/INDEX.md`). Plans describe intent at a point in time; architecture docs describe what is.
2. After completing meaningful work, update the relevant architecture doc — that's the live one. Plans freeze at implementation time.
3. When a plan ships, move it from `docs/plans/` to `docs/plans/implemented/` and bump its Status line.
4. If a plan in `implemented/` disagrees with the current architecture, the architecture doc wins. Don't update implemented plans except to add a Status / supersession note.
5. Stale architecture docs (describing a system that no longer exists) should be deleted, not stub-replaced. A future agent reading 400 lines of fiction internalizes the wrong shape before realizing it's outdated.
6. Cross-reference related docs whenever a plan, research note, or implemented decision depends on another document.

## Distribution

Private alpha — Soami + a small number of trusted testers. We host the cloud
orchestrator (Pipecat Cloud); users install only the Mac daemon and the mobile
app. OSS code is public; BYOK and self-host (Y2) paths are documented but not
built into `install.sh`.

## Protocol changes

Edit JSON Schemas in `/protocol/schema/` and run `npm run protocol:gen` to
regenerate TS + Python types. CI fails on drift via `npm run protocol:check`.
Never edit generated files by hand.
