/**
 * Regression test — reasoning_delta MUST NOT reach TTS.
 *
 * This is the load-bearing invariant of the Hermes integration. The TurnCoordinator
 * routes events from the harness; text_delta goes to both socket and TTS, but
 * reasoning_delta must go to socket only. A future refactor that accidentally
 * forwards reasoning_delta to the TTS textChunks would cause the agent's
 * thinking to be spoken aloud.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnCoordinator } from "../src/orchestrator/turn-coordinator.js";
import type { OrchestratorHarness, HarnessTurnRequest } from "../src/harness/types.js";
import type { HarnessEvent } from "../src/shared/events.js";
import type { TtsAdapter, TtsSynthesisRequest } from "../src/tts/types.js";
import type { TtsEvent } from "../src/shared/events.js";

class FakeHarness implements OrchestratorHarness {
  constructor(private readonly events: HarnessEvent[]) {}
  async *runTurn(_req: HarnessTurnRequest): AsyncIterable<HarnessEvent> {
    for (const event of this.events) yield event;
  }
}

class CapturingTts implements TtsAdapter {
  public readonly received: string[] = [];

  async *synthesize(req: TtsSynthesisRequest): AsyncIterable<TtsEvent> {
    for await (const chunk of req.textChunks) {
      this.received.push(chunk);
    }
    // Emit nothing — we only care about what TTS *received*.
  }
}

await test("reasoning_delta is never forwarded to TTS", async () => {
  const harness = new FakeHarness([
    { type: "reasoning_delta", text: "hmm let me think about this", raw: {} },
    { type: "text_delta", text: "Hello.", raw: {} },
    { type: "reasoning_delta", text: "actually I should add more detail", raw: {} },
    { type: "text_delta", text: " I'm here.", raw: {} },
  ]);
  const tts = new CapturingTts();
  const coordinator = new TurnCoordinator(harness, tts);

  const sentEvents: Array<{ event: string; payload: any }> = [];
  await coordinator.runForegroundTurn({
    prompt: "test",
    tts: true,
    send: (event, payload) => {
      sentEvents.push({ event, payload });
    },
  });

  // TTS should only see the spoken text, never the reasoning.
  assert.deepEqual(tts.received, ["Hello.", " I'm here."]);
  for (const chunk of tts.received) {
    assert.ok(!chunk.includes("hmm"), `TTS leaked reasoning: ${chunk}`);
    assert.ok(!chunk.includes("actually"), `TTS leaked reasoning: ${chunk}`);
  }

  // Socket should see reasoning_delta envelopes.
  const reasoningEvents = sentEvents.filter((e) => e.event === "turn.reasoning_delta");
  assert.equal(reasoningEvents.length, 2, "expected 2 reasoning_delta envelopes");
  assert.equal(reasoningEvents[0]!.payload.text, "hmm let me think about this");
  assert.equal(reasoningEvents[1]!.payload.text, "actually I should add more detail");

  // Socket should also see text_delta envelopes.
  const textEvents = sentEvents.filter((e) => e.event === "turn.text_delta");
  assert.equal(textEvents.length, 2);
  assert.equal(textEvents[0]!.payload.text, "Hello.");
  assert.equal(textEvents[1]!.payload.text, " I'm here.");
});
