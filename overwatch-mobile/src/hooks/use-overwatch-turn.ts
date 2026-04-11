import { useCallback } from "react";
import { useTurnStore } from "../stores/turn-store";
import { useConnectionStore } from "../stores/connection-store";
import { useAudioPlayer } from "./use-audio-player";
import { transcribeAudio } from "../services/api";
import { realtimeClient } from "../services/realtime";

export function useOverwatchTurn() {
  const { backendURL, connectionStatus } = useConnectionStore();
  const store = useTurnStore();
  const player = useAudioPlayer();

  const sendText = useCallback(
    (text: string) => {

      // Cancel any in-progress turn (interruption)
      if (store.turnState !== "idle") {
        store.abortController?.abort();
        player.stopAndReset();
      }

      store.addUserMessage(text);
      store.setTurnState("processing");
      store.setAbortController(null);
      if (!realtimeClient.startTextTurn(text)) {
        store.handleError("Not connected — waiting for reconnection");
        return;
      }
    },
    [connectionStatus, store, player]
  );

  const sendVoice = useCallback(
    async (audioUri: string, mimeType: string) => {

      // Cancel any in-progress turn (interruption)
      if (store.abortController) {
        store.abortController.abort();
        player.stopAndReset();
      }

      store.setTurnState("processing");

      if (realtimeClient.mode === "relay") {
        // Relay mode: send audio over WebSocket, CLI bridge handles STT
        try {
          // Read audio file as base64 via fetch + blob
          const response = await fetch(audioUri);
          const blob = await response.blob();
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              // Strip "data:...;base64," prefix
              const b64 = dataUrl.split(",")[1] ?? "";
              resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          if (!realtimeClient.sendVoiceAudio(base64, mimeType)) {
            store.handleError("Not connected — waiting for reconnection");
            return;
          }
          // The CLI bridge will send back voice.transcript, which the
          // useRealtimeConnection hook handles
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to read audio";
          store.handleError(message);
        }
      } else {
        // Direct mode: HTTP STT then WebSocket turn
        if (!backendURL) return;
        const abortController = new AbortController();
        store.setAbortController(abortController);
        try {
          const transcript = await transcribeAudio(
            backendURL,
            audioUri,
            mimeType,
            abortController.signal
          );
          if (abortController.signal.aborted) return;
          store.addUserMessage(transcript);
          store.setAbortController(null);
          realtimeClient.startTextTurn(transcript);
        } catch (err) {
          if (!abortController.signal.aborted) {
            const message =
              err instanceof Error ? err.message : "Voice transcription failed";
            store.handleError(message);
            store.setAbortController(null);
          }
        }
      }
    },
    [backendURL, connectionStatus, store, player]
  );

  const cancel = useCallback(() => {
    player.stopAndReset();
    store.cancelTurn();
  }, [player, store]);

  return { sendText, sendVoice, cancel };
}
