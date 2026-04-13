import React from "react";
import { Animated, Pressable } from "react-native";
import { ArrowDown } from "lucide-react-native";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";

type Props = {
  isAtBottomAnim: Animated.Value;
  onPress: () => void;
};

export function ScrollToBottomButton({ isAtBottomAnim, onPress }: Props) {
  const colors = useColors();

  const opacity = isAtBottomAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });

  const translateY = isAtBottomAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 10],
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        bottom: 12,
        left: 0,
        right: 0,
        alignItems: "center",
        opacity,
        transform: [{ translateY }],
      }}
    >
      <Pressable onPress={onPress}>
        <GlassSurface
          isInteractive
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" }}
          fallbackStyle={{ backgroundColor: colors.surface }}
          tintColor={colors.surface}
        >
          <ArrowDown size={18} color={colors.text} />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}
