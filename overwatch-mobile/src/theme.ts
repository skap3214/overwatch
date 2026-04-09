import { useThemeStore } from "./stores/theme-store";

export type Colors = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  error: string;
  success: string;
};

const dark: Colors = {
  bg: "#0c0c0c",
  surface: "#151515",
  surfaceAlt: "#1a1a1a",
  border: "#222",
  text: "#d4d4d4",
  textDim: "#666",
  textFaint: "#444",
  accent: "#d4d4d4",
  error: "#ef4444",
  success: "#4ade80",
};

const light: Colors = {
  bg: "#ffffff",
  surface: "#f5f5f5",
  surfaceAlt: "#ebebeb",
  border: "#e0e0e0",
  text: "#1a1a1a",
  textDim: "#888",
  textFaint: "#bbb",
  accent: "#1a1a1a",
  error: "#dc2626",
  success: "#16a34a",
};

export function useColors(): Colors {
  const isDark = useThemeStore((s) => s.isDark());
  return isDark ? dark : light;
}

export function getColors(): Colors {
  return useThemeStore.getState().isDark() ? dark : light;
}
