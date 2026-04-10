import React, { type ReactNode, type ComponentProps } from "react";
import { View, Platform } from "react-native";

// Dynamic import — expo-glass-effect may crash on older iOS / non-iOS
let GlassView: any = null;
let isGlassAvailable = false;

try {
  const mod = require("expo-glass-effect");
  if (
    Platform.OS === "ios" &&
    mod.isLiquidGlassAvailable?.() &&
    mod.isGlassEffectAPIAvailable?.()
  ) {
    GlassView = mod.GlassView;
    isGlassAvailable = true;
  }
} catch {
  // Not available — use fallback
}

type Props = {
  children: ReactNode;
  colorScheme?: "auto" | "light" | "dark";
  fallbackStyle?: ComponentProps<typeof View>["style"];
  glassEffectStyle?: string;
  isInteractive?: boolean;
  style: ComponentProps<typeof View>["style"];
  tintColor?: string;
};

export function GlassSurface({
  children,
  colorScheme = "auto",
  fallbackStyle,
  glassEffectStyle = "regular",
  isInteractive = false,
  style,
  tintColor,
}: Props) {
  if (isGlassAvailable && GlassView) {
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
