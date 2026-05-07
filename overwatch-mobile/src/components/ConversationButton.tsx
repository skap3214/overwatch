/**
 * ConversationButton — toggle for the always-listening voice loop.
 *
 * Tap to enter conversation mode: the mic stays open, the orchestrator's
 * VAD/smart-turn manage user/bot turn-taking automatically (Pipecat's
 * voice-to-voice flow). Tap again to exit and release the mic.
 *
 * Visually pairs with PTTButton — same circular GlassSurface, same size
 * conventions, but the on-state ring is colored to signal "live mic".
 */
import React from "react";
import { View, Pressable } from "react-native";
import { AudioLines, Headphones } from "lucide-react-native";
import * as Haptics from "expo-haptics";

import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";

type Props = {
  active: boolean;
  onToggle: (next: boolean) => void;
  size?: number;
  disabled?: boolean;
};

const DEFAULT_BTN = 46;

export function ConversationButton({
  active,
  onToggle,
  size,
  disabled,
}: Props) {
  const colors = useColors();
  const BTN = size ?? DEFAULT_BTN;
  const ICON = Math.round(BTN * 0.42);

  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(
      active
        ? Haptics.ImpactFeedbackStyle.Light
        : Haptics.ImpactFeedbackStyle.Medium,
    );
    onToggle(!active);
  };

  if (active) {
    // Filled accent state: live mic, voice-to-voice loop running.
    return (
      <Pressable
        onPress={handlePress}
        disabled={disabled}
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        <View
          style={{
            width: BTN,
            height: BTN,
            borderRadius: BTN / 2,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 2,
            borderColor: colors.accent,
          }}
        >
          <AudioLines size={ICON} color={colors.bg} />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <GlassSurface
        isInteractive
        style={{
          width: BTN,
          height: BTN,
          borderRadius: BTN / 2,
          alignItems: "center",
          justifyContent: "center",
        }}
        fallbackStyle={{ backgroundColor: colors.surface }}
        tintColor={colors.surface}
      >
        <Headphones size={ICON} color={colors.text} />
      </GlassSurface>
    </Pressable>
  );
}
