# Plan: Voice-Loop Regression Harness

**Date:** 2026-05-03
**Status:** Implemented (2026-05-04)
**Related Architecture:** [../architecture/007-post-overhaul-architecture.md](../architecture/007-post-overhaul-architecture.md), [../architecture/008-protocol-and-codegen.md](../architecture/008-protocol-and-codegen.md)
**Existing test reference:** `pipecat/tests/integration/test_user_journeys.py`

## Why this exists (product intent)

**The pattern this plan exists to break:** the agent (me) ships a fix, the user redeploys, finds the same class of bug returning a few turns later, has to flag it, I fix it again, then I introduce a *different* but equally wire-level regression on the next change. Across this overhaul we've recycled the same shape of bug at least three times — interrupt frame routed to a type the RTVI processor consumes upstream, text deltas double-emitted because two paths to the UI fired at once, cancel-pending stuck because an error event wasn't handled. Each one was a five-line fix; finding it required real-phone testing the user shouldn't have to be doing.

**The user, plainly, is doing my regression QA.** That's what this harness exists to stop.

The three test categories below aren't picked from a checklist of "good engineering practices." Each one maps to a specific lived UX failure:

- **Interruption timing.** "I start to talk, the bot keeps talking over me." The mid-stream version is bad; the post-LLM-but-mid-TTS version is worse — the conversation feels broken because the bot is replying to a question that's already obsolete. Until this works first try, the product feels unusable.
- **History + compaction.** "I asked a follow-up and the bot acted like the previous turn never happened." For pi-coding-agent it was a session-reuse miss; for Hermes it was sending `session_id` instead of `previous_response_id`; for Claude CLI it was missing `--resume`. Each harness needs its own native chain wired correctly. Plus: when the harness compacts, the bot pauses for 5–15 s — if user input during that window jams the harness's session state, every long conversation breaks. We need a clean "agent is busy, hold inputs" gate on the orchestrator.
- **Long conversations + endpointing.** "I paused mid-sentence and it sent the first half." Voice UX dies the moment the system fragments your sentence into two requests. Compounded by the post-interrupt latency tail, the user sends a real follow-up, the system is still cleaning up cancel-pending state, and 4 seconds pass before any response — making the bot feel dead.

**End-state we're going for:**

1. The user stops being the regression detector. They use the bot. When something breaks, it's a *new* bug we haven't seen before — not the same one for the third time.
2. `predeploy.sh` is a hard precondition for orchestrator deploys, not a polite suggestion. The agent (me) does not redeploy without running it. If it fails, no redeploy. Full stop. The agent's commitment is behavioral, not just textual — it lives in `scripts/deploy-orchestrator.sh`, which won't proceed to `pcc deploy` on a non-zero exit.
3. The contract for shipping: a green `predeploy.sh` for orchestrator changes, a checked release-smoke checklist on the user's real device for iOS-platform changes. Two clear gates, neither of them "hope and pray."
4. When a real-device-only bug surfaces (audio session, AirPods, native modules), we add a checklist item, not another pytest. We stop pretending pytest covers iOS.

**What "regression-shaped" means here.** A regression is anything where, after a deploy, a previously-working behavior breaks. The bugs in scope for this harness are the ones whose root cause is in code we control: orchestrator pipeline composition, frame routing, gate state, harness adapter contracts, schema/codegen drift. Bugs whose root cause is in Daily, Pipecat Cloud, Hermes runtime, or iOS audio session — those are out of scope here and live in the device smoke checklist.

**Why this plan, not just "be more careful."** Being careful failed three times this week. The pattern wasn't carelessness, it was the absence of a layer that catches "the wire shape changed and the consumer doesn't notice yet." That layer is what this plan installs.

## Outcome

Every wire-level regression that has bitten us repeatedly — interrupt-intent silently dropped, doubled text deltas, stuck cancel-pending, double-sent transcripts spawning overlapping turns — fails a deterministic local check before `pcc deploy` lands the new bot in production. The harness lives in-process under `pytest`, runs in under 5 seconds, and is the gate the operator (and future agents) clear before pushing the orchestrator.

## Scope

Captures the three bug categories the user reports recurring:

1. **Interruption timing** — interrupt during streaming, interrupt during post-LLM TTS, and the "next message doesn't respond after interrupt" tail.
2. **Conversation history + compaction** — multi-turn correctness, history actually flows through the harness's native chain (`previous_response_id`, `--resume`, persistent `AgentSession`), and a clear admission rule for the compaction window.
3. **Long conversations + sensitive Deepgram endpointing** — N-turn smoke, double-send coalescing, post-interrupt response latency.

