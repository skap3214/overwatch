# Research: Pipecat Voice Pipeline (gradient-bang) for Overwatch Voice Overhaul

**Date:** 2026-05-01
**Status:** Research complete; informs upcoming voice overhaul plan
**Related Code (overwatch):** `src/orchestrator/turn-coordinator.ts`, `src/stt/deepgram.ts`, `src/tts/deepgram.ts`, `overwatch-mobile/src/hooks/use-overwatch-turn.ts`, `overwatch-mobile/src/hooks/use-realtime-connection.ts`, `overwatch-mobile/src/components/PTTButton.tsx`
**Reference Repo:** `~/Desktop/code/int/gradient-bang` (commit cloned 2026-05-01) — `src/gradientbang/pipecat_server/`
**Related Docs:** `./initial-research-2026-04-05.md`

---

## 0. Goal

### 0.1 Why this research exists

Overwatch is a voice orchestrator for tmux-hosted coding agents (Hermes, Claude Code, Pi). Today the voice interaction is **not natural**: push-to-talk is half-working, interruptions are lost, queueing breaks under rapid use, and there's no way for the LLM's monitoring tool to surface findings mid-conversation without disrupting whatever the agent is currently saying. We want to overhaul the voice stack so talking to Overwatch feels like talking to a person who's actually paying attention.

Pipecat-AI's `gradient-bang` is a production voice-first agentic game (an "online multiplayer universe where everything in the game is an AI agent"). It solves the same set of voice-interaction problems we have, in production, with public source. This document is the result of treating gradient-bang as a reference implementation and asking: **what specifically have they decided, and which decisions transfer?**

### 0.2 The four questions this research must answer

Stated upfront so every section ties back:

