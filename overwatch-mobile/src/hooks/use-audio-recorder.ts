import { useCallback, useRef, useState } from "react";
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
} from "expo-audio";

export function useRecorder() {
  const [amplitude, setAmplitude] = useState(0);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const permissionChecked = useRef(false);

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
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
  }, [audioRecorder, ensurePermissions]);

  const stopRecording = useCallback(async () => {
    try {
      await audioRecorder.stop();
    } catch {
      return null;
    }
    const uri = audioRecorder.uri;
    setAmplitude(0);

    if (!uri) return null;
    return {
      fileUri: uri,
      mimeType: "audio/m4a",
    };
  }, [audioRecorder]);

  return {
    isRecording: audioRecorder.isRecording,
    amplitude,
    startRecording,
    stopRecording,
  };
}
