import React, { useEffect, useCallback, useState } from "react";
import {
  AppState,
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
import { applyConversationToggle } from "../src/services/voice-controls";
import { useColors } from "../src/theme";
import { StatusBar as OverwatchStatusBar } from "../src/components/StatusBar";
import { MonitorsDropdown } from "../src/components/MonitorsDropdown";
import { NotificationsHistoryScreen } from "../src/components/NotificationsHistoryScreen";
import { TranscriptView } from "../src/components/TranscriptView";
import { PTTButton } from "../src/components/PTTButton";
import { ConversationButton } from "../src/components/ConversationButton";
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
  const sttProvider = usePairingStore((s) => s.sttProvider);
  const ttsProvider = usePairingStore((s) => s.ttsProvider);
  const hydratePairing = usePairingStore((s) => s.hydrate);

  const transportState = useConversationStore((s) => s.transportState);
  const turnState = useConversationStore((s) => s.turnState);
  const connectError = useConversationStore((s) => s.connectError);
  const setTurnState = useConversationStore((s) => s.setTurnState);
  const setConnectError = useConversationStore((s) => s.setConnectError);
  const clearMessages = useConversationStore((s) => s.clearMessages);
  const [retryNonce, setRetryNonce] = useState(0);
  // Conversation mode: tap to flip into the always-listening voice-to-voice
  // loop (mic stays open, server VAD/smart-turn manage turn-taking). Tap
  // again to exit. PTT is disabled while conversation mode is on.
  const [conversationActive, setConversationActive] = useState(false);
  // recordingUI no longer drives an InputBar swap (InputBar removed) but
  // PTTButton still uses it internally via the conversation store state.
  void turnState;

  const { connect, disconnect, setMicEnabled, sendInterruptIntent } =
    usePipecatSession();

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showMonitors, setShowMonitors] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  // Tracks whether the app is in the foreground. We tear down the Daily
  // session on background so iOS releases the audio session entirely
  // (orange recording indicator goes away, AirPods/Mac audio routing is no
  // longer hijacked). The auto-connect effect re-runs when this flips back
  // to active.
  const [appActive, setAppActive] = useState<boolean>(
    AppState.currentState === "active",
  );

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

  // Background → leave the Daily call so iOS releases the audio session
  // and the user's Mac/AirPods routing stops being hijacked. Foreground →
  // the auto-connect effect re-runs and rejoins. We only react to the
  // explicit "background" state — `inactive` is transient (volume button,
  // alert), and tearing down on those would cause a thrashy reconnect.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setAppActive(true);
      } else if (state === "background") {
        setAppActive(false);
        void disconnect();
      }
    });
    return () => sub.remove();
  }, [disconnect]);

  // Auto-connect once paired and hydrated. Re-runs when retryNonce flips
  // or when the app returns to the foreground.
  useEffect(() => {
    if (!isPaired) return;
    if (!appActive) return;
    let cancelled = false;
    (async () => {
      setConnectError(null);
      const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let sessionToken: string;
      try {
        sessionToken = await deriveSessionToken(pairingToken, sessionId);
      } catch (err) {
        if (!cancelled) {
          setConnectError(
            `Couldn't derive session token: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // Mint Daily room URL via the relay.
      // The session_token is the per-session HMAC the orchestrator will
      // present on every envelope; the daemon verifies it via the same
      // shared pairing_token. The relay forwards all three to Pipecat Cloud
      // as runner_args.body so the bot can read them at start time.
      let roomUrl = "";
      let roomToken = "";
      try {
        const res = await fetch(`${relayUrl}/api/sessions/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            pairing_token: pairingToken,
            session_token: sessionToken,
            stt_provider: sttProvider,
            tts_provider: ttsProvider,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `relay /api/sessions/start ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
          );
        }
        const data = (await res.json()) as {
          daily_room_url?: string;
          daily_token?: string;
        };
        roomUrl = data.daily_room_url ?? "";
        roomToken = data.daily_token ?? "";
        if (!roomUrl || !roomToken) {
          throw new Error(
            "relay returned no daily_room_url / daily_token — check Pipecat Cloud session minting",
          );
        }
      } catch (err) {
        if (!cancelled) {
          setConnectError(
            err instanceof Error ? err.message : `Session start failed: ${String(err)}`,
          );
        }
        return;
      }
      if (cancelled) return;

      try {
        await connect({
          roomUrl,
          roomToken,
          sessionToken,
          mode: "ptt",
        });
      } catch (err) {
        if (!cancelled) {
          setConnectError(
            err instanceof Error ? err.message : `Transport failed: ${String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      void disconnect();
    };
  }, [
    isPaired,
    appActive,
    relayUrl,
    userId,
    pairingToken,
    sttProvider,
    ttsProvider,
    connect,
    disconnect,
    setConnectError,
    retryNonce,
  ]);

  const goToSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const openMonitors = useCallback(() => setShowMonitors(true), []);
  const closeMonitors = useCallback(() => setShowMonitors(false), []);

  const handleNewChat = useCallback(() => {
    logApp("new_chat");
    clearMessages();
  }, [clearMessages]);

  const handleStartRecording = useCallback(async () => {
    logApp("ptt.start_recording");
    setTurnState("recording");
    void sendInterruptIntent();
    void setMicEnabled(true);
  }, [setMicEnabled, sendInterruptIntent, setTurnState]);

  const handleStopRecording = useCallback(async () => {
    logApp("ptt.stop_recording");
    void setMicEnabled(false);
    setTurnState("idle");
  }, [setMicEnabled, setTurnState]);

  const handleCancelRecording = useCallback(async () => {
    logApp("ptt.cancel_recording");
    void setMicEnabled(false);
    setTurnState("idle");
  }, [setMicEnabled, setTurnState]);

  const handleConversationToggle = useCallback(
    (next: boolean) => {
      logApp("conversation.toggle", { next });
      applyConversationToggle(next, {
        setConversationActive,
        sendInterruptIntent,
        setMicEnabled,
        setTurnState,
      });
    },
    [sendInterruptIntent, setMicEnabled, setTurnState],
  );

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
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 28,
                paddingTop: 6,
                paddingBottom: keyboardVisible ? 6 : 36,
                gap: 32,
                backgroundColor: colors.bg,
              }}
            >
              <PTTButton
                hand={hand}
                size={88}
                disabled={conversationActive}
                onStartRecording={handleStartRecording}
                onStopRecording={handleStopRecording}
                onCancelRecording={handleCancelRecording}
                amplitude={0}
              />
              <ConversationButton
                size={88}
                active={conversationActive}
                onToggle={handleConversationToggle}
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
              {connectError
                ? "Couldn't connect"
                : transportState === "connecting"
                  ? "Connecting..."
                  : isPaired
                    ? "Reconnecting..."
                    : "Not paired"}
            </Text>
            {connectError ? (
              <Text
                style={{
                  color: colors.textDim,
                  fontFamily: "IosevkaAile-Regular",
                  fontSize: 12,
                  textAlign: "center",
                  opacity: 0.85,
                }}
              >
                {connectError}
              </Text>
            ) : null}
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
            ) : connectError ? (
              <Pressable
                onPress={() => setRetryNonce((n) => n + 1)}
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
                  Retry
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

function logApp(event: string, payload?: Record<string, unknown>): void {
  console.info(
    "[overwatch-mobile]",
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...(payload ?? {}),
    }),
  );
}
