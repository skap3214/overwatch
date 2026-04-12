import { useCallback, useEffect, useRef, useState } from "react";
import { AudioModule } from "expo-audio";
import FastRecorder from "@/modules/fast-recorder";

export function useRecorder() {
  const [amplitude, setAmplitude] = useState(0);
  const permissionChecked = useRef(false);
  const recording = useRef(false);

  // Warm up the recorder on mount so the first press is fast
  useEffect(() => {
    FastRecorder.warmup().catch(() => {});
  }, []);

  const ensurePermissions = useCallback(async () => {
    if (permissionChecked.current) return true;
    const status = await AudioModule.requestRecordingPermissionsAsync();
    permissionChecked.current = status.granted;
    return status.granted;
  }, []);

  const startRecording = useCallback(async () => {
    const granted = await ensurePermissions();
    if (!granted) throw new Error("Microphone permission not granted");

    setAmplitude(0);
    const t0 = Date.now();
    await FastRecorder.start();
    console.log(`[perf] FastRecorder.start: ${Date.now() - t0}ms`);
    recording.current = true;
  }, [ensurePermissions]);

  const stopRecording = useCallback(async () => {
    if (!recording.current) return null;
    recording.current = false;

    try {
      const uri = await FastRecorder.stop();
      setAmplitude(0);
      if (!uri) return null;
      return {
        fileUri: uri,
        mimeType: "audio/m4a",
      };
    } catch {
      return null;
    }
  }, []);

  return {
    isRecording: recording.current,
    amplitude,
    startRecording,
    stopRecording,
  };
}
