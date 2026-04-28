# 004 — Harness Pluggability

**Status:** Implemented (2026-04-22)
**Related:** [001-backend-architecture.md](001-backend-architecture.md), [005-hermes-bridge.md](005-hermes-bridge.md), [../plans/hermes-gateway-plan-2026-04-22.md](../plans/hermes-gateway-plan-2026-04-22.md)

## Overview

The Overwatch backend's "harness" — the LLM brain executed each turn — is a published extension point. A single async-iterable interface (`OrchestratorHarness.runTurn`) is implemented by three providers today, with capabilities advertised to the mobile app so UI affordances appear/disappear based on what the active provider supports.

## The interface

```typescript
// src/harness/types.ts
export interface OrchestratorHarness {
  runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent>;
}
```

Events the harness yields (see `src/shared/events.ts`):

| Event | Routed to socket | Routed to TTS | Notes |
|---|---|---|---|
| `text_delta` | ✅ | ✅ | Final assistant text — speakable |
| `reasoning_delta` | ✅ | ❌ | Agent's internal thinking — rendered, never spoken |
| `assistant_message` | ✅ | — | Full message body, terminal |
| `tool_call` | ✅ | — | Drives the tool-pill UX |
| `error` | ✅ | — | Propagates as `turn.error` |
| `result` / `session_init` | informational | — | Bookkeeping |

**The TTS isolation invariant** is the load-bearing rule: `reasoning_delta` MUST NOT reach the TTS adapter. A regression test (`tests/coordinator-reasoning-tts.test.ts`) verifies this with a fake harness emitting both kinds and a capturing TTS that asserts it received only the spoken text.

## Selection

`HARNESS_PROVIDER` env var (or `~/.overwatch/config.json` `harness` field) picks the provider at boot:

| Provider | When to use |
|---|---|
| `pi-coding-agent` (default) | Anthropic via OAuth, library-based. Default Overwatch experience. |
| `claude-code-cli` | Spawns the `claude` CLI as a subprocess. Mirrors the desktop CLI exactly. |
| `hermes` | Routes turns to a locally-running Hermes Agent gateway (Nous Research). Cron, skills, memory, and personality come from the user's Hermes config. |

Switching providers requires a backend restart. The mobile UI does not switch the provider directly; it surfaces the active provider and capabilities via a `harness.snapshot` envelope sent on connection.

## Capabilities

Each provider declares what it can natively do (`src/harness/capabilities.ts`):

```typescript
interface HarnessCapabilities {
  hasNativeCron: boolean;
  hasNativeSkills: boolean;
  hasNativeMemory: boolean;
  hasSessionContinuity: boolean;
  emitsReasoning: boolean;
  voiceConvention: "soul-md" | "instructions-prefix" | "none";
}
```

The mobile app reads these via `harness.snapshot` to gate UI:
- `SkillsPill` only renders when `hasNativeSkills`.
- `MonitorEditForm`'s skills field appears only with `hasNativeSkills`.
- `ReasoningBlock` reserved space allocates only when `emitsReasoning`.
- Voice prep (e.g. wrapping in `<voice>...</voice>`) happens inside the harness, not the mobile app — `voiceConvention` is informational.

## Adding a new provider

1. Create `src/harness/<name>.ts` implementing `OrchestratorHarness`.
2. Add an entry to `CAPABILITIES` in `src/harness/capabilities.ts`.
3. Extend the `HARNESS_PROVIDER` enum in `src/config.ts`.
4. Add a branch in `src/harness/index.ts:makeHarness`.
5. If the provider has a daemon, add status/use/off subcommands under the `overwatch` CLI mirroring `hermes` (`packages/cli/src/commands/`).

## Files

| Concern | File |
|---|---|
| Interface | `src/harness/types.ts` |
| Capabilities table | `src/harness/capabilities.ts` |
| Factory | `src/harness/index.ts` |
| Default provider | `src/harness/pi-coding-agent.ts` |
| Claude CLI provider | `src/harness/claude-code-cli.ts` |
| Hermes provider | `src/harness/hermes-agent.ts` |
| TTS isolation test | `tests/coordinator-reasoning-tts.test.ts` |
