import React, { type ReactNode, type ComponentProps } from "react";
import { View, Platform } from "react-native";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";

type Props = {
  children: ReactNode;
  colorScheme?: "auto" | "light" | "dark";
  fallbackStyle?: ComponentProps<typeof View>["style"];
  glassEffectStyle?: ComponentProps<typeof GlassView>["glassEffectStyle"];
  isInteractive?: boolean;
  style: ComponentProps<typeof View>["style"];
  tintColor?: string;
};

function canUseLiquidGlass() {
  return (
    Platform.OS === "ios" &&
    isLiquidGlassAvailable() &&
    isGlassEffectAPIAvailable()
  );
}

export function GlassSurface({
  children,
  colorScheme = "auto",
  fallbackStyle,
  glassEffectStyle = "regular",
  isInteractive = false,
  style,
  tintColor,
}: Props) {
  if (canUseLiquidGlass()) {
    return (
      <GlassView
        colorScheme={colorScheme}
        glassEffectStyle={glassEffectStyle}
        isInteractive={isInteractive}
        style={style}
        tintColor={tintColor}
      >
        {children}
      </GlassView>
    );
  }

  return <View style={[style, fallbackStyle]}>{children}</View>;
}
