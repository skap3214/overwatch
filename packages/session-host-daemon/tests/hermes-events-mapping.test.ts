/**
 * Adapter mapping tests for Hermes SSE events.
 *
 * Critical invariant: every wire event from Hermes either maps to a Tier-1
 * AdapterEvent or surfaces as a Tier-2 provider_event with provider="hermes".
 * Default-case-drop from the legacy code path is gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapHermesEvent } from "../src/harness/hermes-events.js";

test("hermes: tool.started → tool_lifecycle start", () => {
  const result = mapHermesEvent({
    event: "tool.started",
    tool: "Bash",
    tool_use_id: "tu-1",
    input: { command: "ls" },
  });
  assert.equal(result.events.length, 1);
  const evt = result.events[0];
  assert.equal(evt.type, "tool_lifecycle");
  assert.equal((evt as { phase: string }).phase, "start");
  assert.equal((evt as { name: string }).name, "Bash");
  assert.equal((evt as { tool_use_id?: string }).tool_use_id, "tu-1");
});

test("hermes: tool.completed → tool_lifecycle complete (no longer dropped)", () => {
  const result = mapHermesEvent({
    event: "tool.completed",
    tool: "Bash",
    tool_use_id: "tu-1",
    output: "Files listed",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "tool_lifecycle");
  assert.equal((result.events[0] as { phase: string }).phase, "complete");
});

test("hermes: reasoning.available → reasoning_delta", () => {
  const result = mapHermesEvent({
    event: "reasoning.available",
    text: "Analyzing the request",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "reasoning_delta");
  assert.equal((result.events[0] as { text: string }).text, "Analyzing the request");
});

test("hermes: message.delta → text_delta", () => {
  const result = mapHermesEvent({
    event: "message.delta",
    delta: "Hello",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "text_delta");
  assert.equal((result.events[0] as { text: string }).text, "Hello");
});

test("hermes: message.completed → assistant_message", () => {
  const result = mapHermesEvent({
    event: "message.completed",
    text: "Final answer",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "assistant_message");
  assert.equal((result.events[0] as { text: string }).text, "Final answer");
});

test("hermes: run.completed → session_end success + done flag", () => {
  const result = mapHermesEvent({
    event: "run.completed",
    output: "Run finished",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "session_end");
  assert.equal((result.events[0] as { subtype: string }).subtype, "success");
  assert.equal(result.done, true);
});

test("hermes: run.failed → error + session_end error + done", () => {
  const result = mapHermesEvent({
    event: "run.failed",
    error: { message: "Auth expired" },
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "error");
  assert.equal((result.events[0] as { message: string }).message, "Auth expired");
  assert.equal(result.events[1].type, "session_end");
  assert.equal(result.done, true);
});

test("hermes: empty message.delta → no events emitted (silent ok for empty)", () => {
  const result = mapHermesEvent({ event: "message.delta", delta: "" });
  assert.equal(result.events.length, 0);
});

test("hermes: unknown event kind → provider_event with provider=hermes (no silent drop)", () => {
  const result = mapHermesEvent({
    event: "memory.updated",
    key: "user_pref",
    value: "verbose",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "provider_event");
  assert.equal((result.events[0] as { provider: string }).provider, "hermes");
  assert.equal((result.events[0] as { kind: string }).kind, "memory.updated");
});

test("hermes: cron.triggered (future event) → provider_event passthrough", () => {
  const result = mapHermesEvent({
    event: "cron.triggered",
    job_id: "job-42",
    fired_at: "2026-05-02T19:00:00Z",
  });
  assert.equal(result.events[0].type, "provider_event");
  assert.equal((result.events[0] as { kind: string }).kind, "cron.triggered");
});
