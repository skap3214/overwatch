# Overwatch protocol

Canonical wire-format definitions, single source of truth for the cross-runtime protocol used between mobile, cloud orchestrator, relay, and Mac session-host daemon.

## Layout

```
schema/
├── envelope.schema.json        # top-level envelope (carries protocol_version)
├── harness-event.schema.json   # Tier 1 canonical + Tier 2 provider_event union
├── harness-command.schema.json # submit_text | submit_with_steer | cancel
└── server-message.schema.json  # RTVI extensions (orchestrator ↔ mobile)
```

## Codegen

The schema is consumed by both runtimes via codegen:

- TypeScript: `npm run protocol:gen:ts` — generates `packages/shared/src/protocol/types.generated.ts` via [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript).
- Python: `npm run protocol:gen:py` — generates `pipecat/overwatch_pipeline/protocol/generated/*.py` via [`datamodel-code-generator`](https://github.com/koxudaxi/datamodel-code-generator) (pydantic v2).

`npm run protocol:gen` runs both. `npm run protocol:check` regenerates and fails if anything drifted — that's the CI guard.

## Versioning

`envelope.protocol_version` is a string of the form `MAJOR.MINOR`. The orchestrator and daemon both refuse mismatched majors during the `client-ready ↔ bot-ready` handshake.

## Validation

- TypeScript: outbound messages are constructed via generated types, so they cannot be malformed at the source. Inbound on the daemon side is validated structurally inside `AdapterProtocolServer.onMessage` (kind + allowlist + token check) — there is no runtime JSON-Schema validator wired in today.
- Python: `pydantic` validates inbound messages on the orchestrator side; outbound is constructed via generated models.

## Editing

Make all schema changes in `schema/` and re-run codegen. Never edit generated files by hand.
