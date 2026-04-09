import { useCallback } from "react";
import { useTurnStore } from "../stores/turn-store";
import { useConnectionStore } from "../stores/connection-store";
import { useAudioPlayer } from "./use-audio-player";
import { textTurn, voiceTurn } from "../services/api";
import type { SSEEvent } from "../types";

export function useOverwatchTurn() {
  const { backendURL } = useConnectionStore();
  const store = useTurnStore();
  const player = useAudioPlayer();

  const handleEvents = useCallback(
    (abortController: AbortController) => {
      let audioStarted = false;

      const onEvent = (event: SSEEvent) => {
        if (abortController.signal.aborted) return;

        switch (event.type) {
          case "transcript":
            store.addUserMessage(event.data.text);
            break;
          case "text_delta":
            store.handleTextDelta(event.data.text);
            break;
          case "tool_call":
            store.handleToolCall(event.data.name);
            break;
          case "audio_chunk":
            if (!audioStarted) {
              player.startSession();
              store.setTurnState("playing");
              audioStarted = true;
            }
            player.feedChunk(event.data.base64);
            break;
          case "tts_error":
            break;
          case "error":
            store.handleError(event.data.message);
            if (audioStarted) player.stopAndReset();
            break;
          case "done":
            if (audioStarted) player.markEnd();
            store.handleDone();
            break;
        }
      };

      const onDone = () => {
        if (audioStarted) player.markEnd();
        store.handleDone();
        store.setAbortController(null);
      };

      const onError = (err: Error) => {
        if (err.name !== "AbortError" && err.message !== "Network error") {
          store.handleError(err.message || "Connection error");
        }
        if (audioStarted) player.stopAndReset();
        store.setAbortController(null);
      };

      return { onEvent, onDone, onError };
    },
    [store, player]
  );

  const sendText = useCallback(
    (text: string) => {
      if (!backendURL) return;

      // Cancel any in-progress turn (interruption)
      if (store.turnState !== "idle") {
        store.abortController?.abort();
        player.stopAndReset();
      }

      const abortController = new AbortController();
      store.setAbortController(abortController);
      store.addUserMessage(text);
      store.setTurnState("processing");

      const { onEvent, onDone, onError } = handleEvents(abortController);
      textTurn(backendURL, text, abortController.signal, onEvent, onDone, onError);
    },
    [backendURL, store, handleEvents]
  );

  const sendVoice = useCallback(
    (audioUri: string, mimeType: string) => {
      if (!backendURL) return;

      // Cancel any in-progress turn (interruption)
      if (store.abortController) {
        store.abortController.abort();
        player.stopAndReset();
      }

      const abortController = new AbortController();
      store.setAbortController(abortController);
      store.setTurnState("processing");

      const { onEvent, onDone, onError } = handleEvents(abortController);
      voiceTurn(backendURL, audioUri, mimeType, abortController.signal, onEvent, onDone, onError);
    },
    [backendURL, store, handleEvents]
  );

  const cancel = useCallback(() => {
    player.stopAndReset();
    store.cancelTurn();
  }, [player, store]);

  return { sendText, sendVoice, cancel };
}
