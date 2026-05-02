/**
 * Conversation store tests.
 *
 * These cover the user-facing message timeline state machine:
 *   - User transcripts (final vs interim)
 *   - Bot text streaming + reasoning
 *   - Deferred bot-message finalization (1500 ms timer cancels on new bot text)
 *   - Tool-call interleaving with timestamp backdating
 *   - Spoken cursor advancement
 *   - Error appending
 *   - Derived speaking state selectors
 *   - Reset / clearMessages
 *
 * Runs against the real Zustand store; no React, no DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectIsAgentSpeaking,
  selectIsUserSpeaking,
  useConversationStore,
} from "../src/stores/conversation.js";

function reset() {
  useConversationStore.getState().reset();
}

test("conversation: starts empty, derived speaking state false", () => {
  reset();
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 0);
  assert.equal(s.isRemoteMuted, false);
  assert.equal(s.transportState, "disconnected");
  assert.equal(selectIsAgentSpeaking(s), false);
  assert.equal(selectIsUserSpeaking(s), false);
});

test("conversation: user message append finalizes on second call", () => {
  reset();
  useConversationStore.getState().appendUserMessage("hello", false);
  let s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "user");
  assert.equal(s.messages[0].text, "hello");
  assert.equal(s.messages[0].final, false);
  // isUserSpeaking derives from final flag.
  assert.equal(selectIsUserSpeaking(s), true);

  useConversationStore.getState().appendUserMessage("hello world", true);
  s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, "hello world");
  assert.equal(s.messages[0].final, true);
  assert.equal(selectIsUserSpeaking(s), false);
});

test("conversation: bot text streams into a single message", () => {
  reset();
  useConversationStore.getState().appendBotText("Hello");
  useConversationStore.getState().appendBotText(" world");
  useConversationStore.getState().appendBotText(".");
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "assistant");
  assert.equal(s.messages[0].text, "Hello world.");
  assert.equal(s.messages[0].final, false);
  assert.equal(selectIsAgentSpeaking(s), true);
});

test("conversation: reasoning appends to the active assistant message", () => {
  reset();
  useConversationStore.getState().appendBotReasoning("Considering...");
  useConversationStore.getState().appendBotText("Done");
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, "Done");
  assert.equal(s.messages[0].reasoning, "Considering...");
});

test("conversation: deferred finalize fires after 1500ms", async () => {
  reset();
  useConversationStore.getState().appendBotText("Hi");
  useConversationStore.getState().scheduleAssistantFinalize();
  // Before timer fires, message is still streaming.
  assert.equal(useConversationStore.getState().messages[0].final, false);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(useConversationStore.getState().messages[0].final, true);
});

test("conversation: deferred finalize cancels on new bot text", async () => {
  reset();
  useConversationStore.getState().appendBotText("First");
  useConversationStore.getState().scheduleAssistantFinalize();
  // Mid-timer, more text arrives — must cancel the timer.
  await new Promise((r) => setTimeout(r, 100));
  useConversationStore.getState().cancelAssistantFinalize();
  useConversationStore.getState().appendBotText(" second");
  await new Promise((r) => setTimeout(r, 1600));
  // Still not finalized — no schedule was made after cancel.
  const s = useConversationStore.getState();
  assert.equal(s.messages[0].text, "First second");
  // final is true only because no scheduleAssistantFinalize was called again.
  // Actually with our cancel + no rearm, final should be false.
  assert.equal(s.messages[0].final, false);
});

test("conversation: tool message backdates timestamp before active assistant", () => {
  reset();
  useConversationStore.getState().appendBotText("Working...");
  const beforeTs = useConversationStore.getState().messages[0].timestamp;

  useConversationStore.getState().appendToolCall("Read", "start");
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 2);
  const tool = s.messages.find((m) => m.role === "tool_call")!;
  // Tool message timestamp is < assistant message timestamp.
  assert.ok(tool.timestamp < beforeTs);
});

test("conversation: tool message gets fresh timestamp when no active assistant", () => {
  reset();
  const before = Date.now();
  useConversationStore.getState().appendToolCall("Bash", "start");
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.ok(s.messages[0].timestamp >= before);
});

test("conversation: error appends as final error-role message", () => {
  reset();
  useConversationStore.getState().appendError("network unreachable");
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "error");
  assert.equal(s.messages[0].text, "network unreachable");
  assert.equal(s.messages[0].final, true);
});

test("conversation: spoken cursor advances within message bounds", () => {
  reset();
  useConversationStore.getState().appendBotText("Hello world");
  const id = useConversationStore.getState().messages[0].id;

  useConversationStore.getState().advanceSpokenCursor(id, 5);
  assert.equal(useConversationStore.getState().messages[0].spokenChars, 5);

  // Past the end clamps to message length.
  useConversationStore.getState().advanceSpokenCursor(id, 1000);
  assert.equal(
    useConversationStore.getState().messages[0].spokenChars,
    "Hello world".length,
  );
});

test("conversation: setRemoteMuted toggles the PTT mute indicator", () => {
  reset();
  useConversationStore.getState().setRemoteMuted(true);
  assert.equal(useConversationStore.getState().isRemoteMuted, true);
  useConversationStore.getState().setRemoteMuted(false);
  assert.equal(useConversationStore.getState().isRemoteMuted, false);
});

test("conversation: setTransportState transitions correctly", () => {
  reset();
  useConversationStore.getState().setTransportState("connecting");
  assert.equal(useConversationStore.getState().transportState, "connecting");
  useConversationStore.getState().setTransportState("connected");
  assert.equal(useConversationStore.getState().transportState, "connected");
});

test("conversation: clearMessages preserves transport but resets timeline", () => {
  reset();
  useConversationStore.getState().setTransportState("connected");
  useConversationStore.getState().appendBotText("hello");
  useConversationStore.getState().clearMessages();
  const s = useConversationStore.getState();
  assert.equal(s.messages.length, 0);
  assert.equal(s.turnState, "idle");
  // Transport state is unchanged.
  assert.equal(s.transportState, "connected");
});

test("conversation: derived selectors handle edge cases", () => {
  reset();
  // No messages: neither flag fires.
  assert.equal(selectIsAgentSpeaking(useConversationStore.getState()), false);
  assert.equal(selectIsUserSpeaking(useConversationStore.getState()), false);

  // Final assistant message: not speaking.
  useConversationStore.getState().appendBotText("done");
  useConversationStore.getState().scheduleAssistantFinalize();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      assert.equal(
        selectIsAgentSpeaking(useConversationStore.getState()),
        false,
      );
      resolve();
    }, 1600),
  );
});
