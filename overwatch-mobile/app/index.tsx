import React, { useEffect, useCallback, useState } from "react";
import {
  View,
  Text,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Pressable,
  Modal,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";

import { useThemeStore } from "../src/stores/theme-store";
import { usePairingStore, deriveSessionToken } from "../src/stores/pairing-store";
import { useConversationStore } from "../src/stores/conversation";
import { usePipecatSession } from "../src/hooks/use-pipecat-session";
import { useColors } from "../src/theme";
import { StatusBar as OverwatchStatusBar } from "../src/components/StatusBar";
import { MonitorsDropdown } from "../src/components/MonitorsDropdown";
import { NotificationsHistoryScreen } from "../src/components/NotificationsHistoryScreen";
import { TranscriptView } from "../src/components/TranscriptView";
import { InputBar } from "../src/components/InputBar";
import { PTTButton } from "../src/components/PTTButton";
import { SettingsPage } from "../src/components/SettingsPage";
import { QRScanner } from "../src/components/QRScanner";
import "../global.css";

export default function App() {
  const colors = useColors();
  const hand = useThemeStore((s) => s.hand);

  const isPaired = usePairingStore((s) => Boolean(s.userId && s.pairingToken));
  const relayUrl = usePairingStore((s) => s.relayUrl);
  const userId = usePairingStore((s) => s.userId);
  const pairingToken = usePairingStore((s) => s.pairingToken);
  const hydratePairing = usePairingStore((s) => s.hydrate);

  const transportState = useConversationStore((s) => s.transportState);
  const turnState = useConversationStore((s) => s.turnState);
  const setTurnState = useConversationStore((s) => s.setTurnState);
  const clearMessages = useConversationStore((s) => s.clearMessages);
  const recordingUI = turnState === "recording" || turnState === "preparing";

  const { connect, disconnect, sendUserText, setMicEnabled, sendInterruptIntent } =
    usePipecatSession();

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showMonitors, setShowMonitors] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardWillShow", () =>
      setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener("keyboardWillHide", () =>
      setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const [fontsLoaded] = useFonts({
    "IosevkaAile-Regular": require("../assets/fonts/IosevkaAile-Regular.ttf"),
    "IosevkaAile-Bold": require("../assets/fonts/IosevkaAile-Bold.ttf"),
    "IosevkaAile-Medium": require("../assets/fonts/IosevkaAile-Medium.ttf"),
  });

  useEffect(() => {
    void hydratePairing();
    useThemeStore.getState().loadMode();
  }, [hydratePairing]);

  // Auto-connect once paired and hydrated.
  useEffect(() => {
    if (!isPaired) return;
    let cancelled = false;
    (async () => {
      const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionToken = await deriveSessionToken(pairingToken, sessionId);

      // Mint Daily room URL via the relay.
      let roomUrl = "";
      let roomToken = "";
      try {
        const res = await fetch(`${relayUrl}/api/sessions/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, pairing_token: pairingToken }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            daily_room_url?: string;
            daily_token?: string;
          };
          roomUrl = data.daily_room_url ?? "";
          roomToken = data.daily_token ?? "";
        }
      } catch (err) {
        console.warn("session start failed", err);
      }
      if (!roomUrl || !roomToken || cancelled) return;

      await connect({
        endpoint: roomUrl,
        sessionToken,
        mode: "ptt",
      });
    })();
    return () => {
      cancelled = true;
      void disconnect();
    };
  }, [isPaired, relayUrl, userId, pairingToken, connect, disconnect]);

  const goToSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const openMonitors = useCallback(() => setShowMonitors(true), []);
  const closeMonitors = useCallback(() => setShowMonitors(false), []);

  const handleNewChat = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  const handleTextSubmit = useCallback(
    (text: string) => {
      void sendUserText(text);
    },
    [sendUserText],
  );

  const handleStartRecording = useCallback(async () => {
    setTurnState("recording");
    void sendInterruptIntent();
    void setMicEnabled(true);
  }, [setMicEnabled, sendInterruptIntent, setTurnState]);

  const handleStopRecording = useCallback(async () => {
    void setMicEnabled(false);
    setTurnState("idle");
  }, [setMicEnabled, setTurnState]);

  const handleCancelRecording = useCallback(async () => {
    void setMicEnabled(false);
    setTurnState("idle");
  }, [setMicEnabled, setTurnState]);

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
        {transportState === "connected" ? (
          <>
            <TranscriptView topInset={Platform.OS === "ios" ? 104 : 80} />

            <View
              style={{
                flexDirection: hand === "left" ? "row-reverse" : "row",
                alignItems: "center",
                paddingHorizontal: 28,
                paddingTop: 6,
                paddingBottom: keyboardVisible ? 6 : 36,
                gap: 8,
                backgroundColor: colors.bg,
              }}
            >
              <View style={{ flex: 1 }}>
                {!recordingUI && <InputBar onSubmit={handleTextSubmit} />}
              </View>
              <PTTButton
                hand={hand}
                onStartRecording={handleStartRecording}
                onStopRecording={handleStopRecording}
                onCancelRecording={handleCancelRecording}
                amplitude={0}
              />
            </View>
          </>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              paddingHorizontal: 40,
            }}
          >
            <Text
              style={{
                color: colors.textDim,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 15,
                textAlign: "center",
              }}
            >
              {transportState === "connecting"
                ? "Connecting..."
                : isPaired
                  ? "Reconnecting..."
                  : "Not paired"}
            </Text>
            {!isPaired ? (
              <Pressable
                onPress={() => setShowQR(true)}
                style={{
                  backgroundColor: colors.accent,
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 12,
                }}
              >
                <Text
                  style={{
                    color: colors.bg,
                    fontFamily: "IosevkaAile-Medium",
                    fontSize: 14,
                  }}
                >
                  Pair via QR
                </Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={goToSettings}
                style={{
                  backgroundColor: colors.accent,
                  paddingHorizontal: 24,
                  paddingVertical: 12,
                  borderRadius: 12,
                }}
              >
                <Text
                  style={{
                    color: colors.bg,
                    fontFamily: "IosevkaAile-Medium",
                    fontSize: 14,
                  }}
                >
                  Settings
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </KeyboardAvoidingView>

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
            onNotificationsPress={() => setShowNotifications(true)}
          />
        </LinearGradient>
      </View>

      <Modal visible={showQR} animationType="slide">
        <QRScanner onClose={() => setShowQR(false)} />
      </Modal>

      <MonitorsDropdown visible={showMonitors} onClose={closeMonitors} />

      <NotificationsHistoryScreen
        visible={showNotifications}
        onClose={() => setShowNotifications(false)}
      />

      <Modal visible={showSettings} animationType="slide">
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ height: Platform.OS === "ios" ? 54 : 30 }} />
          <SettingsPage onClose={closeSettings} />
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}
