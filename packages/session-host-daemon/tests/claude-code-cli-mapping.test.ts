/**
 * Adapter mapping tests for Claude Code CLI.
 *
 * The critical invariant: every wire event from `claude -p --output-format
 * stream-json` either maps to a Tier-1 canonical AdapterEvent or surfaces as
 * a Tier-2 provider_event. Nothing is silently dropped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeCodeCliHarness,
  mapClaudeJsonLineForTest,
} from "../src/harness/claude-code-cli.js";

test("claude-code: system/init → session_init with tools/model", () => {
  const out = mapClaudeJsonLineForTest({
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    tools: ["Read", "Edit", "Bash"],
    model: "claude-sonnet-4-6",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "session_init");
  assert.equal((out[0] as { session_id?: string }).session_id, "sess-1");
  assert.deepEqual(
    (out[0] as { tools?: string[] }).tools,
    ["Read", "Edit", "Bash"],
  );
  assert.equal((out[0] as { model?: string }).model, "claude-sonnet-4-6");
});

test("claude-code: stream_event content_block_delta text → text_delta", () => {
  const out = mapClaudeJsonLineForTest({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { text: "Hello world" },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "text_delta");
  assert.equal((out[0] as { text: string }).text, "Hello world");
});

test("claude-code: stream_event content_block_delta thinking → reasoning_delta", () => {
  const out = mapClaudeJsonLineForTest({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { thinking: "Hmm let me think" },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "reasoning_delta");
  assert.equal((out[0] as { text: string }).text, "Hmm let me think");
});

test("claude-code: assistant text+tool_use → assistant_message + tool_lifecycle.start", () => {
  const out = mapClaudeJsonLineForTest({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Reading the file..." },
        {
          type: "tool_use",
          id: "tu-1",
          name: "Read",
          input: { path: "auth.ts" },
        },
      ],
    },
  });
  assert.equal(out.length, 2);
  const types = out.map((e) => e.type);
  assert.ok(types.includes("tool_lifecycle"));
  assert.ok(types.includes("assistant_message"));
  const tool = out.find((e) => e.type === "tool_lifecycle") as {
    phase: string;
    name: string;
    tool_use_id?: string;
  };
  assert.equal(tool.phase, "start");
  assert.equal(tool.name, "Read");
  assert.equal(tool.tool_use_id, "tu-1");
});

test("claude-code: user with tool_result → tool_lifecycle.complete", () => {
  const out = mapClaudeJsonLineForTest({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "42 lines",
        },
      ],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_lifecycle");
  assert.equal((out[0] as { phase: string }).phase, "complete");
  assert.equal((out[0] as { tool_use_id?: string }).tool_use_id, "tu-1");
});

test("claude-code: result success → session_end success", () => {
  const out = mapClaudeJsonLineForTest({
    type: "result",
    subtype: "success",
    result: "Done.",
    total_cost_usd: 0.012,
    usage: { input: 100, output: 50 },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "session_end");
  assert.equal((out[0] as { subtype: string }).subtype, "success");
  assert.equal((out[0] as { cost_usd?: number }).cost_usd, 0.012);
});

test("claude-code: result error_max_turns → session_end error", () => {
  const out = mapClaudeJsonLineForTest({
    type: "result",
    subtype: "error_max_turns",
    result: "Hit turn limit",
  });
  assert.equal(out.length, 1);
  assert.equal((out[0] as { subtype: string }).subtype, "error");
});

test("claude-code: unknown type compact_boundary → provider_event passthrough", () => {
  const out = mapClaudeJsonLineForTest({
    type: "compact_boundary",
    summary: "Compacted 200 messages",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { provider: string }).provider, "claude-code");
  assert.equal((out[0] as { kind: string }).kind, "compact_boundary");
});

test("claude-code: rate_limit → provider_event with kind", () => {
  const out = mapClaudeJsonLineForTest({
    type: "rate_limit",
    reset_at: 1234567890,
    message: "Throttled",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { kind: string }).kind, "rate_limit");
});

test("claude-code: brand-new event we've never seen → provider_event (no silent drop)", () => {
  const out = mapClaudeJsonLineForTest({
    type: "future_unknown_event_kind",
    payload: { foo: "bar" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "provider_event");
  assert.equal((out[0] as { kind: string }).kind, "future_unknown_event_kind");
});

test("claude-code: stream_event with no recognizable delta → empty", () => {
  const out = mapClaudeJsonLineForTest({
    type: "stream_event",
    event: { type: "content_block_start", index: 0 },
  });
  assert.equal(out.length, 0);
});

test("claude-code: missing type field → empty array (defensive)", () => {
  const out = mapClaudeJsonLineForTest({ no_type: "field" });
  assert.equal(out.length, 0);
});

test("claude-code: harness exposes provider + capabilities", () => {
  const h = new ClaudeCodeCliHarness();
  assert.equal(h.provider, "claude-code");
  assert.ok(h.capabilities.supports_confirmed_cancellation);
  assert.ok(h.capabilities.voice_certified);
});