**Out of scope (needs real device, separate smoke checklist):** iOS audio-session behavior (orange mic dot, AirPods routing), native PTT gesture timing, Daily WebRTC quirks, Hermes runtime against a live local server, native module crashes.

## Why pytest, in-process

- We already have `FakeAdapterClient` + frame-driven assertions in `test_user_journeys.py`. The new scenarios are an extension of that file's pattern, not a parallel rig.
- Fast, deterministic, costs nothing (no Pipecat Cloud sessions burn).
- Drives the *real* orchestrator processors (`HarnessBridgeProcessor`, `HarnessRouterProcessor`, `InferenceGateState`, `TypedInputDecoder`, `InterruptionEmitter`) — so the bugs we've been re-shipping (RTVI frame type, gate races, bracketing) are in the path under test.
- The harness deliberately bypasses Daily's WebRTC and Pipecat Cloud's runtime. Those layers have their own contracts; our regressions sit *between* them, and that's where the harness drives.
- The harness must use the production pipeline composition, not a hand-built approximation. If `bot.py` changes processor ordering, the tests should exercise that new ordering automatically. The implementation should first extract pipeline construction into a small production-owned factory, then let the test harness inject fake transport/STT/TTS/adapter boundaries into that same factory.

## Architecture

First, factor the production composition out of `bot.py` into a reusable builder, e.g. `pipecat/overwatch_pipeline/pipeline_factory.py`. `bot.py` remains responsible for loading settings, creating the real Daily/STT/TTS/Relay objects, and starting `PipelineRunner`; the factory owns the processor order and shared state wiring.

A new module `pipecat/tests/integration/_harness.py` then exposes one fixture-builder:

```python
ctx = build_test_pipeline(
    harness_capabilities=...,        # which adapter shape to simulate
    default_mode="dev",              # registry default policy
)
# ctx.bridge / ctx.router / ctx.gate / ctx.client (FakeAdapterClient)
# ctx.pending_user_input                 # actual held user turns
# ctx.recorder.frames  → ordered list of (frame_type, frame) downstream
# ctx.send_client_message(kind, data)   → injects RTVIClientMessageFrame
# ctx.send_harness_event(event)         → FakeAdapterClient.push_event
# ctx.run_until(predicate, timeout=2.0) → drains async pipeline
```

The pipeline is composed through the same factory as production (TypedInputDecoder → InterruptionEmitter → STT-stub → IdleReportProcessor → PreLLMInferenceGate → HarnessBridgeProcessor → HarnessRouterProcessor → PostLLMInferenceGate → SayTextVoiceGuard → TTS-stub). STT and TTS are replaced with passthrough stubs that record `LLMTextFrame`, `TTSSpeakFrame`, `LLMFullResponseStart/EndFrame`, `InterruptionFrame`, `RTVIServerMessageFrame` arrival — that's the assertion surface.

