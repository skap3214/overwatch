/**
 * Adapter mapping tests for Pi coding agent's session.subscribe() events.
 *
 * Critical invariant: every event from the Pi runtime maps to either Tier-1
 * canonical AdapterEvents or surfaces as Tier-2 provider_event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapPiEventForTest } from "../src/harness/pi-coding-agent.js";

test("pi: message_update text_delta → text_delta", () => {
  const out = mapPiEventForTest({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hello" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "text_delta");
  assert.equal((out[0] as { text: string }).text, "Hello");
});

test("pi: message_update thinking_delta → reasoning_delta", () => {
  const out = mapPiEventForTest({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "Considering..." },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "reasoning_delta");
  assert.equal((out[0] as { text: string }).text, "Considering...");
});

test("pi: message_update tool_use_start → tool_lifecycle start", () => {
  const out = mapPiEventForTest({
    type: "message_update",
    assistantMessageEvent: {
      type: "tool_use_start",
      toolName: "Read",
      toolUseId: "tu-1",
      input: { path: "auth.ts" },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_lifecycle");
  assert.equal((out[0] as { phase: string }).phase, "start");
  assert.equal((out[0] as { name: string }).name, "Read");
});

test("pi: message_update unknown subtype → provider_event passthrough", () => {
  const out = mapPiEventForTest({
    type: "message_update",
    assistantMessageEvent: { type: "future_kind", payload: { foo: 1 } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { kind: string }).kind, "message_update/future_kind");
});

test("pi: tool_execution_start → tool_lifecycle start", () => {
  const out = mapPiEventForTest({
    type: "tool_execution_start",
    toolName: "Bash",
    toolUseId: "tu-2",
    input: { command: "ls" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_lifecycle");
  assert.equal((out[0] as { phase: string }).phase, "start");
});

test("pi: tool_execution_end → tool_lifecycle complete", () => {
  const out = mapPiEventForTest({
    type: "tool_execution_end",
    toolName: "Bash",
    toolUseId: "tu-2",
    result: "Files listed",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_lifecycle");
  assert.equal((out[0] as { phase: string }).phase, "complete");
});

test("pi: extension event (memoryExtension) → provider_event", () => {
  const out = mapPiEventForTest({
    type: "memory_updated",
    key: "user_pref",
    value: "verbose",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { provider: string }).provider, "pi");
  assert.equal((out[0] as { kind: string }).kind, "memory_updated");
});

test("pi: scheduler event → provider_event", () => {
  const out = mapPiEventForTest({
    type: "scheduler_fired",
    job_id: "job-42",
  });
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { kind: string }).kind, "scheduler_fired");
});

test("pi: missing type → empty array", () => {
  const out = mapPiEventForTest({ no_type: "field" });
  assert.equal(out.length, 0);
});
