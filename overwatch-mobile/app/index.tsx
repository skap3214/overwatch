import React, { useEffect, useRef, useCallback, useState } from "react";
import { View, Text, KeyboardAvoidingView, Platform, Keyboard, Pressable, Modal } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { setAudioModeAsync } from "expo-audio";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useConnectionStore } from "../src/stores/connection-store";
import { useThemeStore } from "../src/stores/theme-store";
import { useOverwatchTurn } from "../src/hooks/use-overwatch-turn";
import { useTurnStore } from "../src/stores/turn-store";
import { useRecorder } from "../src/hooks/use-audio-recorder";
import { useColors } from "../src/theme";
import { StatusBar as OverwatchStatusBar } from "../src/components/StatusBar";
import { NotificationsBanner } from "../src/components/NotificationsBanner";
import { TranscriptView } from "../src/components/TranscriptView";
import { InputBar } from "../src/components/InputBar";
import { PTTButton } from "../src/components/PTTButton";
import { SettingsPage } from "../src/components/SettingsPage";
import { useRealtimeConnection } from "../src/hooks/use-realtime-connection";
import "../global.css";

export default function App() {
  const colors = useColors();
  const { loadBackendURL, connectionStatus } = useConnectionStore();
  const { sendText, sendVoice, cancel } = useOverwatchTurn();
  const { amplitude, startRecording, stopRecording } = useRecorder();
  useRealtimeConnection();

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardWillShow", () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener("keyboardWillHide", () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const [fontsLoaded] = useFonts({
    "IosevkaAile-Regular": require("../assets/fonts/IosevkaAile-Regular.ttf"),
    "IosevkaAile-Bold": require("../assets/fonts/IosevkaAile-Bold.ttf"),
    "IosevkaAile-Medium": require("../assets/fonts/IosevkaAile-Medium.ttf"),
  });

  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      shouldPlayInBackground: false,
      playsInSilentMode: true,
      shouldRouteThroughEarpiece: false,
    });
    loadBackendURL();
    useThemeStore.getState().loadMode();
  }, []);

  const goToSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);

  const handleNewChat = useCallback(() => {
    useTurnStore.getState().clearMessages();
  }, []);

  const handleTextSubmit = useCallback((text: string) => { sendText(text); }, [sendText]);

  const handleStartRecording = useCallback(async () => {
    try {
      useTurnStore.getState().setTurnState("recording");
      await startRecording();
    } catch (err) {
      console.error("startRecording failed:", err);
      useTurnStore.getState().setTurnState("idle");
    }
  }, [startRecording]);

  const stoppingRef = useRef(false);
  const handleStopRecording = useCallback(async () => {
    if (useTurnStore.getState().turnState !== "recording") return;
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    useTurnStore.getState().setTurnState("processing");
    try {
      const result = await stopRecording();
      if (result?.fileUri) {
        sendVoice(result.fileUri, result.mimeType ?? "audio/m4a");
      } else {
        useTurnStore.getState().setTurnState("idle");
      }
    } catch (err) {
      console.error("stopRecording failed:", err);
      useTurnStore.getState().setTurnState("idle");
    } finally {
      stoppingRef.current = false;
    }
  }, [stopRecording, sendVoice]);

  const handleStopPlayback = useCallback(() => { cancel(); }, [cancel]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={useThemeStore.getState().isDark() ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={{ height: Platform.OS === "ios" ? 54 : 30 }} />

        <OverwatchStatusBar
          onSettingsPress={goToSettings}
          onNewChat={handleNewChat}
        />

        {connectionStatus === "connected" ? (
          <>
            <NotificationsBanner />

            <TranscriptView />

            <View
              style={{
                flexDirection: useThemeStore.getState().hand === "left" ? "row-reverse" : "row",
                alignItems: "center",
                paddingHorizontal: 28,
                paddingTop: 6,
                paddingBottom: keyboardVisible ? 6 : 36,
                gap: 8,
                backgroundColor: colors.bg,
              }}
            >
              <View style={{ flex: 1 }}>
                <InputBar onSubmit={handleTextSubmit} />
              </View>
              <PTTButton
                onStartRecording={handleStartRecording}
                onStopRecording={handleStopRecording}
                onStopPlayback={handleStopPlayback}
                amplitude={amplitude}
              />
            </View>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 40 }}>
            <Text style={{ color: colors.textDim, fontFamily: "IosevkaAile-Regular", fontSize: 15, textAlign: "center" }}>
              {connectionStatus === "reconnecting" ? "Reconnecting to your Mac..." : connectionStatus === "connecting" ? "Connecting..." : "Not connected"}
            </Text>
            <Pressable
              onPress={goToSettings}
              style={{
                backgroundColor: colors.accent,
                paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12,
              }}
            >
              <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>
                {connectionStatus === "disconnected" ? "Connect" : "Settings"}
              </Text>
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Settings Modal */}
      <Modal visible={showSettings} animationType="slide">
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ height: Platform.OS === "ios" ? 54 : 30 }} />
          <SettingsPage onClose={closeSettings} />
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}
