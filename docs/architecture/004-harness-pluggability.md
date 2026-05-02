# 004 — Harness Pluggability

**Status:** Current
**Related:** [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md), [005-hermes-bridge.md](005-hermes-bridge.md)

The "harness" — the LLM-driven brain that executes a user turn — is a published extension point on the Mac daemon. A single async-iterable interface, a registry of capabilities, and three implementations behind a one-file factory. Adding a new provider should be one new file under `packages/session-host-daemon/src/harness/providers/` plus one line in the registry.

## The interface

```typescript
// packages/session-host-daemon/src/harness/types.ts
export interface OrchestratorHarness {
  readonly provider: string;
  runTurn(request: HarnessTurnRequest): AsyncIterable<AdapterEvent>;
}
```

`HarnessTurnRequest` carries `prompt`, `correlation_id`, optional `abortSignal`. The harness yields raw `AdapterEvent`s — pre-routing, pre-stamping. The daemon's `AdapterProtocolServer` stamps `correlation_id` and `target` on each event and forwards to the orchestrator over the relay.

## Wire shape (post-overhaul)

The wire-level event union the orchestrator sees is a discriminated type with two tiers:

| Tier 1 — canonical, cross-provider | Tier 2 — provider-specific |
|---|---|
| `text_delta`, `assistant_message`, `reasoning_delta`, `tool_lifecycle` (`start`/`progress`/`complete`), `session_init`, `session_end`, `error`, `cancel_confirmed` | `provider_event { provider, kind, payload }` |

Adapters never silently drop wire events. Anything they observe that doesn't map cleanly to Tier 1 surfaces as Tier 2 — the orchestrator's `HARNESS_EVENT_CONFIGS` then decides routing. This is what lets us add a new provider without touching the orchestrator.

The orchestrator-side registry maps each event to one of four voice actions:

| Voice action | Meaning |
|---|---|
| `speak` | Text content goes to TTS, gated by `InferenceGateState`. |
| `inject` | Payload buffered by `DeferredUpdateBuffer` to prepend on the next user turn. Never spoken. |
| `ui-only` | Forwarded to mobile UI as an `OutputTransportMessageFrame`. Not spoken. |
| `drop` | No-op with a debug log. |

Default policy for unmapped events is `ui-only` in dev, `drop` in prod. Promoting a new event to `speak` requires an explicit registry entry.

## Selection

The active provider is picked at daemon boot via the `HARNESS_PROVIDER` env var (or `~/.overwatch/config.json`).

| Provider id | Class | When to use |
|---|---|---|
| `pi-coding-agent` (default) | `PiCodingAgentHarness` | Anthropic via OAuth, library-based. Lightweight, no external daemon. |
| `claude-code-cli` | `ClaudeCodeCliHarness` | Spawns the `claude` CLI subprocess. Mirrors the desktop CLI exactly. |
| `hermes` | `HermesAgentHarness` | Routes turns to a locally-running Hermes Agent gateway. Cron, skills, memory, and personality from `~/.hermes/config.yaml`. See [005](005-hermes-bridge.md). |

Switching providers requires a daemon restart. The mobile UI doesn't change the active provider directly — it reads `listProviders()` over `/health` and surfaces capabilities so the user knows what features apply.

## Capabilities

```typescript
// packages/session-host-daemon/src/harness/providers/types.ts
interface HarnessCapabilities {
  hasNativeCron: boolean;
  hasNativeSkills: boolean;
  hasNativeMemory: boolean;
  hasSessionContinuity: boolean;
  emitsReasoning: boolean;
  voiceConvention: "soul-md" | "instructions-prefix" | "none";
}
```

The mobile app reads these via `/health`'s `providers` field to gate UI:

- `SkillsPill` only renders when `hasNativeSkills`.
- `MonitorEditForm`'s skills field appears only with `hasNativeSkills`.
- `ReasoningBlock` only allocates space when `emitsReasoning`.
- Voice prep (e.g. wrapping in `<voice>...</voice>`) happens inside the harness, not the mobile app — `voiceConvention` is informational.

## Registration

```typescript
// packages/session-host-daemon/src/harness/providers/index.ts
export const PROVIDERS: AgentProvider[] = [
  piCodingAgentProvider,
  claudeCodeCliProvider,
  hermesAgentProvider,
];
```

Each entry declares `{id, name, tagline, description, capabilities, detect, build, installInstruction?}`. `detect()` is synchronous so building the snapshot for `/health` stays cheap; `build(ctx)` runs once at boot.

## Adding a new provider

1. Create `packages/session-host-daemon/src/harness/<name>.ts` implementing `OrchestratorHarness`. Yield Tier-1 events where the wire shape matches; emit `provider_event` for everything provider-specific.
2. Create `packages/session-host-daemon/src/harness/providers/<name>.ts` exporting the `AgentProvider` registration (capabilities, detect, build, install instruction).
3. Append your provider to `PROVIDERS` in `providers/index.ts`.
4. Add unit coverage at `packages/session-host-daemon/tests/<name>-mapping.test.ts` exercising the wire-event → AdapterEvent translation.
5. If your provider has interesting Tier-2 events that should be spoken or buffered, add entries in `pipecat/overwatch_pipeline/harness_router.py` `HARNESS_EVENT_CONFIGS`. Without a registry entry the default policy applies (`ui-only` in dev, `drop` in prod) — this is the safety valve.
6. (Optional) If your provider has its own daemon or service, add CLI subcommands under `packages/cli/src/commands/` mirroring `hermes`.

## Invariants

1. **Only user input ever produces `submit_with_steer` or `cancel`.** Background events route through the orchestrator's registry, never as commands.
2. **Reasoning is never spoken.** `reasoning_delta` is mapped to `inject`, not `speak`. Any new provider that surfaces reasoning must follow the same convention.
3. **Adapters never silently drop wire events.** Surface as `provider_event` if it doesn't fit a Tier-1 type.
4. **No voice action defaults to `speak`.** New events without a registry entry never reach TTS.

## Files

| Concern | File |
|---|---|
| Interface | `packages/session-host-daemon/src/harness/types.ts` |
| AdapterEvent shape | `packages/session-host-daemon/src/shared/events.ts` |
| Provider registry | `packages/session-host-daemon/src/harness/providers/index.ts` |
| Default provider | `packages/session-host-daemon/src/harness/pi-coding-agent.ts` |
| Claude CLI provider | `packages/session-host-daemon/src/harness/claude-code-cli.ts` |
| Hermes provider | `packages/session-host-daemon/src/harness/hermes-agent.ts` |
| Capabilities table | `packages/session-host-daemon/src/harness/capabilities.ts` |
| Per-provider mapping tests | `packages/session-host-daemon/tests/{claude-code-cli,hermes-events,pi-coding-agent}-mapping.test.ts` |
| Orchestrator routing registry | `pipecat/overwatch_pipeline/harness_router.py` |
| Orchestrator routing dispatch | `pipecat/overwatch_pipeline/harness_event_router.py` |
| Routing dispatch tests | `pipecat/tests/unit/test_harness_event_router_dispatch.py`, `test_harness_router.py` |