1. **Interruption while the LLM is talking.** When the user starts speaking mid-utterance, what gets cancelled, what gets preserved in chat history, what cooldowns kick in, how do you avoid bot-echo-into-mic re-triggering itself? — Covered in §3 (turn detection + interruption mechanics) and §4 (inference gate).
2. **Bolting VAD + turn detection on top of a custom LLM agentic framework.** We use Hermes / Claude Code / Pi (and soon Codex / cursor-agent / etc.) — each has its own SDK, its own event stream, its own context window. How do you wrap that with VAD, smart-turn detection, and TTS without forcing the agent into someone else's framework? — Covered in §6 (bolting a custom agent framework onto Pipecat) and the load-bearing §H (harness event taxonomy + extensible registry).
3. **Quick responses without lowering LLM quality.** Where are the latency wins (streaming TTS, on-device turn detection, prompt caching) vs the quality traps (over-eager interruption, summarization on the hot path, thinking budget on the voice LLM)? — Covered in §7 (latency vs quality decisions).
4. **Monitoring tool injection without disrupting flow.** When a background tool produces a finding while the bot is mid-sentence, how does it get into the conversation — silently into context? Spoken when the bot next pauses? Hard-interrupt for critical alerts? Coalesced when many arrive at once? — Covered in §5 (out-of-band context injection) and §H.7–H.9 (the registry's `voiceAction` model handles harness events the same way).

### 0.3 What this research is *not* about

Gradient-bang owns its LLM context directly, so a meaningful chunk of their pipeline solves problems we don't have: compaction, summarization, central LLM context store. **Overwatch delegates to Hermes / Claude Code / Pi, each of which owns its own context window and compaction policy.** Those parts of gradient-bang are flagged inline as not-relevant. The high-leverage surface for us is the **boundary** between the voice pipeline and the harness event streams — see §H.

### 0.4 Document structure

- **§1** — what's broken in Overwatch today (gap inventory, tagged G1–G11).
- **§2–§7** — gradient-bang's stack: pipeline composition, turn detection + interruption, inference gate, out-of-band injection, custom agent integration, latency/quality decisions.
- **§8** — gap-to-pattern map + adoption order (4 phases).
- **Addendum §A–§G** — client UX patterns, RTVI vs Overwatch protocol, WebRTC vs WS-relay tradeoffs, tests + observability, updated adoption plan.
- **Addendum §H** — harness event taxonomy + extensible registry (the load-bearing section for our delegated-harness setup).
- **Addendum §I** — survey of existing OSS wrappers (pi-mono validates §H's design; Composio's adapter-registry shape is worth copying).

---

## 1. Overwatch Voice Today — What Is Broken

### 1.1 Architecture summary

```
Mobile (RN/Expo)                          Desktop CLI (Node/Hono)               External
─────────────────────                     ──────────────────────                 ─────────
[PTTButton] ──press──▶ [FastRecorder]
                              │
                              │ release
                              ▼
                    [use-overwatch-turn]
                              │ POST /api/v1/stt (HTTP, batch m4a)
                              ├──────────────────────────▶ [DeepgramSttAdapter] ──▶ Deepgram REST
                              │ ◀──────────────────────── transcript ◀────────────────────
                              │
                              │ realtimeClient.startTextTurn(text)
                              ▼
                    "turn.start" (WS) ──▶ [socket-server.ts] ──▶ [TurnCoordinator]
                                                                       │
                                                                       ├──▶ [harness.runTurn]
                                                                       │      Hermes / Pi / ClaudeCodeCli
                                                                       │      streams text_delta
                                                                       │
                                                                       └──▶ [DeepgramTtsAdapter] ──▶ Deepgram WSS
                                                                              streams PCM chunks
                    ◀── "turn.audio_chunk" (WS, base64) ──┘
                              │
                              ▼
                    [StreamingAudio.feedPCM] (native module)
```

### 1.2 The eleven concrete gaps

Tagged with the gradient-bang concept that fills each one.

| # | Gap | Source | Fill with |
|---|-----|--------|-----------|
| G1 | No VAD, no live amplitude. PTT is the only endpoint signal. `use-audio-recorder.ts:26,39` always emits 0. | mobile | `SileroVADAnalyzer` |
| G2 | STT is batch REST, not streaming. No interim transcripts, no partial confidence. `src/stt/deepgram.ts:27` | desktop | Deepgram streaming (`DeepgramSTTService` w/ `LiveOptions`) |
| G3 | No turn detection. The system has no concept of "user finished" vs "user pausing." | both | `LocalSmartTurnAnalyzerV3` (on-device ONNX) |
| G4 | PTT press does not cancel the in-flight backend turn — only PTT release does. Several seconds of TTS audio is generated server-side and silently discarded mobile-side. `use-overwatch-turn.ts:15-16` | mobile + desktop | Pipecat `InterruptionFrame` + inference gate |
| G5 | Interruption is not atomic. `turn.cancel` and `turn.start` race on two separate WS messages. `turn-coordinator.ts:97` | desktop | Single `InferenceGateState` shared across pre/post-LLM gates |
| G6 | No inference gate. Any `turn.start` while processing is enqueued; rapid presses stack jobs. `turn-coordinator.ts:111-113` | desktop | `InferenceGateState` with priority + cooldown |
| G7 | No idle/silence handling. If the user stops talking, nothing happens. | both | `IdleReportProcessor` |
| G8 | Audio state machine is split across `useAudioStore`, `turnState`, and ad-hoc refs. No single owner. | mobile | A single state object (model after `InferenceGateState`) |
| G9 | No way to inject monitoring context mid-conversation without a full new turn. | desktop | `LLMMessagesAppendFrame(run_llm=False)` + deferred-update queue |
| G10 | TTS broadcasts to all clients indiscriminately. `socket-server.ts:61-67` | desktop | Per-agent bus addressing (`BusFrameMessage` target) |
| G11 | Relay-mode `voice.transcript` round-trips through mobile before the text turn fires. `use-realtime-connection.ts:166-172` | relay | Direct desktop → harness path with mobile-side transcript echo only |

Detailed gap audit lives in the agent transcripts; the matrix above is the actionable summary.

---

## 2. gradient-bang Pipeline Shape

### 2.1 Stack summary

| Layer | Choice | File |
|---|---|---|
| Transport | Pipecat `create_transport` (Daily WebRTC or generic aiortc) | `bot.py:929` |
| VAD | `SileroVADAnalyzer` (local ONNX) | `bot.py:383` |
| Smart turn | `LocalSmartTurnAnalyzerV3` wrapped in `S3SmartTurnAnalyzerV3` | `s3_smart_turn.py:15` |
| STT | Deepgram Nova streaming (`DeepgramSTTService` + `LiveOptions`) | `bot.py:211-214` |
| LLM (voice) | Gemini 2.5 Flash, thinking=0, streaming, parallel tool calls on | `llm_factory.py:465-520` |
| LLM (task agent) | Gemini 2.5 Flash, thinking_budget=4096, parallel tool calls off | `llm_factory.py:588` |
| LLM (UI agent) | Gemini 2.5 Flash, no thinking, system-prompt cached on Anthropic path | `llm_factory.py:646-648` |
| TTS | Cartesia Sonic (streaming, ~80–150 ms TTFA) | `bot.py:218-227`, `voices.py` |
| Context store | (gradient-bang owns its LLM context; **not relevant for Overwatch** — each harness owns its own) | `bot.py:367-389` |

### 2.2 Pipeline order

```
NETWORK (WebRTC)
   │
[ transport.input() ]
   │  InputAudioRawFrame
[ DeepgramSTTService ]               ── interim + final transcripts
   │  Transcription / InterimTranscription / UserStarted/StoppedSpeaking
[ IdleReportProcessor ]              ── arms idle timer after first user activity
   │
[ PreLLMInferenceGate ]              ── intercepts LLMRunFrame, defers if not safe
   │
[ user_aggregator (LLMContextAggregator user-half) ]
   │  embeds: SileroVADAnalyzer, S3SmartTurnAnalyzerV3 (TurnAnalyzerUserTurnStopStrategy),
   │           TextInputBypassFirstBotMuteStrategy, filter_incomplete_user_turns=True
   │  emits LLMMessagesFrame
   │
[ ParallelPipeline ]
   ├── BRANCH A (primary)                          BRANCH B (UI agent, parallel)
   │     [ BusBridgeProcessor ]  ◄──► VoiceAgent     [ UIAgentContext ]
   │     [ PostLLMInferenceGate ] (FunctionCall*)    [ ui_llm ]
   │     [ TokenUsageMetricsProcessor ]              [ UIAgentResponseCollector ]
   │     [ SayTextVoiceGuard ]                       (no TTS — emits RTVI events only)
   │     [ CartesiaTTSService ]
   │     [ transport.output() ]
   │     [ assistant_aggregator ] (auto-summarizes at 200 msgs)
   └──
```

Frame routing notes:

- **No LLM processor sits in the pipeline directly.** `BusBridgeProcessor` forwards `LLMMessagesFrame` upstream onto the `AgentRunner` bus; `VoiceAgent` (a separate bus subscriber) owns the actual `LLMService` and processes the turn. Tokens flow back through the bus bridge into the rest of branch A. (`bot.py:597-617`)
- **VAD is embedded inside the user aggregator**, not a standalone stage. (`bot.py:383`)
- **Auto-summarization is intentionally out of scope for Overwatch.** Gradient-bang owns its LLM context directly and needs to compact it. Overwatch delegates to Hermes / Claude Code / Pi, each of which owns its own context window and compaction policy. We do not need to copy this. The pattern of "run heavy maintenance work on a separate event-loop task so it never blocks the voice frame loop" is still worth keeping in mind, but the specific compaction wiring is irrelevant. (`bot.py:351-363`)
- **UI tool calls don't show in the RTVI client stream**: after task construction, the code walks `task._observer._observers`, finds `RTVIObserver`, and sets `_ignored_sources = ui_branch_sources`. (`bot.py:578-581`)

### 2.3 Custom frames

| Frame | Source | Consumer | Purpose |
|---|---|---|---|
| `TaskActivityFrame(task_id, activity_type)` | task agents | `PipelineTask.idle_timeout_frames` | Resets the 600 s session idle timer; does **not** reset the idle-report timer |
| `UserTextInputFrame(text)` | `client_message_handler._handle_user_text_input` | `IdleReportProcessor`, `TextInputBypassFirstBotMuteStrategy` | Lets the user type; bypasses VAD/smart-turn entirely |

Defined in `frames.py`. Both are tiny dataclasses extending `DataFrame`.

---

## 3. Turn Detection + Interruption Mechanics

This is the section most directly load-bearing for Overwatch's broken interruption.

### 3.1 Two-stage turn detection

The fundamental insight: **VAD is a silence detector, not a turn-end detector.** The two roles are split.

1. **Silero VAD** runs continuously, fires `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` based on energy + neural classifier. `stop_secs = 0.2` (Pipecat default; not overridden). Lives inside the user aggregator. (`bot.py:383`)
2. **Smart turn model** is invoked by `TurnAnalyzerUserTurnStopStrategy` whenever VAD fires `Stopped`. The model takes up to 8 s of right-padded 16 kHz mono audio and returns `prediction ∈ {0, 1}` — 1 means turn complete. (`s3_smart_turn.py:38-48`)

Model details:
- File: `smart-turn-v3.2-cpu` (Pipecat-bundled ONNX, ~8 MB, Whisper Tiny encoder + linear head, int8 QAT).
- Latency: 12–95 ms CPU, 3–7 ms GPU. Preprocessing ~3 ms. **All local — no network round-trip.**
- Fallback: if the model says `incomplete` but silence persists past `SmartTurnParams.stop_secs = 3.0` s, force-complete the turn anyway.
- Side channel: every audio snippet is uploaded to S3 in a daemon thread (`{player_id}/{label}/{ts}-{uuid}.flac`) for training data. Fire-and-forget; never blocks. (`s3_smart_turn.py:44-47`)

### 3.2 Mute strategy — `TextInputBypassFirstBotMuteStrategy`

Three modes:

- **First-bot-speech wait**: user is muted (`return True`) until the first `BotStoppedSpeakingFrame`, then permanently unmuted. Prevents the user accidentally interrupting the bot's greeting.
- **Text bypass**: a `UserTextInputFrame` arriving before first bot-speech immediately unmutes — the user typed instead of waiting.
- **Force mute**: `force_mute = True` blocks everything (used during the scripted tutorial, `bot.py:743`).

Mute operates at the aggregator level: VAD still fires internally, but `UserStartedSpeakingFrame` is never emitted downstream while muted, so **no `StartInterruptionFrame` is generated** and the bot's speech completes naturally.

### 3.3 Canonical interruption flow (user talks over bot)

```
1. Silero VAD fires VADUserStartedSpeakingFrame (mute strategy says: False)
2. Aggregator emits UserStartedSpeakingFrame downstream
3. Aggregator detects bot is currently speaking → emits StartInterruptionFrame
4. StartInterruptionFrame propagates:
   - Cartesia TTS resets its outbound stream (kills queued audio)
   - Pipecat synthesizes LLMFullResponseEndFrame to close the truncated assistant turn
   - In-flight LLM token stream is cancelled
5. BotStoppedSpeakingFrame propagates → InferenceGateState.update_bot_speaking(False)
   → cooldown_until = now + 2.0 s
6. User finishes speaking; VAD fires Stopped; smart-turn says complete
7. UserStoppedSpeakingFrame; gate.update_user_speaking(False)
8. user_aggregator emits LLMMessagesFrame; PreLLMInferenceGate sees LLMRunFrame
9. Gate is blocked by cooldown — _pending_runner waits
10. After ~2 s, gate releases → LLMRunFrame forwarded → new inference begins
```

What is preserved: the partial assistant message **stays in chat history** (the synthesized `LLMFullResponseEndFrame` closes the turn cleanly, content is not retroactively deleted). The user's interrupting transcript becomes the next user turn. Tool calls already in-flight are tracked by `PostLLMInferenceGate._function_calls_in_progress` (`inference_gate.py:311`); their results are still received but the auto-rerun is deferred.

### 3.4 Edge cases handled

| Scenario | Mechanism |
|---|---|
| Backchannels ("uh huh") | `filter_incomplete_user_turns=True` drops VAD-triggered turns with no real transcription |
| False-positive VAD (noise) | Smart turn returns `incomplete` repeatedly; 3 s fallback fires; empty turn is filtered |
| Mid-sentence pause | Smart turn classifies as incomplete; pipeline keeps waiting |
| Network jitter | S3 upload runs in daemon thread; aggregator waits for `finalized=True` from Deepgram |
| Bot's own TTS echoing back into mic | 2 s post-bot cooldown (`InferenceGateState.cooldown_seconds`) |
| Combat events during bot speech | `combat_event` priority bypasses cooldown; bot interrupts itself |

### 3.5 Tunables (with actual values)

| Param | Value | File |
|---|---|---|
| VAD `stop_secs` | 0.2 s | Pipecat default |
| SmartTurn `stop_secs` (fallback) | 3.0 s | Pipecat default |
| SmartTurn `max_duration_secs` | 8.0 s | Pipecat default |
| `InferenceGateState.cooldown_seconds` | 2.0 s | `bot.py:498` |
| `InferenceGateState.post_llm_grace_seconds` | 1.5 s | `bot.py:499` |
| `BOT_IDLE_REPORT_TIME` | 9 s | `bot.py:711` |
| `BOT_IDLE_REPORT_COOLDOWN` | 45 s | `bot.py:712` |

---

## 4. The Inference Gate

The single most reusable piece of logic in the whole project.

### 4.1 State

`InferenceGateState` (`inference_gate.py:26`) tracks five things:

| Field | Meaning |
|---|---|
| `_bot_speaking` | TTS audio is actively playing |
| `_user_speaking` | User mic is active (per VAD) |
| `_llm_in_flight` | LLM token stream started, not yet ended |
| `_cooldown_until` | Monotonic timestamp; gate blocked until this passes |
| `_pending` + `_pending_reason` | A queued inference request waiting to fire |

### 4.2 The decision

```python
def _can_run_now_locked(self) -> bool:
    return (not self._bot_speaking
            and not self._user_speaking
            and not self._llm_in_flight
            and time.monotonic() >= self._cooldown_until)
```

(`inference_gate.py:128-138`)

If all four are clear, the gate fires immediately. Otherwise it stores `(reason, priority)` in `_pending` and a coroutine waits on three asyncio events (`_bot_idle_event`, `_user_idle_event`, `_llm_idle_event`). When all are set, it sleeps until cooldown clears, then pushes a fresh `LLMRunFrame` downstream.

### 4.3 Priority lanes

```
combat_event (4)  >  event (3)  >  tool_result (2)  >  llm_run (1)
```

Higher priority replaces lower-priority pending requests. `combat_event` with `combat_pov="direct"` bypasses the bot-speaking cooldown — the bot will cut itself off mid-sentence to deliver a critical update. (`inference_gate.py:51-61, 173`)

### 4.4 Two gate processors, one shared state

- **`PreLLMInferenceGate`** sits before `user_aggregator`. Intercepts `LLMRunFrame` and event-driven `LLMMessagesAppendFrame(run_llm=True)`. (`inference_gate.py:197`)
- **`PostLLMInferenceGate`** sits after the LLM in branch A. Intercepts `FunctionCallResultFrame` to gate the automatic LLM re-run after a tool call completes — without this, a tool result arriving while the user is speaking immediately stacks a second LLM call on top of the user's turn. (`inference_gate.py:305`)

Both share the **same `InferenceGateState` instance** (`bot.py:497-500`). This is critical: a per-processor gate would split-brain.

---

## 5. Out-of-Band Context Injection

How monitoring / external events get into the LLM's context without breaking conversation flow.

### 5.1 Three injection paths

| Path | When | Result |
|---|---|---|
| `LLMMessagesAppendFrame(run_llm=False)` | Silent context update | LLM sees on next natural inference; no speech |
| `LLMMessagesAppendFrame(run_llm=True)` | Spoken update | Goes through inference gate → eventually narrated |
| `InterruptionFrame` + `LLMMessagesAppendFrame(run_llm=True)` | Hard interrupt | Cancels TTS immediately, then fires inference |

The third path is reserved for true critical events. The first two cover ~95% of monitoring-style updates.

### 5.2 Message format

Every external injection uses this shape:

```python
{"role": "user", "content": "<event name='task.completed' task_id='...'>summary</event>"}
```

Always role `user`. Always wrapped in a discriminating XML tag. **Never `assistant`** (that would corrupt the turn alternation enforced by the aggregator). The XML tag tells the LLM "this is machine-generated context, not human speech."

### 5.3 Declarative event router

`EVENT_CONFIGS` (`event_relay.py:940`) is a dict mapping each event name to:
- `AppendRule` — should this be appended to LLM context at all? (NEVER / DIRECT / PARTICIPANT / OWNED_TASK / LOCAL)
- `InferenceRule` — should it trigger inference? (NEVER / ALWAYS / OWNED / VOICE_AGENT / ON_PARTICIPANT)
- `Priority` — for the inference gate

This moves all routing decisions out of procedural code into a data table. Adding a new event type is one row.

### 5.4 Deferred-update queue

Background TaskAgents complete asynchronously and need to surface results to the voice transcript without interrupting an in-flight conversation. The queue lives in `voice_agent.py:557-696`.

Drain logic (six-stage gate):

```
1. Stale check: if user/bot have spoken N=5 turns since enqueue → silent fold-in (run_llm=False)
2. Hard gates: tool_call_active, assistant_cycle_active, user_speaking, awaiting_bot_reply
3. Settle window: 2 s since last enqueue, capped at 8 s from first enqueue
4. Post-bot cooldown: 1.5 s after BotStoppedSpeakingFrame
5. Pre-flush recheck (gates may have changed)
6. Flush — concatenate all pending XML, single LLMMessagesAppendFrame(run_llm=True)
```

**Coalescing**: multiple updates arriving in the same event-loop tick are batched into one `LLMRunFrame` via `_inject_run_pending` + `await asyncio.sleep(0)` (`voice_agent.py:486-502`). One run per tick regardless of how many appends.

**No dropping**: every enqueued update is eventually narrated or silently folded in.

### 5.5 Idle reports (`idle_report.py`)

Triggered by:
- Idle timer: 9 s after `BotStoppedSpeakingFrame` *if* the user has spoken at least once (the timer doesn't arm on the bot's own greeting).
- Cooldown: 45 s minimum gap between idle reports.
- Skip conditions: no active task groups, or there are deferred updates pending.

When fired, injects a `<idle_check>` user message asking for one sentence about current task status. Goes through the normal coalesced-run path.

`_report_in_flight = True` is set **before** the callback so the report's own `BotStartedSpeakingFrame` doesn't restart the timer.

### 5.6 Context snapshot vs context injection — a clean separation

`context_upload.py` is **purely outbound**: serializes the full `LLMContext` to JSON, ships to S3 in a daemon thread on three triggers (every 10 min, on summarization, on shutdown). It never injects anything back into the live conversation. This separation is worth copying — debug snapshots and live injections must not share code paths.

---

## 6. Bolting a Custom Agent Framework onto Pipecat

This is the answer to "how do they wire Hermes/Claude Code/Pi-style custom agents into a Pipecat audio loop."

### 6.1 Agent topology

```
                    AgentRunner
         (manages PipelineTask lifecycle)
                         │
                    AgentBus (in-process AsyncQueueBus)
                         │
   ┌─────────────────────┼─────────────────────────────┐
   │                     │                              │
VoiceAgent          UIAgent                       TaskAgent (0..N)
(LLMAgent,          (FrameProcessor             (LLMAgent, background,
 bridged=())         in parallel branch)         own pipeline)
   │
ScriptedAgent (no LLM, queues raw TTSSpeakFrames; tutorial only)
```

Four agent types. Three roles:

- **VoiceAgent** is the user-facing conversational LLM. It has its own LLM service (Pipecat's `LLMService` subclass) and its own pipeline, but it is `bridged=()` — meaning it doesn't own the transport. Frames flow in/out via a `BusBridgeProcessor` placed in the main transport pipeline.
- **UIAgent** runs in a parallel branch of the voice pipeline. Sees the same `LLMContextFrame`, runs its own LLM, emits `control_ui` tool calls. No TTS; only RTVI events to the client.
- **TaskAgent(s)** are background workers, each with its own `Pipeline([user_agg, llm, ResponseStateTracker, assistant_agg])`. Spawned by VoiceAgent for long-running game actions. Their text output never reaches TTS — it goes to a UI sidebar via `BusTaskUpdateMessage` → `RTVIServerMessageFrame`.

All four are asyncio tasks in the same event loop. No subprocesses, no threads (only the S3 / context-upload daemon threads, which are write-only).

### 6.2 The bus — the integration substrate

`AsyncQueueBus` (`subagents/bus/local.py`) is an in-process asyncio queue with two dispatch lanes per subscriber:

- **System lane** (`BusSystemMessage`): cancel/end signals, delivered inline in the router task. Bypasses data queue.
- **Data lane** (`BusDataMessage`): everything else, sequential per subscriber.

Message types relevant to bolting an agent in:

| Type | Purpose |
|---|---|
| `BusFrameMessage` | Wraps a Pipecat `Frame` for cross-agent transport |
| `BusActivateAgentMessage` | Triggers an agent's `on_activated` |
| `BusEndAgentMessage` | Graceful shutdown |
| `BusCancelAgentMessage` | Hard cancel (system lane) |
| `BusTaskRequestMessage` / `Response` / `Update` | Parent → TaskAgent task lifecycle |
| `BusGameEventMessage` (app-level) | VoiceAgent broadcasts game events to TaskAgent children |
| `BusSteerTaskMessage` (app-level) | VoiceAgent steers an in-flight TaskAgent |

### 6.3 The bridge — `BusBridgeProcessor`

This is the single most copyable abstraction. ~30 lines of substance (`subagents/bus/bridge_processor.py`):

- `process_frame()`: outbound — wraps every non-lifecycle frame in a `BusFrameMessage` and publishes it.
- `on_bus_message()`: inbound — receives `BusFrameMessage`s and pushes the inner frame back into the local pipeline.

Drop one of these into any existing Pipecat pipeline and the pipeline gains bus access. VoiceAgent is `bridged=()` precisely because the main transport pipeline already has a bridge; VoiceAgent reads/writes through it instead of duplicating transport ownership.

### 6.4 Tool calling

Two patterns coexist:

- **Manual registration** (VoiceAgent): `llm.register_function(schema.name, tracked_handler)`. Each handler is wrapped with `_wrap_tool_errors` and `_track_tool_call` before registration. Schemas pulled from a pre-built `ToolsSchema`. (`voice_agent.py:402-432`)
- **Catch-all dispatch** (TaskAgent): `llm.register_function(None, self._handle_function_call)` — a single dispatcher that internally routes by name. Useful when the agent has many tools and registration boilerplate would dominate. (`task_agent.py:317`)

Async tool completion pattern (TaskAgent only, `task_agent.py:98-120`):

- Tool returns `{"status": "Executed."}` immediately.
- TaskAgent suspends inference (`_awaiting_completion_event`).
- When the matching game event arrives via `BusGameEventMessage`, append to context (`_add_event_to_context`) and resume inference.
- Prevents the LLM hallucinating results before server confirmation.

### 6.5 The deferral pattern that prevents tool-call/frame races

`LLMAgent.queue_frame` (`llm_agent.py:158-175`) holds frames in `_deferred_frames: deque` while `_tool_call_inflight > 0`. Without this, a frame enqueued during tool execution can race the LLM aggregator and corrupt the assistant turn. No lock — both the tool handlers and `queue_frame` run in the same event loop.

### 6.6 Twelve-step blueprint to bolt a custom agent into Pipecat

Distilled from the agent-integration research:

1. Create an `AsyncQueueBus` and an `AgentRunner`. Pass the bus to every agent.
2. Put a `BusBridgeProcessor` in your existing Pipecat transport pipeline. This is the only change to the existing pipeline.
3. Subclass `LLMAgent` for your voice agent. Implement `build_llm()`. Pass `bridged=()` so it reads frames from the bus bridge.
4. Override `build_tools()` and register handlers with `llm.register_function(name, handler)` (manual) or `@tool` (decorated).
5. For each background agent, subclass `LLMAgent` (no `bridged`). Build `Pipeline([context_user, llm, response_tracker, context_assistant])`. Insert a `_ResponseStateTracker` to capture text output without producing TTS. Start `active=False`.
6. Wire parent-child via the bus task protocol: parent calls `await self.request_task(child_name, payload, task_id)`. Child overrides `on_task_request`. Child reports back with `await self.send_task_response(...)`.
7. Implement deferred-update batching for surfacing background results. Don't immediately call `queue_frame(..., run_llm=True)`. Enqueue the result XML and run a drain coroutine (see §5.4).
8. For external event injection, create a relay object (not an agent) that subscribes to the external source and calls `voice_agent.queue_frame(LLMMessagesAppendFrame(...))`. Use a declarative `EVENT_CONFIGS`-style table.
9. Always check `voice_agent.tool_call_active` before injecting — `LLMAgent.queue_frame` will defer the frame safely if needed, but knowing avoids waking the agent unnecessarily.
10. Share **one** `InferenceGateState` instance between `PreLLMInferenceGate` (before user aggregator) and `PostLLMInferenceGate` (after LLM in branch A).
11. (Gradient-bang summarization step omitted — not relevant for Overwatch since each harness owns its own context.)
12. (Gradient-bang snapshot step omitted — same reason.) If we need to dump harness state for debug, do it through each harness's own snapshot API, not through a shared context store.

---

## 7. Latency vs Quality Decisions

Boil-the-ocean version is in the latency-research transcript; this is the actionable shortlist.

### 7.1 Top six decisions to copy first

1. **Cartesia TTS + token streaming.** Start TTS on the first LLM sentence fragment, not after full completion. Single biggest perceived-latency win. ~80–150 ms TTFA.
2. **On-device SmartTurn + VAD two-stage.** `LocalSmartTurnAnalyzerV3` (Pipecat-bundled) as turn-stop strategy; `SileroVADAnalyzer` as pre-filter. Eliminates network latency from turn detection (12–95 ms CPU vs hundreds of ms for remote).
3. **Disable thinking on the voice LLM; keep it for the task agent.** `VOICE_LLM_THINKING_BUDGET=0` for the real-time path. Reserve `budget_tokens=4096` for off-hot-path agents.
4. **Parallel STT + TTS init via `asyncio.gather`.** Both providers need a network handshake at startup; concurrent init hides the slower one.
5. **Off-hot-path async work pattern.** Gradient-bang's specific use is summarization; ours will be different (e.g., harness session cleanup, snapshot dumps). The point to copy: any heavy work the voice pipeline triggers must run on a separate event-loop task so it cannot block the voice frame loop.
6. **Prompt-cache hint for Anthropic-backed harnesses.** If the harness exposes a system-prompt knob, cache it. ~200–400 ms on cache hits with zero quality cost. (Most relevant for direct Anthropic API calls; harness-internal caching is owned by the harness.)

### 7.2 Things they explicitly avoided

- **No prompt rebuilding per turn** — `LLMContext` is reused across all turns; messages accumulate in-place. (`bot.py:367`)
- **No thinking on the voice LLM** — adds 400–2000 ms before first spoken token. (`llm_factory.py:483`)
- **No parallel tool calls on the OpenAI Responses API** — `parallel_tool_calls: False` to avoid sequencing bugs. (`openai_responses_llm.py:205`)
- **No voice cloning** — all Cartesia voices are pre-built UUIDs. (`voices.py`)
- **No Krisp by default** — extra processing stage; only enabled via env. (`bot.py:116-117`)
- **No synchronous character DB lookup when name hint is available** — short-circuits to save a Supabase round-trip. (`bot.py:168-175`)

### 7.3 Why three LLM SDK adapters coexist

| SDK path | When used | Why |
|---|---|---|
| Gemini (default) | All voice + agent calls | Lowest-latency streaming, native function calls, no reasoning premium when thinking is off |
| OpenAI Chat Completions | Fallback when `thinking=None` for OpenAI | Standard streaming path |
| OpenAI Responses API | Only when `thinking.enabled=True` for OpenAI | Only API that streams reasoning summary text as `LLMThoughtTextFrame` |

The Responses adapter (`openai_responses_llm.py`) also enforces a 50 ms guard on context preparation and warns if exceeded.

---

## 8. Gap → Pattern Map (Adoption Plan for Overwatch)

Mapping each Overwatch gap (§1.2) to the gradient-bang pattern that fixes it, with a recommended adoption order.

### Phase 1 — Foundation (must do first)

| Gap | Pattern | Concrete change |
|---|---|---|
| G2 | Deepgram streaming STT | Replace `src/stt/deepgram.ts` batch REST with `wss://api.deepgram.com/v1/listen`; emit interim + final transcripts on the WS |
| G1 | SileroVAD | Either run Silero on the desktop on the streamed PCM, or use Deepgram's built-in endpointing event (`UtteranceEnd`) as a proxy until we want true VAD on the mobile |
| G6 | InferenceGateState | Build a TS port of `InferenceGateState` in `src/orchestrator/`. Single instance shared across pre-LLM and post-LLM gates. Five state fields, four-condition `_can_run_now()`, priority queue, async event-based pending runner |

These three changes alone fix the worst broken behaviors (interruption races, queueing, no streaming endpoint).

### Phase 2 — Smart turn + interruption

| Gap | Pattern | Concrete change |
|---|---|---|
| G3 | LocalSmartTurnAnalyzerV3 | Run the bundled ONNX (Whisper Tiny encoder, ~8 MB) on the desktop. Wire as `TurnAnalyzerUserTurnStopStrategy` equivalent — VAD fires Stop → smart-turn confirms or vetoes → only then is the harness invoked |
| G4 | InterruptionFrame on press, not release | Mobile sends a `turn.interrupt` WS message on PTT press. Desktop translates to `InterruptionFrame` immediately: cancel TTS, abort harness, mark cooldown |
| G5 | Atomic interruption | Single message that carries both "cancel current" and "start new" intent. Server-side, gate handles both transactionally before processing the queue |

### Phase 3 — Out-of-band context

| Gap | Pattern | Concrete change |
|---|---|---|
| G9 | `LLMMessagesAppendFrame(run_llm=False/True)` | Define a `MonitoringEvent` shape: `{role: "user", content: "<monitor source='X' severity='Y'>...</monitor>", run_llm: boolean}`. Default `run_llm=false` for routine findings. Inject into harness context via existing harness API (Hermes accepts text input mid-run via SSE inject; need to check Pi/Claude Code) |
| G7 | IdleReportProcessor | Idle timer arms after first user activity, fires after 9 s of `BotStoppedSpeakingFrame`, 45 s cooldown between reports. Skips if any background harness work is active |
| — | Deferred-update queue | When monitor events arrive while bot is speaking or user is mid-utterance, batch into a single XML envelope, drain after both go idle + 1.5 s cooldown |
| — | EVENT_CONFIGS-style declarative router | Move all monitor-source → injection-rule mapping into a config object, not procedural code |

### Phase 4 — State + cleanup

| Gap | Pattern | Concrete change |
|---|---|---|
| G8 | Single state owner | Collapse `useAudioStore` + `turnState` + ad-hoc refs into one Zustand store driven by a single state machine. Mirror `InferenceGateState`'s shape |
| G10 | Bus-style addressing | Per-client `clientId` on every audio frame; broadcast becomes opt-in, not default |
| G11 | Direct relay → desktop transcript path | Relay does the STT round-trip server-side; mobile receives transcript only as an echo for UI, not as a re-trigger |

### 8.1 Anti-patterns to avoid

- **Don't run the smart-turn model on the mobile.** The 8 MB ONNX is fine on desktop CPU but adds bundle size and battery cost on mobile.
- **Don't inject monitoring events as `assistant` role.** Always `user` role with an XML envelope tag. Anything else corrupts turn alternation.
- **Don't use `InterruptionFrame` for monitoring updates.** That path is reserved for true critical events. Use `LLMMessagesAppendFrame(run_llm=True)` through the inference gate instead — it'll narrate when the bot is naturally between turns.
- **Don't share the inference gate across users.** Per-session instance. Cooldowns and pending queues must not bleed between sessions.
- **Don't snapshot context back into live conversation.** Outbound (S3 archive) and inbound (live injection) must not share code paths.

---

## 9. File Index (gradient-bang)

For future deep-dives. All paths under `~/Desktop/code/int/gradient-bang/src/gradientbang/`.

**Pipeline / transport**
- `pipecat_server/bot.py` — entire pipeline construction (the canonical reference)
- `pipecat_server/__main__.py` — entry shim
- `pipecat_server/voices.py` — Cartesia voice registry
- `pipecat_server/frames.py` — custom frame types

**Turn detection / interruption**
- `pipecat_server/s3_smart_turn.py` — turn-end model wrapper + S3 upload
- `pipecat_server/inference_gate.py` — `InferenceGateState`, `PreLLMInferenceGate`, `PostLLMInferenceGate`
- `pipecat_server/user_mute.py` — `TextInputBypassFirstBotMuteStrategy`

**Context + injection**
- `pipecat_server/idle_report.py` — `IdleReportProcessor`
- `pipecat_server/chat_history.py` — read-only history fetch (NOT injection)
- `pipecat_server/context_upload.py` — outbound S3 snapshots (NOT injection)
- `pipecat_server/client_message_handler.py` — full RTVI dispatch table

**Subagents / bus**
- `subagents/bus/bus.py` — `AgentBus`, dual dispatch lanes
- `subagents/bus/messages.py` — full message hierarchy
- `subagents/bus/bridge_processor.py` — frame ↔ bus bridge (most copyable abstraction)
- `subagents/bus/local.py` — `AsyncQueueBus`
- `subagents/agents/base_agent.py` — `BaseAgent`, `_BusEdgeProcessor`, lifecycle
- `subagents/agents/llm_agent.py` — `LLMAgent`, tool deferral, `queue_frame`
- `subagents/runner/runner.py` — `AgentRunner`, lifecycle orchestration

**Pipecat agents (gradient-bang specific)**
- `pipecat_server/subagents/voice_agent.py` — full voice agent reference (deferred-update queue lives here at lines 557–696)
- `pipecat_server/subagents/task_agent.py` — background agent, async tool pattern, `_ResponseStateTracker`
- `pipecat_server/subagents/scripted_agent.py` — minimal no-LLM scripted agent
- `pipecat_server/subagents/ui_agent.py` — parallel-branch processor pattern
- `pipecat_server/subagents/event_relay.py` — `EVENT_CONFIGS` declarative router, `TaskStateProvider` protocol
- `pipecat_server/subagents/bus_messages.py` — extending `BusDataMessage` for domain messages

**LLM / latency**
- `utils/llm_factory.py` — model tiering, prompt caching wiring
- `utils/openai_responses_llm.py` — Responses API adapter (only path that streams thoughts)
- `utils/gemini_adapter.py` — Gemini streaming adapter

---

## 10. Open Questions for Plan Phase

1. **Where to run smart-turn ONNX.** Desktop only (cleaner, no mobile bundle cost) vs. mobile (lower latency, no PCM upload). Recommend: desktop initially.
2. **How to interrupt Hermes / Claude Code / Pi mid-stream.** Hermes is SSE — close the SSE stream and the harness should abort. Claude Code is `SIGTERM`. Pi is `session.cancel()`. All three need verification under load.
3. **Whether to keep PTT at all.** Recommendation: keep PTT as an explicit user-initiated mode (good for noisy environments, low-trust transcription contexts), add a "always-listening" mode using the full VAD + smart-turn stack as the default. Toggle in mobile settings.
4. **Whether the inference gate needs to live on the mobile, the desktop, or both.** Single source of truth must be the desktop (where the harness/LLM runs). Mobile shows derived state. Frame-level decisions never made on the mobile.
5. **Monitoring event taxonomy.** Need to enumerate which monitor sources we have today, their natural severity, and map each to `run_llm=True/False` defaults. This is the equivalent of building our own `EVENT_CONFIGS`.

---

# Addendum (2026-05-01) — Client UX, RTVI Protocol, Transport, Tests & Observability

Four follow-up research passes after the initial doc. Adds client-side patterns (gradient-bang's React UI), explicit RTVI vs Overwatch protocol mapping, WebRTC vs WS-relay tradeoffs, and a concrete tests + observability stack proposal.

---

## A. Client-Side Voice UX (gradient-bang `client/app/`)

Gradient-bang's React client uses `@pipecat-ai/client-js@^1.7.0` + `@pipecat-ai/client-react@^1.3.0` + `@pipecat-ai/small-webrtc-transport@1.10.0` (with optional `@pipecat-ai/daily-transport@^1.6.1`). All STT/VAD is server-side; the client has no mic-energy detection.

### A.1 Patterns directly portable to overwatch-mobile

These are pure JS / Zustand and do not depend on Web APIs — they will work on React Native:

1. **Deferred bot-message finalization (1500 ms timer).** `BotStoppedSpeaking` starts a 1500 ms timer before calling `finalizeLastMessage("assistant")`. If `BotStartedSpeaking` fires again (mid-response pause), the timer is cleared. Prevents false bubble-splits on TTS pauses. (`ConversationProvider.tsx:41,142-167`) — Overwatch likely finalizes immediately, causing split bubbles.
2. **Spoken/unspoken cursor as visual interrupt indicator.** Per-message char cursor (`BotOutputMessageCursor`) tracks how much of each assistant part has been spoken. `usePipecatConversation` slices each part into `{ spoken: string, unspoken: string }` (`usePipecatConversation.ts:122-136`). Spoken text renders normally; unspoken renders dimmed via `text-accent-foreground` (`MessageContent.tsx:103-107`). Shows the interruption point without any new "interrupted" state. — Overwatch doesn't differentiate spoken vs unspoken at all.
3. **Server-authoritative remote-mute state.** `ConversationPanel` listens to RTVI `UserMuteStarted` / `UserMuteStopped` and passes `isRemoteMuted` to the mic button, which shows "Please wait" and disables itself (`ConversationPanel.tsx:18-24`, `UserMicControl.tsx:53-65`). — This is the highest-value, lowest-effort fix for Overwatch's "PTT half-working" symptom: the button should reflect server mute state, not just local press state.
4. **Three-state transport simplification hook.** Maps the SDK's 7+ transport states into `disconnected | connecting | connected` (`usePipecatConnectionState.ts:31-43`). — Overwatch has scattered `state === "ready"` checks; one hook would consolidate.
5. **Tool-call interleaving via timestamp backdating.** Function-call messages are timestamped 1 ms before the active assistant message so they sort correctly in the transcript stream without a separate queue (`conversation.ts:577-587`). Status cycles `started → in_progress → completed/cancelled` rendered as collapsible cards (`FunctionCallContent.tsx:51-135`).
6. **`Thinking` component with elapsed-time counter.** Animated dots + live `requestAnimationFrame` elapsed timer rendered when `isThinking === true` and the message is empty (`Thinking.tsx:14-74`). Combined with a `ShipOSDVisualizer` waveform overlay during bot speech (`Conversation.tsx:224-246`). — Gives users transparency into agent latency.
7. **`sayTextActive` gate.** Boolean flag in conversation store that suppresses normal `BotOutput` handling when a `say-text` injection is active (`conversation.ts`). Prevents double-rendering when the LLM and a manual TTS injection are both producing output.

### A.2 Patterns NOT portable (Web API dependencies)

These all use Web APIs without React Native equivalents:

- `<audio autoPlay>` element with `srcObject = MediaStream` and `setSinkId` for speaker routing (`PipecatClientAudio.tsx:8-48`). RN needs `react-native-webrtc` or Expo AV (`overwatch-mobile/modules/streaming-audio/` is the existing equivalent).
- `MediaRecorder` with `audio/webm;codecs=opus` rolling buffer for replay capture (`VoiceCapture.ts:1-117`). RN equivalent is `react-native-audio-recorder-player` or Expo AV. Note: this is a *recording* feature, not a voice-input path — low priority.
- `navigator.mediaDevices.enumerateDevices()` for `MicDeviceSelect`/`SpeakerDeviceSelect` (`DeviceSelect.tsx:16-67`). On mobile, the OS owns audio routing; device picker is mostly unnecessary.

### A.3 Critical insight: state model

Gradient-bang has **no `isAgentSpeaking` or `isUserSpeaking` boolean** anywhere. Both are inferred from message finalization state (`final: false` on the in-progress assistant message means "agent is speaking"). This is cleaner than Overwatch's split-across-three-stores pattern (`useAudioStore` + `turnState` + `audioActiveRef`/`turnGeneration` refs in `use-realtime-connection.ts:21-27`). Recommend collapsing to a single conversation store where transient speaking states are derived, not stored.

### A.4 Applicability matrix

| Feature | Works on RN? | Effort | Value |
|---|---|---|---|
| Deferred bot-message finalization (1500ms) | ✅ Pure JS | Low | High — fixes split bubbles |
| Spoken/unspoken cursor split | ✅ Pure JS | Medium | High — interrupt visualization |
| Server-authoritative mute guard on PTT | ✅ Events exist | Low | **Highest** — fixes PTT half-working |
| 3-state transport hook | ✅ Pure JS | Low | Medium |
| Tool-call timestamp backdating | ✅ Pure JS | Low | Medium |
| `Thinking` + elapsed timer | ✅ Pure React | Low | Medium |
| `sayTextActive` gate | ✅ Pure flag | Low | Medium |
| Single `<audio>` w/ track dedup | ❌ Web API | High (need RN-WebRTC) | High — same problem as G8 |
| `setSinkId` speaker routing | ❌ Web API | High | Low (mobile OS handles) |
| `enumerateDevices` mic/speaker pickers | ❌ Web API | High | Low |
| `MediaRecorder` rolling buffer | ❌ Web API | High | Low (replay-only) |

---

## B. RTVI Protocol vs Overwatch Custom WS

### B.1 Side-by-side comparison

| Concept | RTVI (gradient-bang) | Overwatch | Gap |
|---|---|---|---|
| Handshake | `client-ready` ↔ `bot-ready` (with version) | `client.hello` ↔ `connection.ready` + `harness.snapshot` | Overwatch has no version negotiation |
| Turn init | `send-text` `{ content, run_immediately?, audio_response? }` | `turn.start` `{ text, tts? }` | Overwatch missing `run_immediately` flag (currently always-implicit) |
| Cancel | None client-side; server VAD triggers `InterruptionFrame` | `turn.cancel` `{}` | Overwatch has explicit user-intent cancel — keep, RTVI lacks it |
| LLM tokens | `bot-llm-text` `{ text }` | `turn.text_delta` `{ turnId, text }` | Overwatch's `turnId` is useful; keep |
| TTS audio | WebRTC media track (not WS) | `turn.audio_chunk` `{ turnId, base64, mimeType }` | RTVI avoids base64 cost via media channels |
| LLM/TTS lifecycle | `bot-llm-started/stopped`, `bot-tts-started/stopped` (4 events) | `turn.started` / `turn.done` (2 events) | **Major gap** — Overwatch can't differentiate "generating" from "speaking" |
| Speaking detection | `user-started/stopped-speaking`, `bot-started/stopped-speaking` | None | **Major gap** — no VAD events at all |
| Transcripts | `user-transcription` `{ text, final, timestamp, user_id }` | None (STT is HTTP) | **Major gap** — no real-time transcript feed |
| Tool calls | `llm-function-call-started/in-progress/stopped` with full args+results | `turn.tool_call` `{ name }` only | Overwatch exposes only the name; no args, no result, no `tool_call_id` |
| Reasoning tokens | Not in standard | `turn.reasoning_delta` `{ text }` | Overwatch has it; keep |
| App push | `server-message` (one escape hatch) | Many typed events (`monitor.updated`, `skill.updated`, etc.) | Overwatch's typed envelopes are cleaner; keep |
| Notifications | None | `notification.snapshot/.created/.updated/.ack` | Overwatch-specific; keep |
| Errors | `error` + correlated `error-response` (echoes request `id`) | `error` (uncorrelated) | Adopt correlated `error-response` |
| Metrics | `metrics` `{ processing[], ttfb[], characters[] }` | None | Worth adopting for observability |
| Relay/E2E encryption | Not in standard | ECDH key exchange, encrypted ArrayBuffer frames | Overwatch-specific; keep |

### B.2 Recommendation: layer RTVI semantics, don't adopt wholesale

**Do not adopt wholesale.** RTVI assumes WebRTC media-track audio, which would require either a Pipecat sidecar process (heavy, contradicts single-binary desktop daemon) or a fake RTVI transport over WS (negates the protocol's benefits).

**Selectively copy these RTVI message types** into Overwatch's existing envelope:

1. `user-started-speaking` / `user-stopped-speaking` — once we add streaming STT (G2), we have the underlying signals.
2. `bot-started-speaking` / `bot-stopped-speaking` — already have analogs in `turn.started` / `turn.done`; just split `turn.done` into `turn.llm_done` + `turn.tts_done` to match RTVI's granularity.
3. `user-transcription` `{ text, final }` — needed once STT moves from HTTP to WS streaming (G2).
4. `error-response` `{ id, error }` — correlated errors echoing the triggering request `id`. Trivial to add to existing `socket-server.ts` error paths.
5. Full tool-call lifecycle (`llm-function-call-started/in-progress/stopped`) with `tool_call_id`, arguments, and result — currently `turn.tool_call` carries only the name, which kills observability.
6. `metrics` event with pipeline timing data — would feed straight into the observability stack (§D).

**Keep as-is:**
- `turn.reasoning_delta` (RTVI lacks it)
- Relay handshake (`client.hello` + ECDH + `bridge.status`)
- Notification system (`notification.*`)
- Background turn events (`background.turn_*`)
- Typed top-level envelopes for app data (better than RTVI's `server-message` escape hatch)

### B.3 Dead message: `voice.audio`

`voice.audio` is sent from `realtime.ts:197` but **has no handler in `socket-server.ts`** — STT goes through HTTP `POST /api/v1/stt` instead. This is dead code on the mobile side that should either be wired up (for streaming STT, see G2) or removed.

---

## C. WebRTC vs WS-Relay Transport

### C.1 What WebRTC gives you that overwatch lacks

| Feature | Overwatch today |
|---|---|
| AEC (acoustic echo cancellation) | None — bot audio leaks into mic; the 2 s inference-gate cooldown is partly compensating for this |
| Jitter buffer | None — `feedPCM`/`markEndOfStream` is sequential, no adaptive buffering |
| Packet loss concealment | None — TCP WS, dropped packets stall not conceal |
| RTP/Opus framing | Raw PCM as base64 JSON (~33% wire overhead) |
| ICE/STUN/TURN NAT traversal | The relay exists specifically to solve this |
| Congestion control | None |
| FEC | None (Opus FEC needs RTP) |

**AEC is the headline.** WebRTC AEC runs in the browser/OS audio layer before the mic signal ever reaches JavaScript — hardware-assisted on Apple Silicon via AUVoiceIO. With AEC, the inference-gate cooldown could drop from 2 s to ~200–400 ms (just AEC convergence tail). That's a 5–10× responsiveness improvement on the bot-echo path.

### C.2 Relay-mode constraint analysis

Overwatch's relay does TweetNaCl X25519 + XSalsa20-Poly1305 encryption per WS frame (`crypto.ts:16-40`). The relay is a dumb message bridge — no AI pipeline, no audio processing.

Three options for adding WebRTC alongside the relay:

- **(a) Data-channel-only WebRTC tunneled over relay.** Worst of both worlds — keeps base64 JSON audio, loses AEC. Skip.
- **(b) Direct P2P WebRTC, relay only for SDP/ICE signaling.** ✅ Works. After ICE completes, audio flows mobile↔desktop over RTP/DTLS. Relay carries only signaling (small payloads). DTLS-SRTP replaces TweetNaCl for media. Blocker: aiortc's SCTP MTU bug on narrow-MTU paths (Tailscale, IPv6) — gradient-bang's `bot.py:8-34` MTU clamp is the known fix. RTP audio is unaffected.
- **(c) Full TURN-relayed WebRTC.** Required for symmetric NAT. Requires standing up a coturn server. DTLS-SRTP encrypts media end-to-end (TURN can't see plaintext). Adequate for our threat model but additional infrastructure.

The relay-mode constraint **does not block WebRTC adoption.** The relay can be repurposed as signaling-only.

### C.3 Pipecat transport flexibility

Three relevant Pipecat transports:
- **DailyTransport**: Full WebRTC via Daily's media server. Browser-grade AEC. Requires Daily account.
- **SmallWebRTC** (aiortc): Direct P2P, self-hosted. Has the MTU bug.
- **WebSocketServerTransport / FastAPIWebsocketTransport**: No WebRTC, no AEC. Pipecat docs explicitly say "best suited for prototyping... do not use for browser-to-server voice."

**Pipecat cannot accept audio from a non-WebRTC source into its WebRTC pipeline without a custom `BaseTransport` subclass.** If we want Pipecat-style features (smart turn, VAD, deferred-update queue) we must commit to a WebRTC transport.

### C.4 Recommendation: hybrid, with WebRTC as the target

**Phase 1 (foundation, see §8 of main doc): keep WS-relay, focus on streaming STT + inference gate + smart turn on the desktop side.** The current architecture is closer to voice-command than continuous-conversation, so WebRTC's benefits are partly latent.

**Phase 2+ (once we want always-listening / continuous duplex):**
- Local mode: SmallWebRTC with the gradient-bang MTU clamp. AEC eliminates the bulk of the cooldown.
- Remote mode: TURN-relayed WebRTC (option c) for AEC parity, or keep WS-relay as a degraded "PTT-only" fallback.
- Relay becomes signaling-only.

### C.5 Decision criteria (answer these before committing)

1. Is the target UX continuous (always-on VAD) or push-to-talk / phrase-level? *Push-to-talk → WS sufficient. Always-on → WebRTC required.*
2. Is the 2 s cooldown actually causing perceptible latency complaints today? *Yes → prioritize AEC. No → defer.*
3. Does the relay need to carry audio, or can it become signaling-only?
4. Budget for a TURN server (coturn) for relay-mode AEC?
5. Is aiortc's PMTU bug a blocker for the deployment topology (Tailscale, IPv6)?
6. Is Pipecat going to be the desktop-side framework? *If yes, WebRTC is mandatory. If no, WS architecture remains viable.*

---

## D. Tests & Observability

### D.1 What gradient-bang has

**Test stack** (`pyproject.toml:81-106`): `pytest>=8.4.1`, `pytest-asyncio>=1.1.0` (`asyncio_mode = "auto"`), `pytest-timeout>=2.3.1` (60 s default, 120 s on integration). Markers: `unit`, `integration`, `stress`, `requires_server`, `live_api`, `llm`. Time-sensitive tests use real `asyncio.sleep` with short calibrated intervals (0.05–0.3 s) instead of clock mocking.

**Mocking strategy** is layered:
- **Unit tests** (`tests/unit/`): real Pipecat frame objects, shimmed processors (`proc.push_frame = AsyncMock()`), `MagicMock()` for LLM/game client/bus.
- **Integration unit tests** (`test_voice_relay_integration.py`): real `EventRelay` + real `VoiceAgent`, mocked external boundaries. LLM frames captured by monkey-patching `voice_agent.queue_frame` (`test_voice_relay_integration.py:62-66`).
- **E2E tests** (`tests/integration/`): real `AsyncQueueBus`, real `AgentRunner`, real `AsyncGameClient` against a live test Supabase. `ScriptedLLMService` subclasses Pipecat's `LLMService` to feed scripted tool-call sequences with all the proper framing.

**Inference-gate tests** (`test_inference_gate.py`) cover priority classification (combat vs observed events), priority ranking, and reason-for-event computation. *Note: gradient-bang's `PreLLMInferenceGate` here is a routing/priority classifier; the temporal debouncer logic lives in `VoiceAgent`'s deferred-frame queue. Overwatch's port should test both behaviors.*

**Idle-report tests** (`test_idle_report.py:80-103`) cover the cooldown gate, self-speech guard (`_report_in_flight=True` doesn't reset cooldown), user-interruption clearing cooldown, callback-returns-False retry, and shutdown via `CancelFrame`. All with real `asyncio.sleep` at 50–200 ms intervals.

**Voice-agent tests** (`test_voice_agent.py:244-259`) cover the deferred-frame coalescing — N event appends become 1 `LLMRunFrame`. Also covers concurrent task-start serialization, ship-lock release timing, agent reuse vs destruction.

**E2E harness** (`e2e_harness.py`) boots real bus + runner + voice-agent + relay against test Supabase. No real audio simulation — interaction driven by `harness.join_game()`, `harness.call_and_feed(endpoint, payload)`, `harness.inject_combat_event(...)`. Audio inputs are not simulated at all.

**Observability** (`utils/weave_tracing.py`, `utils/token_usage_logging.py`, `utils/logging_config.py`):
- `@traced` decorator zero-cost no-op when `WANDB_API_KEY` unset. **Only one production site uses it**: `TaskAgent.on_task_request` (`task_agent.py:336`). The voice loop hot path is largely dark.
- `TokenUsageMetricsProcessor` is a pipeline FrameProcessor that captures `LLMUsageMetricsData`. CSV schema: `timestamp, source, input_tokens, cached_tokens, thinking_tokens, output_tokens`. Async writes via `asyncio.to_thread`. Useful for cache-hit-rate tracking.
- Logging is loguru with per-agent color codes (voice_agent → cyan, event_relay → yellow, task_agent → green). Plain text, no structured JSON, no log-trace correlation IDs.

**The observability story is honestly thin** — the bus/voice-loop is not traced, the relay path is not traced, and there are no histograms for STT/TTS/turn latency. We can do better than gradient-bang here.

### D.2 Recommended Overwatch test stack

Overwatch is TypeScript/Node + ESM with `tsx --test` already wired.

**Runner**: keep native `node --test` for now; consider Vitest later for `vi.useFakeTimers()` (the biggest gap vs. the calibrated-sleep approach).

**Top 8 voice tests that would catch current bugs:**

1. **Interruption race — foreground cancels in-flight.** Slow mock harness (100 ms), call `runForegroundTurn` twice. Assert first job's `AbortSignal` fired, only one response reached the client.
2. **Queue ordering — background doesn't preempt foreground.** Enqueue both concurrently. Assert foreground completes first, no interleaving.
3. **Out-of-band injection during active turn.** Call `enqueueBackgroundTurn` while foreground is in `processLoop`. Assert background queued (not dropped), fires after foreground resolves.
4. **STT error not silently swallowed.** Mock `transcribe()` to throw. Assert error surfaces, coordinator state resets to idle.
5. **Stale transcript ignored after abort.** Start turn, abort mid-flight, harness resolves later. Assert no `send` event reaches client after abort.
6. **Coordinator state after harness throws.** Mock `harness.run()` to throw. Assert `processing=false`, `currentJob=null`, next call succeeds.
7. **Background-turn notification when queued behind active work.** Assert `notificationStore.create` called with `kind: "scheduled_task_status"`, `queuePosition: 1`.
8. **Concurrent `runForegroundTurn` — only one wins.** Two calls, no await. Assert exactly one job executes, exactly one abort fires. (Mirrors gradient-bang's `test_concurrent_player_start_task_only_allows_one`.)

**Test patterns to copy verbatim from gradient-bang:**
- Real frame objects + shimmed processor (mock only at the boundary).
- Monkey-patch `queue_frame`/`send` to capture outbound frames.
- `ScriptedLLMService`-style scripted harness — feed a `(text_delta, tool_call, ...)[]` script into the harness mock.
- Markers (`unit`, `integration`, `requires_server`) — Node's `--test` doesn't have markers natively; use directory layout (`tests/unit/`, `tests/integration/`) and a script wrapper.

### D.3 Recommended Overwatch observability stack

Per gap-tagged-by-priority:

**Tracing — OpenTelemetry**
- `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`.
- OTLP exporter to Jaeger locally, Honeycomb/Axiom in prod.
- Manual spans: `TurnCoordinator.runForegroundTurn`, `executeBackground`, `DeepgramSttAdapter.transcribe`, `DeepgramTtsAdapter.synthesize`. These are the gradient-bang-equivalent `@traced` sites.
- Auto-instrumentation gives `fetch` spans for free → Deepgram HTTP calls show up automatically.

**Metrics — `prom-client`**
Four meters cover the top 5 latency-regression signals:
- `voice_stt_latency_seconds` (histogram) — STT round-trip
- `voice_turn_latency_seconds` (histogram) — end-to-end with subdivision via OTel spans
- `voice_queue_depth` (gauge) — coordinator queue depth at enqueue time
- `voice_interruptions_total` (counter) — per-session interruption rate
- `voice_tts_ttfa_seconds` (histogram) — TTS time-to-first-audio
Expose `/metrics` endpoint. Scrape from Grafana Cloud or any Prometheus backend.

**Error tracking — Sentry**
- `@sentry/node` configured in `src/index.ts` before `serve()`.
- Sentry's tracing wraps `fetch` automatically.
- Per-turn error rate falls out of session.

**Logging — keep current, add structured fields**
- Continue with whatever loguru-equivalent is in use (probably `pino`).
- Add a `traceId` field to every voice-loop log so logs and OTel spans link.
- Add per-component log namespaces (`voice.coordinator`, `voice.stt`, `voice.tts`, `harness.hermes`, etc.).

### D.4 What gradient-bang missed that we should do better

Gradient-bang's `@traced` is on **only one function** (`TaskAgent.on_task_request`). The voice loop, deferred-update queue, inference gate, and event relay are all dark. We should instrument the equivalent sites in Overwatch from day one — concretely:

- Each `runForegroundTurn` and `executeBackground` invocation gets a span with attributes `{ turnId, harness, clientId, queueDepthOnEntry }`.
- STT and TTS spans nest under the turn span, with attributes `{ provider, model, durationMs, tokenCount? }`.
- Interruption events fire a `voice.interrupted` event on the active span before it closes.
- Inference-gate state transitions log with `{ from, to, reason }` so we can replay why a turn was deferred.

This means by the time we ship the voice overhaul, we have a full picture of where latency lives and which interruption paths fire how often.

---

## E. Updated Adoption Plan

The original §8 phases still hold. Layered onto them:

**Phase 0 (do first, before any voice changes)**: stand up tests + observability.
- Vitest or `node --test` runner with the 8 test cases from §D.2.
- OpenTelemetry sdk-node + Sentry + `prom-client` wired into `TurnCoordinator`.
- This becomes the regression net for everything that follows.

**Phase 1** (foundation): unchanged — Deepgram streaming STT, basic VAD signal (Deepgram `UtteranceEnd` for now), `InferenceGateState` TS port.
- **Add**: server-authoritative mute events (`UserMuteStarted/Stopped`-style) and the PTT button consuming them (§A.1.3 — fixes "PTT half-working").

**Phase 2** (smart-turn + interruption): unchanged — `LocalSmartTurnAnalyzerV3` on desktop, `InterruptionFrame` on PTT press not release, atomic interrupt-and-start.
- **Add**: split `turn.done` into `turn.llm_done` + `turn.tts_done` (RTVI parity).
- **Add**: spoken/unspoken cursor on assistant messages (§A.1.2 — visual interrupt indicator).

**Phase 3** (out-of-band context): unchanged.
- **Add**: full tool-call lifecycle messages (`llm-function-call-started/in-progress/stopped`) with `tool_call_id`, args, result. Currently `turn.tool_call` only carries the name, which kills observability.

**Phase 4** (state cleanup): unchanged — single state owner, per-client addressing.
- **Add**: collapse `useAudioStore` + `turnState` + ad-hoc refs into one conversation store; derive `isAgentSpeaking` / `isUserSpeaking` from message finalization rather than storing them (§A.3).
- **Add**: deferred bot-message finalization 1500 ms timer (§A.1.1 — fixes split bubbles).

**Phase 5 (new — only if voice UX moves to always-listening)**: WebRTC migration.
- Local mode: SmallWebRTC + MTU clamp.
- Relay: signaling-only or coturn for full WebRTC.
- Cooldown drops from 2 s → ~300 ms once AEC is in place.

---

## F. Updated Anti-Patterns

Adding to the original §8.1:

- **Don't try to adopt RTVI wholesale.** It assumes WebRTC media-track audio. We'd need to either run Pipecat as a sidecar (heavy) or fake RTVI over WS (negates benefits). Selectively copy message types instead.
- **Don't store `isAgentSpeaking` / `isUserSpeaking` as boolean state.** Derive from message finalization (`final: false` on the active assistant/user message). Storing them creates the same split-state bug we already have.
- **Don't add observability "later."** The point of building it before the voice overhaul is to have the regression net in place when behavior starts changing. Without traces, debugging interrupt races is guessing.
- **Don't run smart-turn ONNX on the mobile.** 8 MB model + battery cost. Desktop runs it on streamed PCM.
- **Don't use `@traced` (or OTel `startActiveSpan`) only on entry points.** Gradient-bang did this and now their voice loop is dark. Instrument every async boundary in the voice path from day one.

---

## G. Updated File Index (additional gradient-bang files referenced)

**Client**
- `client/app/src/components/PipecatClientAudio.tsx` — single-`<audio>` pattern, `setSinkId` routing
- `client/app/src/components/conversation/ConversationProvider.tsx` — RTVI event subscription, 1500 ms finalization timer
- `client/app/src/stores/conversation.ts` — message store, tool-call interleaving via timestamp backdating
- `client/app/src/hooks/usePipecatConversation.ts` — spoken/unspoken cursor split
- `client/app/src/components/conversation/MessageContent.tsx` — dimmed-text rendering for unspoken portion
- `client/app/src/components/conversation/FunctionCallContent.tsx` — collapsible tool-call cards
- `client/app/src/components/UserMicControl.tsx` — server-authoritative mute guard
- `client/app/src/components/SettingsPanel.tsx` — voice/personality/device UX
- `client/app/src/capture/VoiceCapture.ts` — replay rolling buffer (low-priority for us)

**Tests + observability**
- `pyproject.toml` (test config, markers)
- `tests/conftest.py`, `tests/integration/conftest.py`
- `tests/integration/e2e_harness.py` — `ScriptedLLMService`, `E2EHarness`
- `tests/unit/test_inference_gate.py` — priority classification
- `tests/unit/test_idle_report.py` — real-sleep timer tests
- `tests/unit/test_voice_agent.py` — deferred-frame coalescing
- `tests/unit/test_voice_relay_integration.py` — most comprehensive voice routing tests
- `src/gradientbang/utils/weave_tracing.py` — `@traced` no-op pattern
- `src/gradientbang/utils/token_usage_logging.py` — async CSV writer pattern
- `src/gradientbang/utils/logging_config.py` — loguru per-agent colors

---

---

## H. Harness Event Taxonomy and Extensible Registry — The Load-Bearing Section

This is the most important section of the addendum. The user's reframing: since we delegate to Hermes / Claude Code / Pi (and will soon add Codex / cursor-agent / others), the question of "how does the voice pipeline integrate with diverse harness event streams without losing fidelity or speed" matters more than gradient-bang's compaction story. Gradient-bang's `EVENT_CONFIGS` declarative router is the right model — but ours routes *harness events* into voice actions, not game events into LLM injections.

### H.1 The current bottleneck: 7-type `HarnessEvent` union

`src/shared/events.ts:1-8` defines:

```ts
export type HarnessEvent =
  | { type: "session_init"; sessionId?: string; tools?: string[]; raw: unknown }
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "reasoning_delta"; text: string; raw: unknown }
  | { type: "assistant_message"; text: string; raw: unknown }
  | { type: "tool_call"; name: string; raw: unknown }
  | { type: "result"; text: string; raw: unknown }
  | { type: "error"; message: string; raw: unknown };
```

Every variant carries `raw: unknown` as an escape hatch — but **`raw` is never read downstream**. So the typed surface area is the ceiling. The 7 types are inadequate for what each provider actually emits; everything else is silently dropped.

### H.2 Per-provider event taxonomy

Drawn from a deep audit of the three current adapters and each provider's wire schema. Items marked **dropped** are silently lost in the current adapter.

**Claude Code CLI** (`src/harness/claude-code-cli.ts:26`, parses `claude -p --output-format stream-json --include-partial-messages` stdout)

| Wire event | Currently | Should be (voice action) |
|---|---|---|
| `system/init` | `session_init` (lossy: drops model, MCP server list, permissions, cost budget) | inject silently |
| `stream_event/content_block_delta/text` | `text_delta` ✅ | speak |
| `stream_event/content_block_delta/thinking` | **dropped** at `claude-code-cli.ts:54` | inject silently (reasoning) |
| `stream_event/content_block_delta/input_json_delta` | **dropped** | ui-only (live tool input preview) |
| `assistant` | `assistant_message` (lossy: drops tool_use blocks in content) | speak (full turn) |
| `result` | `result` (lossy: drops cost, usage, duration, error subtype) | ui-only |
| `user` (tool_result blocks) | **dropped** | inject silently |
| `system/compact_boundary` | **dropped** | ui-only |
| `system/plugin_install` | **dropped** | ui-only |
| `SDKHook*Message` (PreToolUse, PostToolUse, etc.) | **dropped** | drop (or ui-only) |
| `SDKTaskStarted/Progress/Updated/Notification` | **dropped** | inject silently (background tasks) |
| `SDKFilesPersistedEvent` | **dropped** | inject silently |
| `SDKToolUseSummaryMessage` | **dropped** | inject silently |
| `SDKRateLimitEvent` | **dropped** | inject silently (warn user) |
| `SDKAuthStatusMessage` | **dropped** | speak (auth → error) |
| `prompt_suggestion` | **dropped** | ui-only |

**Hermes** (`src/harness/hermes-events.ts:25`, SSE from `GET /v1/runs/{run_id}/events`)

| SSE event | Currently | Should be |
|---|---|---|
| `tool.started` | `tool_call` (lossy: no input, no tool ID) | speak |
| `tool.completed` | **dropped** at `hermes-events.ts:38-40` (comment: "tool-pill UX uses tool.started only") | inject silently |
| `reasoning.available` | `reasoning_delta` ✅ (Hermes is the only provider that actually produces this in overwatch today) | inject silently |
| `message.delta` | `text_delta` ✅ | speak |
| `message.completed` | `assistant_message` ✅ | speak (full turn) |
| `run.completed` | sets `done: true`, **no event emitted** at `hermes-events.ts:73` — there's no typed signal distinguishing "done successfully" from "stream dropped" | ui-only |
| `run.failed` | `error` ✅ | speak |
| Any other event | **dropped** at default case `hermes-events.ts:84` | varies |

**Pi Coding Agent** (`src/harness/pi-coding-agent.ts:195`, in-process `session.subscribe()`)

| Subscribe event | Currently | Should be |
|---|---|---|
| `message_update / assistantMessageEvent.text_delta` | `text_delta` ✅ | speak |
| `message_update / assistantMessageEvent.thinking_delta` (probable) | **dropped** at `pi-coding-agent.ts:196` (only `text_delta` branch) | inject silently |
| `message_update / assistantMessageEvent.tool_use_start` (probable) | **dropped** | inject (counted as part of tool lifecycle) |
| `tool_execution_start` | `tool_call` (lossy) | speak |
| `tool_execution_end` (probable counterpart) | **not handled** (no branch) | inject silently |
| Session end (via `session.prompt()` resolution) | `result` with hardcoded `text: ""` | ui-only |
| `getSessionStats()` (sync, post-turn) | **never called** | ui-only (token usage) |
| Extension events (`schedulerExtension`, `memoryExtension`) | **dropped** | varies — must investigate |

### H.3 Cross-provider invariants

Every coding harness emits these in some form. Names differ; semantics align:

| Canonical concept | Claude Code | Hermes | Pi |
|---|---|---|---|
| Session start | `system/init` | synthetic harness-side `session_init` | (none — persistent session) |
| Streaming text chunk | `stream_event/content_block_delta/text` | `message.delta` | `message_update/text_delta` |
| Completed turn | `assistant` message | `message.completed` | `session.prompt()` resolution |
| Tool started | `assistant`'s `tool_use` blocks | `tool.started` | `tool_execution_start` |
| Tool completed | `user` w/ `tool_result` blocks | `tool.completed` | `tool_execution_end` (inferred) |
| Session end | `result` (`subtype: success`) | `run.completed` | promise resolution |
| Error | `result` (`subtype: error_*`) or non-zero exit | `run.failed` | thrown exception |
| Reasoning / thinking | `stream_event/content_block_delta/thinking` | `reasoning.available` | `assistantMessageEvent/thinking_delta` (probable) |

### H.4 Provider-specific events (no cross-provider analog)

These need provider-namespaced registry entries; they have no canonical home:

- **Claude Code only**: `compact_boundary`, `SDKToolUseSummaryMessage`, `SDKFilesPersistedEvent`, `SDKTask*Message`, `SDKHook*Message`, `SDKRateLimitEvent`, `prompt_suggestion`, `parent_tool_use_id` linkage (subagent call tree), `input_json_delta` (partial tool input streaming).
- **Hermes only**: `reasoning.available` block (the only provider that types reasoning explicitly), `tool.completed.output` (the only provider that returns tool output as a typed event).
- **Pi only**: `getSessionStats()` token usage, extension-emitted events (memory, scheduler).

Future providers (Codex, cursor-agent, etc.) will add their own. The architecture must accommodate them with zero pipeline-core changes.

### H.5 Two-tier `HarnessEvent` union (proposed)

Tier 1 = canonical cross-provider events (typed). Tier 2 = `provider_event` envelope (typed wrapper, untyped payload).

```ts
// src/shared/events.ts (proposed)
export type HarnessEvent =
  // ── Tier 1: Canonical cross-provider events ─────────────────────────
  | { type: "session_init";    sessionId?: string; tools?: string[]; model?: string; raw: unknown }
  | { type: "text_delta";      text: string; raw: unknown }
  | { type: "reasoning_delta"; text: string; raw: unknown }
  | { type: "assistant_message"; text: string; raw: unknown }
  | { type: "tool_lifecycle";
      phase: "start" | "progress" | "complete";
      name: string;
      toolUseId?: string;
      input?: unknown;
      result?: unknown;
      raw: unknown }
  | { type: "session_end";     subtype: "success" | "error"; result?: string;
      costUsd?: number; usage?: { input: number; output: number }; raw: unknown }
  | { type: "error";           message: string; raw: unknown }
  // ── Tier 2: Provider-specific passthrough ────────────────────────────
  | { type: "provider_event";
      provider: "claude-code" | "hermes" | "pi" | (string & {});
      kind: string;       // e.g. "compact_boundary", "task_progress", "files_persisted"
      payload: unknown;   // typed by registry consumers, not the union
      raw: unknown };
```

Key changes vs current:
- `tool_call` → `tool_lifecycle` with `phase`, `toolUseId`, `input`, `result`. Backward-compat shim: `phase: "start"` is the old `tool_call`.
- `result` → `session_end` with `subtype`, `costUsd`, `usage`. Better name, more fields.
- New `provider_event` envelope is the structural fix. Anything an adapter cannot map cleanly to Tier 1 emits as `provider_event` with the provider name and a `kind` string. **Nothing is silently dropped at the adapter layer ever again.**

### H.6 The `HARNESS_EVENT_CONFIGS` registry

Modeled on gradient-bang's `EVENT_CONFIGS` (`event_relay.py:940-1121`). One entry per `kind`, declarative.

```ts
// src/harness/event-registry.ts
type VoiceAction = "speak" | "inject" | "ui-only" | "drop";
type Provider = "claude-code" | "hermes" | "pi" | (string & {}) | "*";

interface HarnessEventConfig {
  voiceAction: VoiceAction;
  priority?: number;        // 1 (low) to 10 (critical), default 5
  coalesceWith?: string;    // merge into another event's TTS to prevent double-speak
  provider: Provider;       // "*" for cross-provider canonical
  debounceMs?: number;      // collapse rapid bursts (e.g. files_persisted)
}

export const HARNESS_EVENT_CONFIGS: Record<string, HarnessEventConfig> = {
  // ── Cross-provider canonical (Tier 1) ────────────────────────────────
  "text_delta":         { provider: "*", voiceAction: "speak",     priority: 8 },
  "reasoning_delta":    { provider: "*", voiceAction: "inject",    priority: 3 },
  "assistant_message":  { provider: "*", voiceAction: "speak",     priority: 8, coalesceWith: "text_delta" },
  "tool_lifecycle:start":    { provider: "*", voiceAction: "speak",  priority: 6 },
  "tool_lifecycle:complete": { provider: "*", voiceAction: "inject", priority: 4 },
  "session_end":        { provider: "*", voiceAction: "ui-only",   priority: 2 },
  "error":              { provider: "*", voiceAction: "speak",     priority: 9 },
  "session_init":       { provider: "*", voiceAction: "inject",    priority: 1 },

  // ── Claude Code provider-specific (Tier 2) ──────────────────────────
  "claude-code/compact_boundary":    { provider: "claude-code", voiceAction: "ui-only", priority: 2 },
  "claude-code/files_persisted":     { provider: "claude-code", voiceAction: "inject",  priority: 2, debounceMs: 500 },
  "claude-code/rate_limit":          { provider: "claude-code", voiceAction: "inject",  priority: 7 },
  "claude-code/task_progress":       { provider: "claude-code", voiceAction: "ui-only", priority: 3 },
  "claude-code/hook_response":       { provider: "claude-code", voiceAction: "drop",    priority: 1 },
  "claude-code/prompt_suggestion":   { provider: "claude-code", voiceAction: "ui-only", priority: 2 },
  "claude-code/plugin_install":      { provider: "claude-code", voiceAction: "ui-only", priority: 3 },
  "claude-code/tool_use_summary":    { provider: "claude-code", voiceAction: "inject",  priority: 3 },
  "claude-code/auth_status":         { provider: "claude-code", voiceAction: "speak",   priority: 9 },

  // ── Hermes provider-specific ────────────────────────────────────────
  "hermes/run_completed":            { provider: "hermes",      voiceAction: "ui-only", priority: 2 },

  // ── Pi provider-specific ────────────────────────────────────────────
  "pi/session_stats":                { provider: "pi",          voiceAction: "ui-only", priority: 1 },
  // (more added as they're discovered — see open questions)
};
```

### H.7 Voice action semantics

Each `voiceAction` maps to a concrete pipeline operation. All decisions are O(1) hash lookups — no regex, no async, no I/O on the hot path.

- **`speak`**: text content queued to TTS, gated by the inference gate (§4). Events with `coalesceWith` are merged into one utterance instead of double-queued. `text_delta` events accumulate in a sentence buffer before queuing. `error` events preempt the buffer. Priority decides queue order when multiple `speak` events are pending.
- **`inject`**: payload serialized as a compact `<event kind="..." provider="...">...</event>` XML block and appended to the harness's next-turn context (passed via the harness's input mechanism, not via a shared LLM context — since each harness owns its own). `run_llm: false` analog — the harness sees it on the next user turn. Goes through the deferred-update queue (§5.4) if a turn is in flight.
- **`ui-only`**: typed `provider_event` envelope forwarded to the mobile UI via the existing WS gateway. UI renders as a pill / badge / status row. No LLM context, no TTS.
- **`drop`**: no-op with a single `debug` log line. Auditable in traces, free in the hot path.

For provider events that need async enrichment (e.g., reading a `files_persisted` list and summarizing), the synchronous portion injects immediately and a deferred worker appends a follow-up frame when enrichment completes. Same pattern as gradient-bang's deferred-update queue.

### H.8 Adding a new provider — 5-step recipe

This is the extensibility story. To add Codex / cursor-agent / next-thing-people-ask-for:

1. **Write the adapter** at `src/harness/<provider>.ts` implementing `OrchestratorHarness`. Parse the wire format (subprocess stdout, SSE, in-process callback, whatever).
2. **Emit canonical Tier 1 events** for the obvious cases: `session_init`, `text_delta`, `tool_lifecycle`, `session_end`, `error`. These need zero registry changes — pipeline core handles them.
3. **Emit `provider_event`** for everything provider-specific. Every wire event with no canonical analog becomes `{ type: "provider_event", provider: "codex", kind: "approval_prompt", payload, raw }`. **Adapter never silently drops.**
4. **Register entries in `HARNESS_EVENT_CONFIGS`** for each `provider/kind`. One line each. Example: `"codex/approval_prompt": { provider: "codex", voiceAction: "speak", priority: 9 }`.
5. **Register the provider** in `src/harness/providers/index.ts` and `<provider>.ts`. No changes to pipeline core, TTS, STT, or WS gateway.

### H.9 Quick-response considerations

The registry must not add latency to the voice loop. Three rules:

- **No async in the lookup.** `HARNESS_EVENT_CONFIGS[key]` is a property access, period. Async work (e.g., `inject` fetching context) goes to a deferred queue.
- **No regex on event-type strings.** All keys are exact string matches. Compound keys (`"${provider}/${kind}"`) constructed at adapter emit time, not at lookup time.
- **`debounceMs` is router state, not registry state.** The config is a static immutable constant so V8 can inline the lookup. Per-kind timer state lives in the router instance.

The registry must be a `const` exported from a static ES module so the JIT compiles the lookup table at startup. Runtime mutation is prohibited — it would invalidate the JIT-inlined object shape.

### H.10 Open questions (must verify against live providers before shipping)

The harness research relied on public docs + adapter code. These need confirmation against actual streamed output:

1. **Pi's full `session.subscribe()` event union.** `@mariozechner/pi-coding-agent` is not publicly documented. Need to instrument the subscribe callback with a catch-all logger in a live session and enumerate every `type` and `assistantMessageEvent.type` that fires.
2. **Hermes SSE event completeness.** Default-case drop at `hermes-events.ts:84` may be hiding `memory.updated`, `cron.triggered`, `skill.activated`, etc. Need a raw SSE trace.
3. **Claude Code thinking-delta path.** Does `--include-partial-messages` cause thinking deltas to appear inside `stream_event` (currently dropped at `claude-code-cli.ts:54`), or only inside the final `assistant` message's content array? Need a live capture with an extended-thinking model.
4. **`run.completed` payload from Hermes.** Currently sets `done: true` with no event emitted. Does it carry a `result`/`output` field that we're losing?
5. **`tool_execution_end` in Pi.** No branch handles it. If it exists, it carries the tool result — which would be valuable `inject` material.

A catch-all logging mode on each adapter (env-gated) that dumps every wire event to a per-session JSONL would resolve all five questions in one afternoon of live-traffic capture.

### H.11 How this changes the adoption plan

The registry is the spine of the new harness boundary. It belongs in **Phase 1 (foundation)** alongside the inference gate, not later — because Phase 2's smart-turn and Phase 3's out-of-band injection both depend on knowing what events exist and where they route.

Updated Phase 1 list:
- (existing) Streaming STT
- (existing) Basic VAD signal
- (existing) `InferenceGateState` TS port
- (existing) Server-authoritative mute events
- **(new) `HarnessEvent` two-tier union refactor**
- **(new) `HARNESS_EVENT_CONFIGS` registry + voice-action router**
- **(new) Catch-all logging mode on each adapter** for the open-question discovery pass

Phase 3 (out-of-band context) becomes much smaller in scope, because most of what we previously called "monitoring events" now fall under harness `provider_event`s. The non-harness monitoring events (e.g., desktop-side observability alerts) remain — but they go through the same registry with `provider: "overwatch"` namespace.

---

---

## I. Existing OSS Wrappers — What's Already Been Built

Survey of actively-maintained (≤90-day commit cutoff, 2026-02-01) open-source UI wrappers and orchestrators around Claude Code, Hermes, and Pi Coding Agent. Goal: confirm whether the §H two-tier registry design is novel or whether someone else has already solved it well enough to adopt directly.

### I.1 Triage (≤90 day commit gate)

~25 candidates surfaced; 5 survived freshness + relevance triage. Stale or out-of-scope candidates dropped without further investigation:

| Project | Last commit | Outcome |
|---|---|---|
| **badlogic/pi-mono** | 2026-05-01 | Survived — the headline finding |
| **ComposioHQ/agent-orchestrator** | 2026-05-01 | Survived |
| Ngxba/claude-code-agents-ui | 2026-04-14 | Survived (cautionary tale) |
| nesquena/hermes-webui | 2026-05-01 | Survived (cautionary tale) |
| outsourc-e/hermes-workspace | 2026-05-01 | Survived (light read; revisit in 60 days) |
| smtg-ai/claude-squad | 2026-03-28 | Pure tmux spawner, no event surface — out of scope |
| musistudio/claude-code-router | 2026-03-04 | HTTP request router, not a UI/event harness — out of scope |
| anthropics/claude-agent-sdk-demos | 2026-03-13 | Reference demos only |
| ninehills/claude-agent-ui, plandex-ai/plandex, others | <90 day cutoff or stale | Dropped |

### I.2 Headline finding: pi-mono validates §H's two-tier design

**badlogic/pi-mono** (the upstream of `@mariozechner/pi-coding-agent`, which Overwatch already depends on) independently arrived at the same architectural pattern we proposed in §H:

1. **Typed internal event bus** (`event-bus.ts`) for cross-module pub/sub inside the agent core.
2. **Public lifecycle hook API** (`ExtensionAPI.on(event, handler)`) — a curated, versioned set of ~30 lifecycle events exposed to extensions. Direct analog to our `HARNESS_EVENT_CONFIGS` keyset.
3. **Out-of-process JSONL RPC protocol** so external UIs can be a third tier without sharing the agent's process. Direct analog to what our voice pipeline ↔ harness boundary becomes when the harness runs in a different tmux pane.
4. **Handler return values that mutate the in-flight turn** — `tool_call → { block: true, reason }`, `before_agent_start → { systemPrompt }`. This is cleaner than a separate "filter chain" abstraction.

Concrete pi-mono hook taxonomy (worth copying as starter set for our registry keys): `session_start`, `before_agent_start`, `agent_start`/`end`, `turn_start`/`end`, `message_start`/`update`/`end`, `context`, `before_provider_request`, `after_provider_response`, `tool_call`, `tool_result`, `tool_execution_start`/`update`/`end`, `input`, `model_select`, `session_before_compact`, `session_compact`, `session_before_fork`, `session_before_tree`, `session_shutdown`, `user_bash`, `resources_discover`, `compaction_start`/`end` (with `reason`, `aborted`, `willRetry`), `auto_retry_start`/`end`, `extension_error`, `extension_ui_request`, `queue_update`.

The takeaway: **our §H taxonomy is undersized.** Pi's list is ~30 events; ours covers ~10. We should adopt pi's list wholesale for the Pi adapter, then map cross-provider analogs from Claude Code and Hermes onto the same canonical names where possible.

### I.3 Composio's plugin-registry shape (for the adapter side)

**ComposioHQ/agent-orchestrator** has the cleanest plugin-registry pattern in the survey for the *harness adapter* side of the boundary:

- `packages/core/src/plugin-registry.ts` keys plugins by `slot:name` (e.g. `agent:claude-code`, `agent:codex`).
- Each plugin exports `PluginModule { manifest, create(config) }`.
- Eight plugin slots: `runtime`, `agent`, `workspace`, `tracker`, `scm`, `notifier`, `terminal`, plus a non-pluggable lifecycle manager.
- Plugins resolve from built-in / npm `@aoagents/*` / local file paths — supports both first-party and community adapters.

The `Agent` interface itself is the cleanest cross-agent abstraction we found:

```ts
interface Agent {
  getLaunchCommand(): string[];
  getEnvironment(): Record<string, string>;
  detectActivity(terminalOutput: string): ActivityState;   // sync, text fallback
  getActivityState(session: Session): Promise<ActivityState>;  // async, native
  isProcessRunning(session: Session): Promise<boolean>;
  getSessionInfo(session: Session): Promise<SessionInfo>;
  // optional:
  getRestoreCommand?(): string[];
  preLaunchSetup?(): Promise<void>;
  postLaunchSetup?(session: Session): Promise<void>;
  setupWorkspaceHooks?(workspace: Workspace): Promise<void>;
  recordActivity?(event: ActivityEvent): void;
}
```

Two ideas worth lifting into our adapter contract:

- **`detectActivity(terminalOutput)` (sync, text fallback) vs `getActivityState(session)` (async, native).** When the structured channel is missing or unhealthy, fall back to scraping. For Claude Code that means scraping the terminal pane; for Hermes it means polling `/v1/runs/{id}`; for Pi it means inspecting `getSessionStats()`.
- **JSONL session-file tailing as a stable cross-version channel.** Composio's claude-code adapter reads `~/.claude/projects/*/`'s JSONL session files (tail 128 KB) to extract activity, summary, token usage, and cost — bypassing terminal scraping and surviving stream-json schema additions. This is a great fallback for Overwatch when stream-json is unavailable, when reattaching to a backgrounded session, or as a cross-check during early adapter development.

Composio whiffs on the *event* side of the boundary, though — their event log is write-only SQLite that the UI polls, with no in-process subscriber path. **We borrow Composio's adapter-registry shape, not their event model.**

### I.4 Cautionary tales (validate the design by showing what fails)

- **Ngxba/claude-code-agents-ui** — `messageNormalizer.ts` is a 250+ line flat if/else cascade with no registry. Has the comment `// Cast because tool_input_delta is not in standard types`. **Exact pain we're designing against.** Plan mode, hooks, MCP tool calls, `compact_boundary` are all silently dropped because they fall into the default branch. Recent commits, but architecture already buckling under SDK churn.
- **nesquena/hermes-webui** — `streaming.py` is a 2000+ line monolith mixing SSE pumping with per-model regex scrubbers (DeepSeek, MiniMax, Kimi, Bedrock). Direct in-process import of the agent. Adding a new agent backend requires rewriting the file. Counter-pattern for "what happens when you don't separate per-provider quirks from the trunk."

Both projects clear the freshness gate but illustrate the cost of not having the two-tier abstraction: every upstream SDK change forces another conditional branch in a single growing file.

### I.5 Cross-project patterns to copy (consolidated)

Updates to §H based on the survey:

1. **Adopt pi-mono's full lifecycle hook taxonomy as the canonical event keys** for the Pi adapter, then map Claude Code and Hermes events onto the same names where there's a natural cross-provider analog. Add `compaction_start`/`end`, `auto_retry_start`/`end`, `extension_error`, `queue_update` to our registry.
2. **Add handler-mutation capability to `HarnessEventConfig`** — beyond `voiceAction`, allow optional `handler: (event) => Mutation | void` where `Mutation` can `block` tool calls, replace prompt content, or transform inputs. This avoids needing a separate filter-chain abstraction. *Note: this expands the registry's role from "voice routing" to "voice routing + harness steering" — that's a deliberate scope increase.*
3. **Adopt Composio's `PluginModule { manifest, create(config) }` + slot-keyed registry** for the adapter side. Ship adapters as `@overwatch/agent-*` npm packages eventually. Slots we need: `agent`, `workspace`, `notifier`, possibly `runtime` (tmux vs subprocess vs container).
4. **Adopt Composio's `Agent` interface split** between `detectActivity(terminalOutput)` and `getActivityState(session)`. Gives us graceful degradation when the structured channel is missing.
5. **JSONL session-file tailing for Claude Code as a fallback channel.** Implement alongside stream-json, not instead of — stream-json is fresher; JSONL is the safety net for reattach + backgrounded sessions.
6. **Strict LF-only JSONL framing on any wire protocol we expose.** Pi's `rpc.md` explicitly warns against `readline`-style splitters because of a Unicode-separator bug. We hit similar issues; pin LF in our protocol doc.
7. **Hot-reload on a known directory layout** for harness adapters loaded from disk (`~/.overwatch/adapters/`, `.overwatch/adapters/`). Pi has this; Composio has this; mature pattern.
8. **`extension_ui_request` round-trip pattern** if/when we want adapters to drive Overwatch UI from outside the host process (e.g., a custom-tool plugin requesting a confirmation dialog).
9. **`NormalizedMessage` envelope** with `kind`, `id`, `sessionId`, `timestamp`, `metadata` plus an `attachToolResults` post-pass that pairs `tool_use` → `tool_result` by `toolUseId` (Ngxba). The envelope DTO and the pairing helper are good even though the rest of Ngxba's design is the cautionary tale.

### I.6 Cross-project anti-patterns (consolidated)

1. **Stringly-typed event unions with no factory** (Composio's `EventType`, Ngxba's `kind`). Use a discriminated union + factory.
2. **One giant if/else normalizer** (Ngxba, hermes-webui). The whole point of the registry is to make this impossible.
3. **Write-only event log polled from a database** (Composio's SQLite-as-bus). Reactive subscribers must be first-class.
4. **Per-model regex scrubbers in the streaming hot path** (hermes-webui). Belongs in a per-provider adapter.
5. **Direct in-process import of the agent** (hermes-webui). Defeats RPC isolation, couples deploys.

### I.7 Honest validation of §H's novelty

The survey's most useful conclusion: **no project we found has both** (a) a typed two-tier event registry **and** (b) a swappable agent-harness layer. Pi has the event design right but is single-agent (only Pi). Composio has the harness pluggability right but its event tier is write-only SQLite. The Hermes wrappers and Ngxba already buckled under upstream churn within months.

Our §H combination is novel in this specific intersection. That scarcity is the signal that it matters — and the survey gives us starter taxonomies and adapter shapes to borrow so we don't re-derive them.

### I.8 Things to revisit in 60 days

- **outsourc-e/hermes-workspace** — most active and most thoughtful Hermes wrapper; their `agent-authored-ui-state.md` and `swarm2-agent-ide-spec.md` may grow into a real harness boundary. Worth a deep read on next survey.
- **ComposioHQ/agent-orchestrator** — high commit velocity (1175 commits, daily activity); they may close the event-tier gap with a reactive subscriber API.
- **anthropics/claude-agent-sdk-demos** — the `AskUserQuestion HTML previews demo` (PR #58, March 2026) hints Anthropic is moving toward host-mediated UI requests, similar to pi's `extension_ui_request`. If they ship a canonical pattern, align with it.
- **musistudio/claude-code-router** — out of scope today (request router) but if they add an event-routing surface it becomes directly relevant.
- **Anthropic's Claude Code itself** — keep watching for new stream-json event types (especially around agent teams, MCP elicitation, plan-mode transitions). Each new type is a stress test for whether our registry handles it without code changes.

---

**End of research.** Next step is a Plan doc that sequences phases 0–5 (with the updated Phase 1) into concrete PRs, starting with test/observability scaffolding before any voice-stack changes. The harness event registry + adapter refactor (§H, validated and concretized by §I) is the second-most-load-bearing change after the inference gate itself. The §H section should be updated *before* the Plan doc with the specific borrowings from pi-mono (full lifecycle hook taxonomy) and Composio (PluginModule shape, JSONL fallback channel) called out in §I.5.
