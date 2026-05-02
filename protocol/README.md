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

- TypeScript: `npm run protocol:gen` — generates `packages/shared/src/protocol/types.generated.ts` via [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript).
- Python: `make -C pipecat protocol-gen` — generates `pipecat/overwatch_pipeline/protocol/types_generated.py` via [`datamodel-code-generator`](https://github.com/koxudaxi/datamodel-code-generator) (pydantic v2).

CI runs both and fails if generated files drift from `schema/`.

## Versioning

`envelope.protocol_version` is a string of the form `MAJOR.MINOR`. The orchestrator and daemon both refuse mismatched majors during the `client-ready ↔ bot-ready` handshake.

## Validation

- TypeScript: `ajv` validates inbound messages; outbound is constructed via generated types so it can't be malformed at the source.
- Python: `pydantic` validates inbound messages; outbound is constructed via generated models.

## Editing

Make all schema changes in `schema/` and re-run codegen. Never edit generated files by hand.