Critically: the harness uses *real* `RTVIClientMessageFrame` (the type Pipecat Cloud's RTVI processor actually emits, not the raw `InputTransportMessageFrame` that pretends to look like it). This is the bug that round-tripped twice this week — locking it into a fixture stops it from coming back.

### Buffering model

Keep two buffers with different semantics:

- `DeferredUpdateBuffer` remains for harness/background context (`inject` events): monitor fires, tool results, reasoning, session metadata. These are prepended as `<context>` blocks to the next admitted turn.
- `PendingUserInputBuffer` (new) holds actual user text that arrived while turn admission was blocked by cooldown, bot speech, cancel-pending, or harness compaction. It should preserve user text as user text, not convert it into a `<context kind="deferred_user_input">` block. During compaction, use last-write-wins so a newer user request replaces an older held request.

This also fixes a sharp edge in the current bridge flow: do not drain `DeferredUpdateBuffer` until the bridge knows it is actually going to submit a harness command. Otherwise, a blocked gate can consume injected context and only re-buffer the raw user text.

### Scenario Growth Model

The first tests can be explicit pytest functions, but the harness should be designed to grow by adding scenarios, not by inventing a new bespoke test style for every bug. Add a fixture format under `pipecat/tests/integration/fixtures/voice_loop/` that can describe:

- input frames / RTVI client messages
- harness events
- expected harness commands
- expected downstream frames
- expected final gate and buffer state

When a regression is found in real use, convert the observed frame/event sequence into a fixture. Future bugs should add fixtures or property-test invariants first, then fixes.

## Scenarios

### Category 1: interruption timing

**1a. Mid-stream interrupt (LLM still emitting deltas)**
- Setup: send `user_text "tell me a story"`. Have the fake harness emit `text_delta` x3 with the same `correlation_id`.
- After the third delta is observed downstream, inject `RTVIClientMessageFrame(type="interrupt_intent")`.
- Assert: an `InterruptionFrame` reaches the TTS stub within 200ms of the inject. No further `LLMTextFrame` is pushed for the original correlation. The bridge's `_active_correlation_id` clears (or transitions if a new turn is sent).

**1b. Post-LLM, mid-TTS interrupt**
- Setup: harness emits `text_delta` x2 → `assistant_message` (terminal) → `session_end`. Bridge sees session_end, clears in_flight. But TTS stub is still "playing" (it returns `TTSStartedFrame` and waits on a release future before `TTSStoppedFrame`).
- Inject `interrupt_intent` while the stub is mid-play.
- Assert: `InterruptionFrame` reaches the TTS stub. The stub's `_handle_interruption` resolves the release future early. No `LLMFullResponseStartFrame` for the *next* turn fires until the stub confirms abort.
- The "real" symptom this catches: today the bridge thinks idle, but Cartesia is mid-flush; if our `InterruptionEmitter` only listened to bridge state instead of `UserStartedSpeakingFrame`/`interrupt_intent`, the abort never reaches TTS.

**1c. Post-interrupt new turn dispatches promptly**
- Setup: run 1a or 1b to interrupt mid-something. Immediately follow with a new `user_text "actually do this instead"`.
- Assert: bridge emits `submit_with_steer` (NOT `submit_text` — the prior correlation is still being cancelled), with `cancels_correlation_id` set to the prior turn. The fake harness then emits `cancel_confirmed` for the prior + a fresh `text_delta` for the new correlation. The router emits `LLMFullResponseStartFrame` + `LLMTextFrame` for the new turn within 1s.
- This is the "next message doesn't respond" bug — caused by `cancel_pending` getting stuck. The auto-expiry I added earlier is safety net; this scenario verifies the fast path works.

### Category 2: conversation history + compaction

**2a. History chains across turns (per-adapter mock)**
- Three adapter-specific assertions, each mocking the harness API at the network/process boundary:
  - **pi-coding-agent**: `createAgentSession` is called once, `session.prompt` is called three times on the *same* session object. (Mock the `@mariozechner/pi-coding-agent` import; assert call shape.)
  - **Hermes**: `POST /v1/runs` for turn N+1 includes `previous_response_id == run_id_of_turn_N`. Use a stub `fetch` that records request bodies. (Lives in `packages/session-host-daemon/tests/`, not pipecat — this is the daemon adapter's contract. Cross-language by design.)
  - **Claude Code CLI**: second invocation's `argv` contains `--resume <session_id_from_first_init_event>`. Stub `child_process.spawn` to record argv.
- These tests live where the adapter lives. The pipecat harness tests stop at "orchestrator emits the right `submit_text`/`submit_with_steer` envelope sequence" — the daemon-side adapter contracts are tested independently.

**2b. Compaction blocks user input — REQUIRES IMPLEMENTATION CHANGE**
- Today's gate has no notion of "harness is compacting". A compaction window can take 5-15 s; user input during it confuses pi's session state.
- Implementation needed (call out as a prerequisite for this scenario):
  1. Add `harness_busy: bool` to `InferenceGateState`, with a reason field for logging. This is distinct from `harness_in_flight`: `harness_in_flight` means an answer turn can be preempted; `harness_busy` means the adapter is doing non-turn work, like compaction, and must not receive commands.
  2. Add a Tier-1 wire event `agent_busy { phase: "compaction"|"tool"|"system", correlation_id?, raw }` in `protocol/schema/harness-event.schema.json`. Adapters that have a compaction concept (pi today, Hermes if it exposes it) emit `agent_busy {phase:"compaction"}` on entry and `agent_idle` on exit.
  3. Bridge handles those events: sets `gate.harness_busy = true/false`. `can_run_now()` includes `not harness_busy` in its conditions. Busy only blocks harness command admission; it must not block local audio interruption.
  4. While `harness_busy=true`, the bridge emits no harness commands: no `submit_text`, no `submit_with_steer`, no `cancel`. User text goes to `PendingUserInputBuffer`.
  5. `interrupt_intent` during busy still reaches TTS as an `InterruptionFrame` when audio is playing. It only suppresses the harness-side command. This lets the user stop stale speech without corrupting compaction/session state.
- Scenario: send a multi-turn sequence; have the fake harness emit `agent_busy {phase:"compaction"}` between turns 5 and 6. While busy, inject `user_text` AND `interrupt_intent`. Assert: bridge does NOT emit `submit_text`, `submit_with_steer`, or `cancel`; the typed user text is held as pending user input; an `InterruptionFrame` still reaches the TTS stub if TTS was playing. After `agent_idle`, the pending user text is admitted automatically with any `DeferredUpdateBuffer` context prepended.

### Category 3: long conversations + double-send + post-interrupt latency

**3a. 20-turn smoke**
- Loop 20 user_text → fake-harness streams 5 deltas + assistant_message + session_end → assert no leaked frames, no orphan turn state, no growing `_cancel_pending` set, gate idle between turns. Locks down the "we slowly leak state" class of bug.

**3b. Pause-mid-speech aggregates into one turn (smart-turn coverage)**
- Drives the test pipeline through a synthetic Deepgram event stream: `is_final="hello there"`, 300 ms pause, `is_final="how are you"`, then `UtteranceEnd`.
- With `endpointing=500` + `LocalSmartTurnAnalyzerV3`, the bridge sees ONE turn, not two. The orchestrator emits a single `submit_text` whose payload is `"hello there how are you"` (or whichever aggregation Pipecat does).
- Two distinct utterances separated by >1 s of silence emit two turns (real follow-up).
- This locks in the "pause mid-speech sends the first part, then the rest later" bug.

**3c. Post-interrupt latency**
- Run 1a (mid-stream interrupt). Then immediately send a new user_text. Measure wall-clock from interrupt-injection to first downstream `LLMTextFrame` of the new turn (assertion: ≤ 1s in the in-process harness; real PCC adds ~200 ms WebRTC roundtrip).
- This is the "I sent a message but it took 10 seconds to respond" bug. With cancel_pending auto-expiring after 4 s today, the floor is 4 s; this scenario both validates the fast path (cancel_confirmed arrived) and detects regressions where we forget to clear cancel-pending on the fast path.

### Category 4: state-machine fuzz / property tests

Once the explicit regressions are green, add a small randomized state-machine test that interleaves `user_text`, `interrupt_intent`, `text_delta`, `assistant_message`, `session_end`, `cancel_confirmed`, `error`, `agent_busy`, and `agent_idle`. The goal is not broad fuzzing for its own sake; it is to lock in invariants that should hold for any ordering:

- one active turn per target at a time
- unknown events never produce audio
- stale events never close or reopen the wrong turn
- cancel-pending either clears, expires with a surfaced error, or blocks admission intentionally
- injected context is delivered once and never lost because a gate was busy
- pending user input remains user input, not XML context

## Files added / changed

| File | Purpose |
|---|---|
| `pipecat/overwatch_pipeline/pipeline_factory.py` | Production-owned pipeline builder used by both `bot.py` and tests; prevents test composition drift |
| `pipecat/overwatch_pipeline/pending_user_input_buffer.py` | Holds actual user turns while admission is blocked; last-write-wins during compaction |
| `pipecat/tests/integration/_harness.py` | `build_test_pipeline()` fixture; FrameRecorder; FakeRTVIClientMessageEmitter; configurable TTS-stub with releaseable "playing" state |
| `pipecat/tests/integration/test_interruption_scenarios.py` | Scenarios 1a / 1b / 1c |
| `pipecat/tests/integration/test_history_and_compaction.py` | 2a (orchestrator-side); cross-references to per-adapter daemon tests |
| `pipecat/tests/integration/test_long_conversation.py` | 3a / 3b / 3c |
| `pipecat/tests/integration/test_voice_loop_properties.py` | State-machine/property checks for turn, cancellation, stale-event, and buffer invariants |
| `pipecat/tests/integration/fixtures/voice_loop/` | Data-driven regression fixtures captured from real bugs or catch-all traces |
| `packages/session-host-daemon/tests/hermes-history-chain.test.ts` | 2a Hermes leg — verifies `previous_response_id` is set on N+1 |
| `packages/session-host-daemon/tests/claude-cli-resume.test.ts` | 2a Claude CLI leg — verifies `--resume <id>` in argv on N+1 |
| `packages/session-host-daemon/tests/pi-session-reuse.test.ts` | 2a pi leg — verifies the same session object is reused across turns |
| `pipecat/overwatch_pipeline/inference_gate.py` | Add `harness_busy` state + property, include in `can_run_now()` |
| `pipecat/overwatch_pipeline/harness_bridge.py` | Handle `agent_busy` / `agent_idle`; use pending user-input buffer; drain injected context only after admission succeeds |
| `pipecat/overwatch_pipeline/harness_router.py` | Register `agent_busy` and `agent_idle` as ui-only (no audio side-effect) |
| `pipecat/overwatch_pipeline/bot.py` | Wire `LocalSmartTurnAnalyzerV3` into `DailyParams`, set Deepgram `endpointing` + `utterance_end_ms` |
| `pipecat/overwatch_pipeline/settings.py` | `stt_endpointing_ms` (default 500), `stt_utterance_end_ms` (default 1000) |
| `protocol/schema/harness-event.schema.json` | Add `agent_busy` and `agent_idle` Tier-1 events |
| `packages/session-host-daemon/src/harness/pi-coding-agent.ts` | Forward pi's `compaction_start`/`compaction_end` events as `agent_busy`/`agent_idle` |
| `scripts/predeploy.sh` | Runs `npm run protocol:check`, `cd pipecat && uv run pytest -q`, relevant TS tests, lint/type checks, then prints "redeploy-ready" |
| `scripts/deploy-orchestrator.sh` | The only documented deploy path; runs `predeploy.sh` and then `pcc deploy --yes --force` |

## Run model

```bash
# Local pre-deploy gate.
./scripts/predeploy.sh

# Orchestrator deploy path. Do not call `pcc deploy` directly.
./scripts/deploy-orchestrator.sh

# Output:
# ✓ pytest 73/73 passed (incl. 12 new regression scenarios + property checks)
# ✓ npm test 91/91 passed (incl. 3 new daemon adapter contract tests)
# ✓ protocol:check clean
# ✓ ruff / mypy clean
# ✓ wrangler dry-run clean
# orchestrator deploy is safe to ship.
```

The agent (me) runs `scripts/deploy-orchestrator.sh`, not raw `pcc deploy`. If `predeploy.sh` fails, the wrapper exits non-zero and no deploy happens. The user gets a stable bot.

## Invariants this harness locks in

1. **`interrupt_intent` always reaches `InterruptionFrame` at the TTS service** — within 200 ms in-process, regardless of whether bridge state thinks idle, mid-turn, or post-turn-mid-TTS.
2. **A new user_text after an interrupt always emits `submit_with_steer`, never an orphan `submit_text`**, and the new turn's first text frame arrives within 1 s after `cancel_confirmed`.
3. **Conversation continuity is the harness adapter's responsibility, exercised through the harness's native chain**: pi via persistent session, Hermes via `previous_response_id`, Claude via `--resume`. No orchestrator-side prompt-mangling.
4. **The orchestrator never sends harness commands during harness compaction.** No `submit_text`, no `submit_with_steer`, no `cancel`. Audio interruption is still allowed locally so stale TTS can be stopped without touching the harness.
5. **Pause-mid-speech aggregates into a single user turn**, via Pipecat's smart-turn analyzer + Deepgram `endpointing=500` + `utterance_end_ms=1000`. Real follow-ups (>1 s silence) still emit separate turns.
6. **No state leaks across N=20 turns** — `_cancel_pending`, `activeByTarget`, `_pending_assistant`, no growing collections.
7. **Injected context is never lost when admission is blocked.** The bridge only drains `DeferredUpdateBuffer` after deciding it will submit or steer a harness command.
8. **Held user input stays user input.** It is not serialized as `<context>` and is delivered once after the gate becomes runnable.

## Decisions (formerly open questions)

### Compaction surfacing — pi only

After auditing each harness's API:

- **pi-coding-agent**: SDK emits `compaction_start { reason }` and `compaction_end` natively on the session event stream. Daemon adapter maps these to a new Tier-1 `agent_busy { phase: "compaction", reason, raw }` / `agent_idle { raw }` wire event.
- **Hermes**: `/v1/runs` API spec exposes no compaction signal; compaction happens transparently inside a run. **Not gated.** Heuristic detection ("no events for >3 s") would be brittle and mask real bugs.
- **Claude Code CLI**: emits `compact_boundary` as a stream-json event, already surfacing via `provider_event`. Compaction is internal and self-pausing. **Not gated.** Existing `claude-code/compact_boundary` registry entry stays at `ui-only`.

The protocol's `agent_busy`/`agent_idle` events stay generic so future adapters can opt in. Today only pi emits them.

### Auto-drain after compaction (with barge-in override)

When `agent_busy` is active, new `user_text` events go into `PendingUserInputBuffer`, not `DeferredUpdateBuffer`. On `agent_idle`, the pending user text is submitted automatically as the next user turn, with any real injected context from `DeferredUpdateBuffer` prepended. Barge-in escape: if a *newer* user_text arrives during the busy window, it replaces the buffered one (last-write-wins). This keeps held user input semantically distinct from harness/background context.

`interrupt_intent` during compaction has split behavior: it still interrupts audio, but it must not send a harness command. This is the key distinction: stop stale speech locally, don't poke a compacting harness.

### STT "double-send" — root-caused as Deepgram endpointing, not bridge debounce

The user's symptom — "pause mid-speech sends the first part, then the rest later" — is classic aggressive-endpointing behavior, verified against Deepgram + Pipecat docs:

- Deepgram default `endpointing = 10 ms`. Any pause as short as 10 ms triggers `is_final=true`.
- Pipecat's `DeepgramSTTService._on_message` pushes a `TranscriptionFrame` for every `is_final=true`.
- Our current settings: `DeepgramSTTSettings(model="nova-3", interim_results=True)` — no endpointing override, no `utterance_end_ms`, no smart-turn analyzer wired into the transport.

**Fix is configuration, not new code.** Three changes in `bot.py`:

1. `DeepgramSTTSettings(... endpointing=500, utterance_end_ms=1000)` — moves the final-emission threshold from 10 ms to 500 ms (pauses below that don't fragment) and emits a separate `UtteranceEnd` boundary event after a 1 s gap.
2. `DailyParams(... turn_analyzer=LocalSmartTurnAnalyzerV3())` — wires Pipecat's local smart-turn ONNX model (~65 ms inference). It analyzes grammar / tone / pace and gates downstream turn-complete on `EndOfTurnState.COMPLETE`. While it returns `INCOMPLETE`, the bridge holds even if Deepgram emits a final.
3. Expose `STT_ENDPOINTING_MS` and `STT_UTTERANCE_END_MS` on `Settings`, defaults `500` / `1000`, override-able per deployment.

No bridge-level debounce. The right turn-detection layer is pre-bridge, native to Pipecat, and doesn't lie about what "user finished talking" means.

### Cross-runtime adapter contract tests

The pi/Hermes/Claude adapter tests live in TS (`packages/session-host-daemon/tests/`) because that's where the adapter logic lives. The orchestrator pipeline scenarios live in Python (`pipecat/tests/integration/`). `scripts/predeploy.sh` runs both. Acceptable cost for testing the right surface in each language.

### Session-start contract drift guard

Add a small cross-runtime test for the relay → Pipecat Cloud session-start body. The architecture docs and `bot.py` must agree on which fields are present (`user_id`, `session_token`, `orchestrator_token`, `default_target`) and which long-term secrets are intentionally absent. This prevents auth/body-shape drift from becoming a runtime-only failure.

## Non-goals

- iOS audio session, AirPods routing, real PTT gesture timing — covered by a separate `docs/checklists/release-smoke.md` (5 items, runs on real device).
- Daily WebRTC behavior — Daily and Pipecat Cloud have their own contracts; we trust them and verify our wire format against them only via the live deploy.
- Replacement for `pcc agent logs` triage — the harness catches REGRESSIONS; novel real-runtime issues still surface in production logs.

## Acceptance

This plan ships when:
1. `scripts/predeploy.sh` exists, runs all checks, exits non-zero on failure.
2. The 12 new pytest scenarios, state-machine/property checks, and 3 new daemon adapter contract tests pass against current `main`.
3. Re-introducing each historical bug (interrupt-intent on wrong frame type; doubled text via `OutputTransportMessageFrame`; missing `--resume`; `cancel_pending` not auto-expiring; draining injected context before a blocked admission) fails at least one of those tests.
4. `scripts/deploy-orchestrator.sh` exists and is the documented deploy path. It runs `predeploy.sh` before `pcc deploy --yes --force`; raw `pcc deploy` is not used by agents.
5. Architecture docs are updated to reflect the deploy gate, busy/compaction semantics, and session-start body fields.

Move to `docs/plans/implemented/` when delivered.
