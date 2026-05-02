# Session-host daemon

TypeScript daemon that runs on the user's Mac. Owns tmux + the local harness fleet (Claude Code, Pi, Hermes). Speaks the harness adapter protocol back to the cloud orchestrator over the existing CF Workers relay.

**No voice code lives here.** STT, TTS, VAD, smart-turn, and the inference gate are all in the cloud orchestrator (`pipecat/`).

See `docs/plans/voice-harness-bridge-overhaul-2026-05-01.md` §4.5 for the full architecture.

## Layout

```
src/
├── adapter-protocol/            # NEW — speaks the harness adapter protocol
│   ├── server.ts                # receives HarnessCommand, dispatches
│   ├── token-validator.ts       # per-user + per-session token check
│   ├── command-allowlist.ts     # rejects unknown command kinds
│   ├── audit-log.ts             # JSONL of every cloud-originated command
│   ├── catch-all-logger.ts      # env-gated JSONL of every wire event
│   ├── stale-suppression.ts     # correlation_id ring buffer
│   └── cancellation.ts          # per-provider cancel + cancel_confirmed
├── harness/                     # lifted from src/harness/
├── tmux/                        # lifted from src/tmux/
├── notifications/               # lifted from src/notifications/
├── scheduler/                   # lifted from src/scheduler/
├── extensions/                  # lifted from src/extensions/ (skills system)
├── tasks/                       # lifted from src/tasks/
├── agent/                       # lifted from src/agent/
├── routes/                      # lifted from src/routes/
├── relay-client/                # narrowed realtime client
├── shared/protocol/             # TS protocol types (codegenned, imported from packages/shared)
├── config.ts
└── index.ts
```
