import React, { useEffect, useRef } from "react";
import { View, Text, Pressable, Animated, Alert } from "react-native";
import { useConnectionStore } from "../stores/connection-store";
import { useMonitorsStore } from "../stores/monitors-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { Settings, Trash2, Clock3 } from "lucide-react-native";

type Props = {
  onSettingsPress: () => void;
  onNewChat: () => void;
  onMonitorsPress: () => void;
};

const AMBER = "#f59e0b";

export function StatusBar({ onSettingsPress, onNewChat, onMonitorsPress }: Props) {
  const colors = useColors();
  const connectionStatus = useConnectionStore((s) => s.connectionStatus);
  const monitorCount = useMonitorsStore((s) => s.monitorCount());

  const dotColor =
    connectionStatus === "connected" ? colors.success
    : connectionStatus === "reconnecting" ? AMBER
    : connectionStatus === "connecting" ? colors.accent
    : colors.textDim;

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
        zIndex: 10,
      }}
    >
      {/* Left: clear chat */}
      <Pressable
        onPress={() =>
          Alert.alert("Clear chat?", "This will delete all messages.", [
            { text: "Cancel", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: onNewChat },
          ])
        }
        hitSlop={16}
      >
        <GlassSurface
          isInteractive
          style={{ padding: 10, borderRadius: 14 }}
          fallbackStyle={{ backgroundColor: colors.surface }}
          tintColor={colors.surface}
        >
          <Trash2 size={22} color={colors.text} />
        </GlassSurface>
      </Pressable>

      {/* Right: monitors + settings */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {monitorCount > 0 ? (
          <Pressable onPress={onMonitorsPress} hitSlop={16}>
            <GlassSurface
              isInteractive
              style={{ padding: 10, borderRadius: 14 }}
              fallbackStyle={{ backgroundColor: colors.surface }}
              tintColor={colors.surface}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Clock3 size={20} color={colors.text} />
                {monitorCount >= 2 ? (
                  <Text
                    style={{
                      color: colors.textDim,
                      fontSize: 12,
                      fontFamily: "IosevkaAile-Medium",
                    }}
                  >
                    {monitorCount > 8 ? "8+" : monitorCount}
                  </Text>
                ) : null}
              </View>
            </GlassSurface>
          </Pressable>
        ) : null}
        <Pressable onPress={onSettingsPress} hitSlop={16}>
          <GlassSurface
            isInteractive
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 10, paddingRight: 12, paddingVertical: 10, borderRadius: 14 }}
            fallbackStyle={{ backgroundColor: colors.surface }}
            tintColor={colors.surface}
          >
            <Animated.View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: dotColor,
                opacity: pulseAnim,
              }}
            />
            <Settings size={22} color={colors.text} />
          </GlassSurface>
        </Pressable>
      </View>
    </View>
  );
}
