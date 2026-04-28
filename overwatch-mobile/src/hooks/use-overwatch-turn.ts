import { useCallback } from "react";
import { useTurnStore } from "../stores/turn-store";
import { useConnectionStore } from "../stores/connection-store";
import { useAudioPlayer } from "./use-audio-player";
import { audioActiveRef, bumpGeneration } from "./use-realtime-connection";
import { transcribeAudio } from "../services/api";
import { realtimeClient } from "../services/realtime";
import { useThemeStore } from "../stores/theme-store";

export function useOverwatchTurn() {
  const { connectionStatus } = useConnectionStore();
  const store = useTurnStore();
  const player = useAudioPlayer();

  // Stop audio playback only — does NOT cancel the backend turn.
  // Used when the user taps mic to record (we mute TTS but let the LLM finish).
  const stopAudio = useCallback(() => {
    player.stopAndReset();
    audioActiveRef.current = false;
    bumpGeneration();
  }, [player]);

  // Full cancel — stops audio AND aborts the backend turn.
  // Used when actually sending a new message (text or voice).
  const cancel = useCallback(() => {
    stopAudio();
    realtimeClient.cancelTurn();
    store.cancelTurn();
  }, [stopAudio, store]);

  const sendText = useCallback(
    (text: string) => {
      if (store.turnState !== "idle") {
        cancel();
      }

      store.addUserMessage(text);
      store.setTurnState("processing");
      store.setAbortController(null);
      const tts = useThemeStore.getState().ttsEnabled;
      if (!realtimeClient.startTextTurn(text, { tts })) {
        store.handleError("Not connected — waiting for reconnection");
        return;
      }
    },
    [connectionStatus, store, cancel]
  );

  const sendVoice = useCallback(
    async (audioUri: string, mimeType: string) => {
      // Cancel any in-progress turn
      if (store.turnState !== "idle") {
        cancel();
      }

      store.setTurnState("processing");

      const deepgramApiKey = useConnectionStore.getState().deepgramApiKey;

      if (deepgramApiKey) {
        // Client-side STT: call Deepgram directly, then send text turn
        const abortController = new AbortController();
        store.setAbortController(abortController);
        try {
          const transcript = await transcribeAudio(
            audioUri,
            mimeType,
            deepgramApiKey,
            abortController.signal
          );
          if (abortController.signal.aborted) return;
          store.addUserMessage(transcript);
          store.setAbortController(null);
          const tts = useThemeStore.getState().ttsEnabled;
          if (!realtimeClient.startTextTurn(transcript, { tts })) {
            store.handleError("Not connected — waiting for reconnection");
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            const isNoSpeech = err instanceof Error && err.message === "No speech detected";
            // Bump generation so old turn's audio stays suppressed
            bumpGeneration();
            if (isNoSpeech) {
              // Silent failure — just go back to idle, don't show error
              store.cancelTurn();
            } else {
              const message =
                err instanceof Error ? err.message : "Voice transcription failed";
              store.handleError(message);
            }
            store.setAbortController(null);
          }
        }
      } else if (realtimeClient.mode === "relay") {
        // Fallback: send audio through relay for bridge-side STT
        try {
          const response = await fetch(audioUri);
          const blob = await response.blob();
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
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
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to read audio";
          store.handleError(message);
        }
      }
    },
    [connectionStatus, store, cancel]
  );

  return { sendText, sendVoice, cancel, stopAudio };
}
