import React, { useState, useCallback } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Keyboard, Modal, Alert } from "react-native";
import { Sun, Moon, Monitor, ChevronRight, Hand, QrCode, Unplug } from "lucide-react-native";
import { GlassSurface } from "./GlassSurface";
import { useConnectionStore } from "../stores/connection-store";
import { useThemeStore, type ThemeMode } from "../stores/theme-store";
import { useColors } from "../theme";
import { QRScanner } from "./QRScanner";
import { realtimeClient, type RelayConfig } from "../services/realtime";
import type { ConnectionStatus } from "../types";

type Props = {
  onClose: () => void;
};

const THEME_OPTIONS: { mode: ThemeMode; Icon: typeof Sun }[] = [
  { mode: "light", Icon: Sun },
  { mode: "dark", Icon: Moon },
  { mode: "system", Icon: Monitor },
];

const RELAY_URL = "https://overwatch-relay.soami.workers.dev";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
};

const AMBER = "#f59e0b";

export function SettingsPage({ onClose }: Props) {
  const colors = useColors();
  const { connectionStatus } = useConnectionStore();
  const { mode: themeMode, setMode: setThemeMode, hand, setHand } = useThemeStore();
  const [showQR, setShowQR] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [joining, setJoining] = useState(false);

  const isConnected = connectionStatus === "connected" || connectionStatus === "connecting" || connectionStatus === "reconnecting";

  // Extract room code from backendURL (relay:XXXX-1234)
  const backendURL = useConnectionStore((s) => s.backendURL);
  const roomCode = backendURL.startsWith("relay:") ? backendURL.slice(6) : null;

  const handleJoinByCode = useCallback(async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    Keyboard.dismiss();
    setJoining(true);

    try {
      const res = await fetch(`${RELAY_URL}/api/room/${code}/join`);
      if (!res.ok) throw new Error("Room not found");
      const data = (await res.json()) as { room: string; roomId: string; hostPublicKey?: string; peers: number };

      if (!data.hostPublicKey) {
        Alert.alert("No host", "No computer is connected to this room. Make sure you've run `overwatch start` first.");
        return;
      }

      const config: RelayConfig = {
        relayUrl: RELAY_URL,
        room: data.room,
        hostPublicKey: data.hostPublicKey,
      };

      realtimeClient.disconnect();
      useConnectionStore.setState({
        backendURL: `relay:${data.room}`,
        connectionStatus: "connecting",
      });
      realtimeClient.connectViaRelay(config);
      setCodeInput("");
    } catch {
      Alert.alert("Error", "Could not join room. Check the code and try again.");
    } finally {
      setJoining(false);
    }
  }, [codeInput]);

  const handleDisconnect = useCallback(() => {
    realtimeClient.disconnect();
    useConnectionStore.setState({
      backendURL: "",
      connectionStatus: "disconnected",
    });
  }, []);

  const dotColor =
    connectionStatus === "connected" ? colors.success
    : connectionStatus === "reconnecting" ? AMBER
    : connectionStatus === "connecting" ? colors.accent
    : colors.textDim;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 24 }}
      keyboardDismissMode="on-drag"
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: colors.text, fontSize: 22, fontFamily: "IosevkaAile-Bold" }}>
          Settings
        </Text>
        <Pressable onPress={onClose} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: colors.textDim, fontSize: 14, fontFamily: "IosevkaAile-Regular" }}>Chat</Text>
          <ChevronRight size={16} color={colors.textDim} />
        </Pressable>
      </View>

      {/* QR Scanner Modal */}
      <Modal visible={showQR} animationType="slide">
        <QRScanner onClose={() => setShowQR(false)} />
      </Modal>

      {/* Connection */}
      <View style={{ gap: 12, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Connection
        </Text>

        {isConnected ? (
          <>
            {/* Connected state */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 8 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor }} />
              <Text style={{ color: colors.text, fontFamily: "IosevkaAile-Medium", fontSize: 15 }}>
                {STATUS_LABELS[connectionStatus]}
              </Text>
            </View>

            {roomCode ? (
              <Text style={{ color: colors.textDim, fontFamily: "IosevkaAile-Regular", fontSize: 13, textAlign: "center" }}>
                Room: {roomCode}
              </Text>
            ) : null}

            <Pressable
              onPress={handleDisconnect}
              style={{
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                backgroundColor: colors.bg, paddingVertical: 12, borderRadius: 12,
              }}
            >
              <Unplug size={16} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>
                Disconnect
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            {/* Disconnected state */}
            <Pressable
              onPress={() => setShowQR(true)}
              style={{
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
                backgroundColor: colors.accent, paddingVertical: 14, borderRadius: 12,
              }}
            >
              <QrCode size={18} color={colors.bg} />
              <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>
                Scan QR Code
              </Text>
            </Pressable>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
              <Text style={{ color: colors.textFaint, fontSize: 11, fontFamily: "IosevkaAile-Regular" }}>or enter room code</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput
                value={codeInput}
                onChangeText={setCodeInput}
                placeholder="ABCD-1234"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
                style={{
                  flex: 1,
                  backgroundColor: colors.bg, color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 15,
                  paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, textAlign: "center", letterSpacing: 2,
                }}
              />
              <Pressable
                onPress={handleJoinByCode}
                disabled={!codeInput.trim() || joining}
                style={{
                  backgroundColor: codeInput.trim() ? colors.accent : colors.bg,
                  paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12,
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{
                  color: codeInput.trim() ? colors.bg : colors.textFaint,
                  fontFamily: "IosevkaAile-Medium", fontSize: 14,
                }}>
                  {joining ? "..." : "Join"}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      {/* Theme */}
      <View style={{ gap: 10, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Appearance
        </Text>
        <View style={{ flexDirection: "row", backgroundColor: colors.bg, borderRadius: 12, padding: 4 }}>
          {THEME_OPTIONS.map(({ mode, Icon }) => {
            const selected = themeMode === mode;
            const inner = <Icon size={18} color={selected ? colors.text : colors.textFaint} />;
            return (
              <Pressable
                key={mode}
                onPress={() => setThemeMode(mode)}
                style={{ flex: 1 }}
              >
                {selected ? (
                  <GlassSurface
                    style={{ alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 8 }}
                    fallbackStyle={{ backgroundColor: colors.surfaceAlt }}
                    tintColor={colors.surfaceAlt}
                  >
                    {inner}
                  </GlassSurface>
                ) : (
                  <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 8 }}>
                    {inner}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Hand preference */}
      <View style={{ gap: 10, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Mic position
        </Text>
        <View style={{ flexDirection: "row", backgroundColor: colors.bg, borderRadius: 12, padding: 4 }}>
          {(["left", "right"] as const).map((side) => {
            const selected = hand === side;
            const inner = (
              <>
                <View style={side === "left" ? { transform: [{ scaleX: -1 }] } : undefined}>
                  <Hand size={16} color={selected ? colors.text : colors.textFaint} />
                </View>
                <Text style={{ color: selected ? colors.text : colors.textFaint, fontSize: 13, fontFamily: "IosevkaAile-Regular" }}>
                  {side === "left" ? "Left" : "Right"}
                </Text>
              </>
            );
            return (
              <Pressable
                key={side}
                onPress={() => setHand(side)}
                style={{ flex: 1 }}
              >
                {selected ? (
                  <GlassSurface
                    style={{ alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 8, flexDirection: "row", gap: 6 }}
                    fallbackStyle={{ backgroundColor: colors.surfaceAlt }}
                    tintColor={colors.surfaceAlt}
                  >
                    {inner}
                  </GlassSurface>
                ) : (
                  <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 8, flexDirection: "row", gap: 6 }}>
                    {inner}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}
