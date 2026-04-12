import React from "react";
import { Pressable, ActivityIndicator } from "react-native";
import { useTurnStore } from "../stores/turn-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import * as Haptics from "expo-haptics";
import { Mic, Square } from "lucide-react-native";

type Props = {
  onStartRecording: () => void;
  onStopRecording: () => void;
  amplitude: number;
};

const BTN = 46;

export function PTTButton({ onStartRecording, onStopRecording, amplitude }: Props) {
  const colors = useColors();
  const turnState = useTurnStore((s) => s.turnState);

  const isPreparing = turnState === "preparing";
  const isRecording = turnState === "recording";

  const handlePress = () => {
    if (isRecording) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onStopRecording(); return; }
    if (isPreparing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onStartRecording();
  };

  const active = isRecording;
  const fg = active ? colors.bg : colors.text;
  const scale = isRecording ? 1 + amplitude * 0.15 : 1;

  if (active) {
    return (
      <Pressable
        onPress={handlePress}
        style={{
          width: BTN, height: BTN, borderRadius: BTN / 2,
          backgroundColor: colors.accent,
          alignItems: "center", justifyContent: "center",
          transform: [{ scale }],
        }}
      >
        <Square size={14} color={fg} fill={fg} />
      </Pressable>
    );
  }

  return (
    <Pressable onPress={handlePress}>
      <GlassSurface
        isInteractive
        style={{
          width: BTN,
          height: BTN,
          borderRadius: BTN / 2,
          alignItems: "center",
          justifyContent: "center",
        }}
        fallbackStyle={{
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        }}
        tintColor={colors.surface}
      >
        {isPreparing ? (
          <ActivityIndicator size="small" color={colors.textDim} />
        ) : (
          <Mic size={20} color={fg} />
        )}
      </GlassSurface>
    </Pressable>
  );
}
