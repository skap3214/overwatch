import React, { useEffect, useRef, useCallback, useState } from "react";
import { View, Text, KeyboardAvoidingView, Platform, Keyboard, Pressable, Modal } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { setAudioModeAsync } from "expo-audio";
import * as Haptics from "expo-haptics";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import { useConnectionStore } from "../src/stores/connection-store";
import { useThemeStore } from "../src/stores/theme-store";
import { useOverwatchTurn } from "../src/hooks/use-overwatch-turn";
import { useTurnStore } from "../src/stores/turn-store";
import { useRecorder } from "../src/hooks/use-audio-recorder";
import { useColors } from "../src/theme";
import { StatusBar as OverwatchStatusBar } from "../src/components/StatusBar";
import { MonitorsDropdown } from "../src/components/MonitorsDropdown";
import { TranscriptView } from "../src/components/TranscriptView";
import { InputBar } from "../src/components/InputBar";
import { PTTButton } from "../src/components/PTTButton";
import { SettingsPage } from "../src/components/SettingsPage";
import { QRScanner } from "../src/components/QRScanner";
import { useRealtimeConnection } from "../src/hooks/use-realtime-connection";
import "../global.css";

export default function App() {
  const colors = useColors();
  const { loadBackendURL, connectionStatus } = useConnectionStore();
  const { sendText, sendVoice, cancel, stopAudio } = useOverwatchTurn();
  const { amplitude, startRecording, stopRecording } = useRecorder();
  useRealtimeConnection();

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showMonitors, setShowMonitors] = useState(false);

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
      allowsRecording: false,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      playsInSilentMode: true,
      shouldRouteThroughEarpiece: false,
    });
    loadBackendURL();
    useThemeStore.getState().loadMode();
  }, []);

  const goToSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const openMonitors = useCallback(() => setShowMonitors(true), []);
  const closeMonitors = useCallback(() => setShowMonitors(false), []);

  const handleNewChat = useCallback(() => {
    useTurnStore.getState().clearMessages();
  }, []);

  const handleTextSubmit = useCallback((text: string) => { sendText(text); }, [sendText]);

  const handleStartRecording = useCallback(async () => {
    const t0 = Date.now();
    // Stop TTS playback only — backend turn continues until new message is sent
    stopAudio();
    console.log(`[perf] stopAudio: ${Date.now() - t0}ms`);
    try {
      useTurnStore.getState().setTurnState("preparing");
      const t1 = Date.now();
      await startRecording();
      console.log(`[perf] startRecording: ${Date.now() - t1}ms (total from tap: ${Date.now() - t0}ms)`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      useTurnStore.getState().setTurnState("recording");
    } catch (err) {
      console.error("startRecording failed:", err);
      useTurnStore.getState().setTurnState("idle");
    }
  }, [startRecording, stopAudio]);

  const stoppingRef = useRef(false);
  const handleStopRecording = useCallback(async () => {
    const state = useTurnStore.getState().turnState;
    if (state !== "recording" && state !== "preparing") return;
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const t0 = Date.now();
    useTurnStore.getState().setTurnState("processing");
    try {
      const result = await stopRecording();
      console.log(`[perf] stopRecording: ${Date.now() - t0}ms`);
      if (result?.fileUri) {
        const t1 = Date.now();
        sendVoice(result.fileUri, result.mimeType ?? "audio/m4a");
        console.log(`[perf] sendVoice kicked off: ${Date.now() - t1}ms (total from stop: ${Date.now() - t0}ms)`);
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
        {connectionStatus === "connected" ? (
          <>
            <TranscriptView topInset={Platform.OS === "ios" ? 104 : 80} />

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
                amplitude={amplitude}
              />
            </View>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 40 }}>
            <Text style={{ color: colors.textDim, fontFamily: "IosevkaAile-Regular", fontSize: 15, textAlign: "center" }}>
              {connectionStatus === "reconnecting" ? "Reconnecting to your Mac..." : connectionStatus === "connecting" ? "Connecting..." : "Not connected"}
            </Text>
            {connectionStatus === "disconnected" ? (
              <Pressable
                onPress={() => setShowQR(true)}
                style={{
                  backgroundColor: colors.accent,
                  paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12,
                }}
              >
                <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>
                  Connect
                </Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={goToSettings}
                style={{
                  backgroundColor: colors.accent,
                  paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12,
                }}
              >
                <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>
                  Settings
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Floating header with gradient fade */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 }}>
        <LinearGradient
          colors={[`${colors.bg}ff`, `${colors.bg}e6`, `${colors.bg}99`, `${colors.bg}00`]}
          locations={[0, 0.55, 0.8, 1]}
          style={{ paddingTop: Platform.OS === "ios" ? 54 : 30, paddingBottom: 12 }}
        >
          <OverwatchStatusBar
            onSettingsPress={goToSettings}
            onNewChat={handleNewChat}
            onMonitorsPress={openMonitors}
          />
        </LinearGradient>
      </View>

      {/* QR Scanner Modal */}
      <Modal visible={showQR} animationType="slide">
        <QRScanner onClose={() => setShowQR(false)} />
      </Modal>

      <MonitorsDropdown visible={showMonitors} onClose={closeMonitors} />

      {/* Settings */}
      <Modal visible={showSettings} animationType="slide">
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ height: Platform.OS === "ios" ? 54 : 30 }} />
          <SettingsPage onClose={closeSettings} />
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}
