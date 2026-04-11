import React, { useEffect, useRef } from "react";
import { View, Text, Pressable, Animated } from "react-native";
import { useConnectionStore } from "../stores/connection-store";
import { useNotificationsStore } from "../stores/notifications-store";
import { useTurnStore } from "../stores/turn-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { Settings, Plus } from "lucide-react-native";
import type { ConnectionStatus } from "../types";

type Props = {
  onSettingsPress: () => void;
  onNewChat: () => void;
};

const TURN_LABELS: Record<string, string> = {
  idle: "",
  recording: "recording...",
  processing: "thinking...",
  playing: "speaking...",
};

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
};

const AMBER = "#f59e0b";

export function StatusBar({ onSettingsPress, onNewChat }: Props) {
  const colors = useColors();
  const connectionStatus = useConnectionStore((s) => s.connectionStatus);
  const turnState = useTurnStore((s) => s.turnState);
  const unreadCount = useNotificationsStore((s) => s.unreadCount());

  const dotColor =
    connectionStatus === "connected" ? colors.success
    : connectionStatus === "reconnecting" ? AMBER
    : connectionStatus === "connecting" ? colors.accent
    : colors.textDim;

  const turnLabel = TURN_LABELS[turnState];
  const label = turnLabel || CONNECTION_LABELS[connectionStatus];

  // Pulse animation for reconnecting
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (connectionStatus === "reconnecting") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(1);
  }, [connectionStatus, pulseAnim]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 12,
        paddingVertical: 8,
        overflow: "visible",
        zIndex: 10,
      }}
    >
      <Pressable onPress={onNewChat} hitSlop={16}>
        <GlassSurface
          isInteractive
          style={{ padding: 10, borderRadius: 14 }}
          fallbackStyle={{ backgroundColor: colors.surface }}
          tintColor={colors.surface}
        >
          <Plus size={26} color={colors.text} />
        </GlassSurface>
      </Pressable>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Animated.View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: dotColor,
            opacity: pulseAnim,
          }}
        />
        {label ? (
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular" }}>
            {label}
          </Text>
        ) : null}
        {unreadCount > 0 ? (
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 999,
              paddingHorizontal: 8,
              paddingVertical: 2,
            }}
          >
            <Text
              style={{
                color: colors.textDim,
                fontSize: 11,
                fontFamily: "IosevkaAile-Regular",
              }}
            >
              {unreadCount} unread
            </Text>
          </View>
        ) : null}
      </View>

      <Pressable onPress={onSettingsPress} hitSlop={16}>
        <GlassSurface
          isInteractive
          style={{ padding: 10, borderRadius: 14 }}
          fallbackStyle={{ backgroundColor: colors.surface }}
          tintColor={colors.surface}
        >
          <Settings size={26} color={colors.text} />
        </GlassSurface>
      </Pressable>
    </View>
  );
}
