import React, { type ReactNode, type ComponentProps } from "react";
import { View } from "react-native";

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
  fallbackStyle,
  style,
}: Props) {
  return <View style={[style, fallbackStyle]}>{children}</View>;
}
