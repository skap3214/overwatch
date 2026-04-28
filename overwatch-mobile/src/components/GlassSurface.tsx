import React, { type ReactNode, type ComponentProps } from "react";
import { View, Platform, type ViewStyle } from "react-native";
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
  return Platform.OS === "ios" && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
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
  const shadow: ViewStyle = {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 2,
  };

  if (canUseLiquidGlass()) {
    return (
      <GlassView
        colorScheme={colorScheme}
        glassEffectStyle={glassEffectStyle}
        isInteractive={isInteractive}
        style={[style, shadow]}
        tintColor={tintColor}
      >
        {children}
      </GlassView>
    );
  }

  return <View style={[style, fallbackStyle, shadow]}>{children}</View>;
}
