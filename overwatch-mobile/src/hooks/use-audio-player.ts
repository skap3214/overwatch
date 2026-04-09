import { useCallback, useRef } from "react";
import StreamingAudio from "@/modules/streaming-audio";
import { useAudioStore } from "../stores/audio-store";
import { Buffer } from "buffer";

export function useAudioPlayer() {
  const sessionRef = useRef(false);
  const { setIsPlaying, setSessionActive } = useAudioStore();

  const startSession = useCallback(() => {
    // End any previous session before starting a new one
    if (sessionRef.current) {
      StreamingAudio.flushAndReset();
      StreamingAudio.endSession();
    }
    StreamingAudio.startSession({ sampleRate: 24000, channels: 1 });
    sessionRef.current = true;
    setSessionActive(true);
    setIsPlaying(true);
  }, [setSessionActive, setIsPlaying]);

  const feedChunk = useCallback((base64: string) => {
    if (!sessionRef.current) return;
    const bytes = Buffer.from(base64, "base64");
    StreamingAudio.feedPCM(new Uint8Array(bytes));
  }, []);

  const markEnd = useCallback(() => {
    if (!sessionRef.current) return;
    StreamingAudio.markEndOfStream();
    // Don't end session here — wait for onChunkFinished or next startSession
    setIsPlaying(false);
  }, [setIsPlaying]);

  const stopAndReset = useCallback(() => {
    if (!sessionRef.current) return;
    StreamingAudio.flushAndReset();
    StreamingAudio.endSession();
    sessionRef.current = false;
    setIsPlaying(false);
    setSessionActive(false);
  }, [setIsPlaying, setSessionActive]);

  return { startSession, feedChunk, markEnd, stopAndReset };
}
