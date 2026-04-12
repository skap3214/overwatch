import { requireNativeModule } from "expo-modules-core";

interface FastRecorderNative {
  warmup(): Promise<void>;
  start(): Promise<string>;
  stop(): Promise<string | null>;
  isRecording(): boolean;
}

export default requireNativeModule<FastRecorderNative>("FastRecorder");
