import test from "node:test";
import assert from "node:assert/strict";
import {
  PiCodingAgentHarness,
  mapPiEventForTest,
} from "../src/harness/pi-coding-agent.js";

test("pi history chain: one AgentSession handles multiple prompts", async () => {
  let factoryCalls = 0;
  const prompts: string[] = [];
  const session = {
    subscribe: () => () => {},
    prompt: async (prompt: string) => {
      prompts.push(prompt);
    },
    abort: async () => {},
    getSessionStats: () => ({ tokens: { input: 1, output: 1 } }),
    dispose: () => {},
  };

  const harness = new PiCodingAgentHarness({
    sessionFactory: async () => {
      factoryCalls += 1;
      return session as any;
    },
  });

  for await (const _ of harness.runTurn({ prompt: "one", correlation_id: "c1" })) {}
  for await (const _ of harness.runTurn({ prompt: "two", correlation_id: "c2" })) {}
  for await (const _ of harness.runTurn({ prompt: "three", correlation_id: "c3" })) {}

  assert.equal(factoryCalls, 1);
  assert.deepEqual(prompts, ["one", "two", "three"]);
});

test("pi compaction events map to agent_busy and agent_idle", () => {
  assert.deepEqual(mapPiEventForTest({ type: "compaction_start", reason: "budget" }), [
    {
      type: "agent_busy",
      phase: "compaction",
      reason: "budget",
      raw: { type: "compaction_start", reason: "budget" },
    },
  ]);
  assert.deepEqual(mapPiEventForTest({ type: "compaction_end" }), [
    { type: "agent_idle", raw: { type: "compaction_end" } },
  ]);
});
