import { useEffect, useRef } from "react";
import { realtimeClient } from "../services/realtime";
import { useConnectionStore } from "../stores/connection-store";
import { useTurnStore } from "../stores/turn-store";
import { useNotificationsStore } from "../stores/notifications-store";
import { useAudioPlayer } from "./use-audio-player";
import type { NotificationEvent, WsEnvelope } from "../types";

export function useRealtimeConnection() {
  const backendURL = useConnectionStore((s) => s.backendURL);
  const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
  const player = useAudioPlayer();
  const audioActiveRef = useRef(false);

  useEffect(() => {
    realtimeClient.setHandlers({
      onStatus: (status) => {
        setConnectionStatus(status === "connected" ? "connected" : status === "error" ? "error" : "disconnected");
      },
      onEnvelope: (envelope: WsEnvelope) => {
        switch (envelope.type) {
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
          case "turn.started":
            audioActiveRef.current = false;
            useTurnStore.getState().setTurnState("processing");
            break;
          case "turn.text_delta":
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "turn.assistant_message":
            break;
          case "turn.tool_call":
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "turn.audio_chunk":
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          case "turn.tts_error":
            break;
          case "turn.error":
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "turn.done":
            if (audioActiveRef.current) {
              player.markEnd();
            }
            audioActiveRef.current = false;
            useTurnStore.getState().handleDone();
            break;
          // Relay mode: voice transcript from CLI bridge
          case "voice.transcript": {
            const text = (envelope.payload as { text: string }).text;
            useTurnStore.getState().addUserMessage(text);
            realtimeClient.startTextTurn(text);
            break;
          }
          case "voice.error": {
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            break;
          }
          case "background.turn_started":
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
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "background.turn_tool_call":
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "background.turn_audio_chunk":
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          case "background.turn_tts_error":
            break;
          case "background.turn_error":
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "background.turn_done":
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
