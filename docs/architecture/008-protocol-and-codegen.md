# 008 — Protocol and Codegen

**Status:** Implemented (2026-05-02)
**Related:** [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md), [`/protocol/README.md`](../../protocol/README.md)

The wire protocol between mobile, relay, orchestrator, and daemon is JSON-Schema-first. The schemas live in `/protocol/schema/` and are the single source of truth; both runtimes consume codegenned types and never edit generated files by hand.

## Schemas

```
protocol/schema/
├── envelope.schema.json         top-level wrapper
├── harness-command.schema.json  submit_text | submit_with_steer | cancel | manage_monitor
├── harness-event.schema.json    Tier 1 canonical + Tier 2 provider_event
└── server-message.schema.json   RTVI extensions (orchestrator ↔ mobile)
```

`Envelope`:

```json
{
  "protocol_version": "1.0",
  "kind": "harness_command" | "harness_event" | "server_message",
  "id": "<ulid>",
  "timestamp": "2026-05-02T22:38:09Z",
  "session_token": "<hmac-derived per-session token, optional only for the initial pairing exchange>",
  "payload": { ... }   // shape selected by kind
}
```

`HarnessCommand` discriminator: `kind`. Four variants only — the daemon's `COMMAND_ALLOWLIST` rejects everything else and audit-logs the rejection:

| Command | Purpose |
|---|---|
| `submit_text` | Start a normal user turn. |
| `submit_with_steer` | Cancel/replace an in-flight user turn. |
| `cancel` | Cancel an in-flight turn without replacement. |
| `manage_monitor` | UI monitor management command (`list`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `run_now`, `list_runs`, `read_run`). It is authenticated like every other daemon command but bypasses the user-turn inference path. |

`HarnessEvent` is two-tiered:

| Tier 1 (canonical, cross-provider) | Tier 2 (provider-specific) |
|---|---|
| `text_delta`, `assistant_message`, `reasoning_delta`, `tool_lifecycle` (`start`/`progress`/`complete`), `session_init`, `session_end`, `error`, `cancel_confirmed`, `agent_busy`, `agent_idle` | `provider_event { provider, kind, payload }` |

Tier 2 is the safety valve: anything an adapter sees on the wire that doesn't map cleanly to Tier 1 surfaces as a `provider_event`. The orchestrator's `HARNESS_EVENT_CONFIGS` decides what to do with each `<provider>/<kind>` pair.

`agent_busy` / `agent_idle` express adapter-owned non-turn work. The first consumer is pi-coding-agent compaction: while `agent_busy { phase: "compaction" }` is active, the orchestrator's inference gate refuses all harness commands but still allows local TTS interruption. `agent_idle` clears the state and lets pending user input drain.

`ServerMessage` carries non-event RTVI traffic between orchestrator and mobile. The daemon can also emit these as envelope `server_message` payloads; the orchestrator validates and forwards them over RTVI:

| Message | Purpose |
|---|---|
| `harness_state` | Narrow compatibility snapshot for the inference gate (`active_target`, `in_flight`, optional active correlation). |
| `harness_snapshot` | Mobile-facing provider snapshot: active provider id, active target namespace, capabilities, provider registry entries, in-flight state. |
| `monitor_snapshot` | Monitor rows plus action metadata (`source`, provider id, create/edit/delete/pause/resume/run/history support). |
| `skills_snapshot` | Active skill list for native skill providers, currently Hermes. |
| `monitor_action_result` | Correlated response to a mobile `monitor_action` / daemon `manage_monitor` request. |
| `notification` | Typed notification hydration for the mobile notification store. |
| `error_response`, `interrupt_intent`, `user_text`, `harness_event` | Existing auxiliary/control messages. |

## Codegen

| Target | Generator | Output | Command |
|---|---|---|---|
| TypeScript | [json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript) | `packages/shared/src/protocol/types.generated.ts` (single file) | `npm run protocol:gen:ts` |
| Python | [datamodel-code-generator](https://github.com/koxudaxi/datamodel-code-generator) (pydantic v2) | `pipecat/overwatch_pipeline/protocol/generated/*.py` (one file per schema) | `npm run protocol:gen:py` |

`npm run protocol:gen` runs both. The `codegen-py.sh` script is configured for deterministic, mypy-clean output:

- `--use-annotated --field-constraints` — emits `Annotated[str, Field(pattern=...)]` instead of `constr(...)`, which mypy doesn't accept.
- `--disable-timestamp` — no clock-time in generated headers, so re-running is a no-op.
- `--use-standard-collections --use-union-operator` — modern Python syntax (`list[X]`, `X | None`).

## Drift detection

`npm run protocol:check` (script: `scripts/codegen-check.mjs`) snapshots the existing TS file plus every `.py` file in `pipecat/.../protocol/generated/`, runs `protocol:gen`, and diffs. Any drift fails the build.

The Python side snapshots the whole directory (multi-file output), not a single file — re-generated schemas can add or remove files and the check catches it.

## Validation surface

- **Python (orchestrator)** — `pydantic` validates inbound `HarnessEvent`s in `RelayClient._reader_loop` via `HarnessEvent.model_validate(payload)` and inbound daemon `ServerMessage`s via `ServerMessage.model_validate(payload)`. Outbound commands are constructed via the generated models (`SubmitText`, `SubmitWithSteer`, `Cancel`, `ManageMonitor`) so they can't be malformed at source.
- **TypeScript (daemon)** — there is no runtime JSON-Schema validator wired in today; structural checks happen inline in `AdapterProtocolServer.onMessage` (kind + token + allowlist). Outbound is constructed via generated types so it can't be malformed at source.

If we later need full TS schema validation, ajv would be the obvious wire-up; the cost is ~bundle size in the daemon, which is fine. The mobile side renders RTVI events via the Pipecat client SDK and never inspects raw envelopes.

## Versioning

`envelope.protocol_version` is `MAJOR.MINOR`. Both sides reject mismatched MAJOR:

- **Orchestrator** (`harness_adapter_client.py:_reader_loop`) — logs `relay-client.protocol_version_mismatch` and drops the message; the connection survives. Forward-compat for new MINOR is implicit.
- **Daemon** (`adapter-protocol/server.ts:onMessage`) — responds with an explicit `error_response` envelope so the orchestrator surfaces the mismatch instead of timing out.

`PROTOCOL_VERSION` is `"1.0"` in both runtimes; bump together, schema-first.

## Editing the protocol

1. Edit JSON Schema in `protocol/schema/`.
2. `npm run protocol:gen`.
3. Update consumer code if the new shape isn't drop-in.
4. `npm test` (TS) + `cd pipecat && uv run pytest` (Python).
5. `npm run protocol:check` should be a no-op.

Never edit `packages/shared/src/protocol/types.generated.ts` or `pipecat/overwatch_pipeline/protocol/generated/*.py` directly. They're overwritten on every codegen run.

## Cross-runtime contract test

`tests/cross-runtime-token-contract.test.ts` is the wire-compatibility canary: it imports the mobile's `deriveSessionToken` AND the daemon's `createTokenValidator` and asserts the round-trip works under tsx's CJS/ESM interop. If either side changes its HMAC or its envelope shape without the other catching up, this test fails. The earlier per-package mobile test re-implemented HMAC inline and would not have caught divergence.
