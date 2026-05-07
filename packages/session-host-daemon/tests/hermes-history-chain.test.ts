import test from "node:test";
import assert from "node:assert/strict";
import { HermesAgentHarness } from "../src/harness/hermes-agent.js";

function sse(runId: string): Response {
  return new Response(
    `data: ${JSON.stringify({ event: "run.completed", run_id: runId })}\n\n`,
    { status: 200 },
  );
}

test("hermes history chain: turn N+1 sends previous_response_id from turn N", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let runCount = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/v1/runs") && init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      runCount += 1;
      return new Response(JSON.stringify({ run_id: `run-${runCount}` }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (path.endsWith(`/v1/runs/run-${runCount}/events`)) {
      return sse(`run-${runCount}`);
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  const harness = new HermesAgentHarness({
    baseURL: "http://hermes.local",
    apiKey: "test",
    sessionId: "session-1",
    fetchImpl,
  });

  for await (const _ of harness.runTurn({ prompt: "one", correlation_id: "c1" })) {}
  for await (const _ of harness.runTurn({ prompt: "two", correlation_id: "c2" })) {}

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].previous_response_id, undefined);
  assert.equal(bodies[1].previous_response_id, "run-1");
});
