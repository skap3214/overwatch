import type { TurnState } from "../types";

type MaybePromise = void | Promise<void>;

export interface ConversationToggleActions {
  setConversationActive(next: boolean): void;
  sendInterruptIntent(): MaybePromise;
  setMicEnabled(enabled: boolean): MaybePromise;
  setTurnState(state: TurnState): void;
}

export function applyConversationToggle(
  next: boolean,
  actions: ConversationToggleActions,
): void {
  actions.setConversationActive(next);
  void actions.sendInterruptIntent();
  void actions.setMicEnabled(next);
  // Conversation mode owns the mic, but PTTButton uses turnState for its own
  // press/drag visuals. Keep PTT idle so tapping the voice button does not
  // make both buttons look active.
  actions.setTurnState("idle");
}
