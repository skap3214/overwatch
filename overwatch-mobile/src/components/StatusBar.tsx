import React, { useEffect, useRef } from "react";
import { View, Text, Pressable, Animated, Alert } from "react-native";
import { useConversationStore } from "../stores/conversation";
import { useMonitorsStore } from "../stores/monitors-store";
import { useNotificationsStore } from "../stores/notifications-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { SkillsPill } from "./SkillsPill";
import { Settings, Trash2, Clock3, Bell } from "lucide-react-native";

type Props = {
  onSettingsPress: () => void;
  onNewChat: () => void;
  onMonitorsPress: () => void;
  onNotificationsPress?: () => void;
};

export function StatusBar({ onSettingsPress, onNewChat, onMonitorsPress, onNotificationsPress }: Props) {
  const colors = useColors();
  const transportState = useConversationStore((s) => s.transportState);
  const monitorCount = useMonitorsStore((s) => s.monitorCount());
  const unreadCount = useNotificationsStore((s) => s.unreadCount());

  const dotColor =
    transportState === "connected" ? colors.success
    : transportState === "connecting" ? colors.accent
    : colors.textDim;

  // Pulse the dot while connecting (the legacy "reconnecting" amber state was
  // dropped in the overhaul — Pipecat handles its own session lifecycle).
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (transportState === "connecting") {
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
  }, [transportState, pulseAnim]);

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
          <Trash2 size={26} color={colors.text} />
        </GlassSurface>
      </Pressable>

      {/* Right: skills + notifications + monitors + settings */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <SkillsPill />
        {unreadCount > 0 && onNotificationsPress ? (
          <Pressable onPress={onNotificationsPress} hitSlop={16}>
            <GlassSurface
              isInteractive
              style={{ padding: 10, borderRadius: 14 }}
              fallbackStyle={{ backgroundColor: colors.surface }}
              tintColor={colors.surface}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Bell size={22} color={colors.text} />
                <Text
                  style={{
                    color: colors.textDim,
                    fontSize: 12,
                    fontFamily: "IosevkaAile-Medium",
                  }}
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Text>
              </View>
            </GlassSurface>
          </Pressable>
        ) : null}
        {monitorCount > 0 ? (
          <Pressable onPress={onMonitorsPress} hitSlop={16}>
            <GlassSurface
              isInteractive
              style={{ padding: 10, borderRadius: 14 }}
              fallbackStyle={{ backgroundColor: colors.surface }}
              tintColor={colors.surface}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Clock3 size={24} color={colors.text} />
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
            <Settings size={26} color={colors.text} />
          </GlassSurface>
        </Pressable>
      </View>
    </View>
  );
}
