import { test } from "node:test";
import assert from "node:assert/strict";

import { applyConversationToggle } from "../src/services/voice-controls.js";

function makeActions() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      setConversationActive(next: boolean) {
        calls.push(`active:${next}`);
      },
      sendInterruptIntent() {
        calls.push("interrupt");
      },
      setMicEnabled(enabled: boolean) {
        calls.push(`mic:${enabled}`);
      },
      setTurnState(state: "idle" | "recording" | "preparing") {
        calls.push(`turn:${state}`);
      },
    },
  };
}

test("conversation toggle on interrupts stale audio and leaves PTT idle", () => {
  const { calls, actions } = makeActions();

  applyConversationToggle(true, actions);

  assert.deepEqual(calls, [
    "active:true",
    "interrupt",
    "mic:true",
    "turn:idle",
  ]);
});

test("conversation toggle off interrupts bot audio before releasing mic", () => {
  const { calls, actions } = makeActions();

  applyConversationToggle(false, actions);

  assert.deepEqual(calls, [
    "active:false",
    "interrupt",
    "mic:false",
    "turn:idle",
  ]);
});
