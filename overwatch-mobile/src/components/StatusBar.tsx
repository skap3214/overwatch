import React from "react";
import { View, Text, Pressable } from "react-native";
import { useConnectionStore } from "../stores/connection-store";
import { useTurnStore } from "../stores/turn-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { Settings, Menu } from "lucide-react-native";

type Props = {
  onSettingsPress: () => void;
  onSessionsPress: () => void;
};

const TURN_LABELS: Record<string, string> = {
  idle: "",
  recording: "recording...",
  processing: "thinking...",
  playing: "speaking...",
};

export function StatusBar({ onSettingsPress, onSessionsPress }: Props) {
  const colors = useColors();
  const connectionStatus = useConnectionStore((s) => s.connectionStatus);
  const turnState = useTurnStore((s) => s.turnState);

  const dotColor = connectionStatus === "connected" ? colors.success
    : connectionStatus === "error" ? colors.error : colors.textDim;
  const label = TURN_LABELS[turnState] || connectionStatus;

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
      <Pressable onPress={onSessionsPress} hitSlop={16}>
        <GlassSurface
          isInteractive
          style={{ padding: 10, borderRadius: 14 }}
          fallbackStyle={{ backgroundColor: colors.surface }}
          tintColor={colors.surface}
        >
          <Menu size={26} color={colors.text} />
        </GlassSurface>
      </Pressable>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
        {label ? (
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular" }}>
            {label}
          </Text>
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
