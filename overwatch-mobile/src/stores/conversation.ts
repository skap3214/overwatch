/**
 * Single conversation store — replaces audio-store + turn-store + ad-hoc refs
 * scattered across legacy hooks. Driven by RTVI events from the PipecatClient
 * (see src/hooks/use-pipecat-session.ts).
 *
 * Message shape intentionally mirrors `src/types.ts` Message so existing
 * components (TranscriptView, ReasoningBlock, SessionsPanel) keep working
 * without an adapter layer.
 *
 * Design:
 * - `isAgentSpeaking` and `isUserSpeaking` are DERIVED from the active
 *   message's `final` flag, never stored directly.
 * - Tool-call lifecycle, transcript, errors, and harness server-messages all
 *   live in one chronological timeline.
 */

import { create } from "zustand";
import type { Message, MessageRole, TurnState } from "../types";

interface InternalMessage extends Message {
  /** False while still streaming. Drives the derived isAgentSpeaking flag. */
  final: boolean;
  /** Char cursor advanced by bot-tts events for the spoken/unspoken split. */
  spokenChars: number;
}

export interface ConversationState {
  messages: InternalMessage[];
  isRemoteMuted: boolean;
  isPTTMode: boolean; // false = always-listening
  transportState: "disconnected" | "connecting" | "connected";
  /** Mirrors legacy turn-store turnState shape so PTTButton can keep its UI logic. */
  turnState: TurnState;
  // Internal: tracks the deferred-finalization timer id per message.
  finalizeTimerByMessageId: Record<string, ReturnType<typeof setTimeout>>;
}

export interface ConversationActions {
  appendUserMessage(text: string, final: boolean): void;
  appendBotText(text: string): void;
  appendBotReasoning(text: string): void;
  /**
   * Schedule the active assistant message to finalize after a 1500 ms delay.
   * Cleared if `bot-tts-started` fires again before the timer expires.
   * Prevents split-bubble UI on TTS pauses.
   */
  scheduleAssistantFinalize(): void;
  cancelAssistantFinalize(): void;
  appendToolCall(name: string, _phase?: "start" | "complete"): void;
  appendError(text: string): void;
  advanceSpokenCursor(messageId: string, chars: number): void;
  setRemoteMuted(muted: boolean): void;
  setPTTMode(ptt: boolean): void;
  setTransportState(s: ConversationState["transportState"]): void;
  setTurnState(s: TurnState): void;
  clearMessages(): void;
  reset(): void;
}

const FINALIZE_DELAY_MS = 1500;

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newMessage(role: MessageRole, text: string, final: boolean): InternalMessage {
  return {
    id: newId(role),
    role,
    text,
    final,
    timestamp: Date.now(),
    spokenChars: 0,
  };
}

export const useConversationStore = create<
  ConversationState & ConversationActions
>((set, get) => ({
  messages: [],
  isRemoteMuted: false,
  isPTTMode: false,
  transportState: "disconnected",
  turnState: "idle",
  finalizeTimerByMessageId: {},

  appendUserMessage(text, final) {
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === "user" && !last.final) {
        const updated = [...state.messages];
        updated[updated.length - 1] = { ...last, text, final };
        return { messages: updated };
      }
      return {
        messages: [...state.messages, newMessage("user", text, final)],
      };
    });
  },

  appendBotText(text) {
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === "assistant" && !last.final) {
        const updated = [...state.messages];
        updated[updated.length - 1] = { ...last, text: last.text + text };
        return { messages: updated };
      }
      return {
        messages: [...state.messages, newMessage("assistant", text, false)],
      };
    });
  },

  appendBotReasoning(text) {
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === "assistant" && !last.final) {
        const updated = [...state.messages];
        updated[updated.length - 1] = {
          ...last,
          reasoning: (last.reasoning ?? "") + text,
        };
        return { messages: updated };
      }
      const fresh = newMessage("assistant", "", false);
      fresh.reasoning = text;
      return { messages: [...state.messages, fresh] };
    });
  },

  scheduleAssistantFinalize() {
    const last = get().messages[get().messages.length - 1];
    if (!last || last.role !== "assistant" || last.final) return;
    get().cancelAssistantFinalize();
    const targetId = last.id;
    const timer = setTimeout(() => {
      set((state) => {
        const idx = state.messages.findIndex((m) => m.id === targetId);
        if (idx < 0) return state;
        const updated = [...state.messages];
        updated[idx] = { ...updated[idx], final: true };
        const remaining = { ...state.finalizeTimerByMessageId };
        delete remaining[targetId];
        return {
          messages: updated,
          finalizeTimerByMessageId: remaining,
        };
      });
    }, FINALIZE_DELAY_MS);
    set((state) => ({
      finalizeTimerByMessageId: {
        ...state.finalizeTimerByMessageId,
        [targetId]: timer,
      },
    }));
  },

  cancelAssistantFinalize() {
    const last = get().messages[get().messages.length - 1];
    if (!last) return;
    const timer = get().finalizeTimerByMessageId[last.id];
    if (timer) {
      clearTimeout(timer);
      set((state) => {
        const remaining = { ...state.finalizeTimerByMessageId };
        delete remaining[last.id];
        return { finalizeTimerByMessageId: remaining };
      });
    }
  },

  appendToolCall(name) {
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      // Backdate by 1ms so the tool call sorts before the active assistant bubble.
      const ts =
        last && last.role === "assistant" && !last.final
          ? last.timestamp - 1
          : Date.now();
      return {
        messages: [
          ...state.messages,
          {
            id: newId("tool"),
            role: "tool_call",
            text: name,
            final: true,
            timestamp: ts,
            spokenChars: 0,
          },
        ],
      };
    });
  },

  appendError(text) {
    set((state) => ({
      messages: [...state.messages, newMessage("error", text, true)],
    }));
  },

  advanceSpokenCursor(messageId, chars) {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return state;
      const updated = [...state.messages];
      updated[idx] = {
        ...updated[idx],
        spokenChars: Math.min(updated[idx].text.length, chars),
      };
      return { messages: updated };
    });
  },

  setRemoteMuted(muted) {
    set({ isRemoteMuted: muted });
  },

  setPTTMode(ptt) {
    set({ isPTTMode: ptt });
  },

  setTransportState(s) {
    set({ transportState: s });
  },

  setTurnState(s) {
    set({ turnState: s });
  },

  clearMessages() {
    set({ messages: [], turnState: "idle" });
  },

  reset() {
    set({
      messages: [],
      isRemoteMuted: false,
      transportState: "disconnected",
      turnState: "idle",
      finalizeTimerByMessageId: {},
    });
  },
}));

// Derived selectors — keep speaking state outside the store, computed from messages.
export function selectIsAgentSpeaking(state: ConversationState): boolean {
  const last = state.messages[state.messages.length - 1];
  return Boolean(last && last.role === "assistant" && !last.final);
}

export function selectIsUserSpeaking(state: ConversationState): boolean {
  const last = state.messages[state.messages.length - 1];
  return Boolean(last && last.role === "user" && !last.final);
}
