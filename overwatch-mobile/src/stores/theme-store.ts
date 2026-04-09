import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance } from "react-native";

export type ThemeMode = "light" | "dark" | "system";
export type Hand = "left" | "right";

type ThemeStore = {
  mode: ThemeMode;
  hand: Hand;
  setMode: (mode: ThemeMode) => Promise<void>;
  setHand: (hand: Hand) => Promise<void>;
  loadMode: () => Promise<void>;
  isDark: () => boolean;
};

const THEME_KEY = "overwatch_theme";
const HAND_KEY = "overwatch_hand";

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: "dark",
  hand: "left",

  setMode: async (mode: ThemeMode) => {
    set({ mode });
    await AsyncStorage.setItem(THEME_KEY, mode);
  },

  setHand: async (hand: Hand) => {
    set({ hand });
    await AsyncStorage.setItem(HAND_KEY, hand);
  },

  loadMode: async () => {
    const stored = await AsyncStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      set({ mode: stored });
    }
    const storedHand = await AsyncStorage.getItem(HAND_KEY);
    if (storedHand === "left" || storedHand === "right") {
      set({ hand: storedHand });
    }
  },

  isDark: () => {
    const { mode } = get();
    if (mode === "system") {
      return Appearance.getColorScheme() !== "light";
    }
    return mode === "dark";
  },
}));
