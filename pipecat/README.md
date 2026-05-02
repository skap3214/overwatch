# Overwatch cloud orchestrator (pipecat)

Python pipecat pipeline deployed to Pipecat Cloud. The voice loop and harness boundary live here.

See `docs/plans/voice-harness-bridge-overhaul-2026-05-01.md` §4.3 for the full architecture.

## Layout

```
overwatch_pipeline/
├── bot.py                       # entrypoint; pipecat pipeline composition
├── inference_gate.py            # InferenceGateState + Pre/Post gates
├── harness_router.py            # registry-driven event routing
├── harness_bridge.py            # user input → harness command
├── harness_adapter_client.py    # interface + RelayClient impl
├── deferred_update_buffer.py    # buffered inject prepend
├── idle_report.py               # idle-report processor
├── say_text_voice_guard.py      # suppresses double-output during say-text
├── frames.py                    # custom pipecat frames
├── voices.py                    # Cartesia voice registry
├── settings.py                  # env config
├── protocol/                    # codegenned types from /protocol/schema/
├── observability/               # OTel + metrics + structured logs
└── auth/                        # per-user + per-session token validation
```

## Local dev

```bash
cd pipecat
uv sync                          # install deps
uv run pytest                    # run tests
uv run python -m overwatch_pipeline.bot  # local run (against scripted harness)
```

## Deploy

```bash
pcc agent deploy                 # uses ~/.config/pipecatcloud (after pcc auth login)
```

CI deploys via service API key. Manual deploys from a developer's laptop use `pcc auth login`.
