import { requireNativeModule, type EventSubscription } from "expo-modules-core";

import type {
  SessionConfig,
  NowPlayingMetadata,
  StreamingAudioEvents,
} from "./StreamingAudioModule.types";

type StreamingAudioNativeModule = {
  startSession(config: SessionConfig): void;
  endSession(): void;

  feedPCM(pcmData: Uint8Array): void;
  playFile(uri: string): void;
  markEndOfStream(): void;

  play(): void;
  pause(): void;
  flushAndReset(): void;
  setRate(rate: number): void;

  updateNowPlaying(meta: NowPlayingMetadata): void;

  addListener<K extends keyof StreamingAudioEvents>(
    eventName: K,
    listener: StreamingAudioEvents[K],
  ): EventSubscription;

  removeAllListeners(eventName: keyof StreamingAudioEvents): void;
};

export default requireNativeModule<StreamingAudioNativeModule>(
  "StreamingAudio",
);
