import { useEffect } from "react";
import { realtimeClient } from "../services/realtime";
import { useConnectionStore } from "../stores/connection-store";
import { useTurnStore } from "../stores/turn-store";
import { useNotificationsStore } from "../stores/notifications-store";
import { useAudioPlayer } from "./use-audio-player";
import type { NotificationEvent, WsEnvelope } from "../types";

// Shared ref so other hooks can reset audio state on cancel/interrupt
export const audioActiveRef = { current: false };

// Generation counter — incremented on every cancel or new turn initiation.
// Events from a stale generation are silently dropped.
export let turnGeneration = 0;
export function bumpGeneration(): number {
  return ++turnGeneration;
}

export function useRealtimeConnection() {
  const backendURL = useConnectionStore((s) => s.backendURL);
  const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
  const player = useAudioPlayer();

  useEffect(() => {
    // The generation that the current foreground turn was started under.
    // Set when turn.started arrives; all subsequent events for that turn
    // are dropped if turnGeneration has moved past this value.
    let fgGen = turnGeneration;
    let bgGen = -1; // background turns get their own tracking

    const isFgStale = () => fgGen !== turnGeneration;
    const isBgStale = () => bgGen !== turnGeneration;

    realtimeClient.setHandlers({
      onStatus: (status) => {
        setConnectionStatus(status);
      },
      onEnvelope: (envelope: WsEnvelope) => {
        switch (envelope.type) {
          // ── Notifications (never stale) ──────────────────────────
          case "notification.snapshot": {
            const notifications = (
              envelope.payload as { notifications: NotificationEvent[] }
            ).notifications;
            notifications.forEach((notification) =>
              useNotificationsStore.getState().upsertNotification(notification)
            );
            break;
          }
          case "notification.created":
          case "notification.updated": {
            const notification = envelope.payload as NotificationEvent;
            useNotificationsStore.getState().upsertNotification(notification);
            break;
          }

          // ── Foreground turn events ───────────────────────────────
          case "turn.started":
            // Lock this turn to the current generation
            fgGen = turnGeneration;
            audioActiveRef.current = false;
            useTurnStore.getState().setTurnState("processing");
            break;
          case "turn.text_delta":
            if (isFgStale()) break;
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "turn.assistant_message":
            break;
          case "turn.tool_call":
            if (isFgStale()) break;
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "turn.audio_chunk": {
            if (isFgStale()) break;
            const currentState = useTurnStore.getState().turnState;
            if (currentState === "recording" || currentState === "preparing") break;
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          }
          case "turn.tts_error":
            break;
          case "turn.error":
            if (isFgStale()) break;
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "turn.done":
            if (isFgStale()) break;
            if (audioActiveRef.current) {
              player.markEnd();
            }
            audioActiveRef.current = false;
            useTurnStore.getState().handleDone();
            break;

          // ── Relay mode: voice transcript from CLI bridge ─────────
          case "voice.transcript": {
            if (isFgStale()) break;
            const text = (envelope.payload as { text: string }).text;
            useTurnStore.getState().addUserMessage(text);
            realtimeClient.startTextTurn(text);
            break;
          }
          case "voice.error": {
            if (isFgStale()) break;
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            break;
          }

          // ── Background turn events ──────────────────────────────
          case "background.turn_started":
            bgGen = turnGeneration;
            audioActiveRef.current = false;
            useTurnStore
              .getState()
              .addUserMessage(
                `[Scheduled] ${
                  (envelope.payload as { summary?: string; prompt?: string }).summary ||
                  (envelope.payload as { prompt?: string }).prompt ||
                  "Background check"
                }`
              );
            useTurnStore.getState().setTurnState("processing");
            break;
          case "background.turn_text_delta":
            if (isBgStale()) break;
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "background.turn_tool_call":
            if (isBgStale()) break;
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "background.turn_audio_chunk": {
            if (isBgStale()) break;
            const bgState = useTurnStore.getState().turnState;
            if (bgState === "recording" || bgState === "preparing") break;
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          }
          case "background.turn_tts_error":
            break;
          case "background.turn_error":
            if (isBgStale()) break;
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "background.turn_done":
            if (isBgStale()) break;
            if (audioActiveRef.current) {
              player.markEnd();
            }
            audioActiveRef.current = false;
            useTurnStore.getState().handleDone();
            break;
          default:
            break;
        }
      },
    });
  }, [setConnectionStatus, player]);

  useEffect(() => {
    if (!backendURL) {
      realtimeClient.disconnect();
      return;
    }
    // Relay mode — QR scan already called connectViaRelay, don't interfere
    if (backendURL.startsWith("relay:") || backendURL.includes("(relay:")) {
      // No cleanup — don't disconnect a relay connection on re-render
      return;
    }
    realtimeClient.connect(backendURL);
    return () => {
      // Only disconnect if we're the ones who connected (direct mode)
      if (realtimeClient.mode === "direct") {
        realtimeClient.disconnect();
      }
    };
  }, [backendURL]);
}
