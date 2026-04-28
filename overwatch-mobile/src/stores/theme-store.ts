import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance } from "react-native";
import { realtimeClient } from "../services/realtime";

export type ThemeMode = "light" | "dark" | "system";
export type Hand = "left" | "right";

type ThemeStore = {
  mode: ThemeMode;
  hand: Hand;
  ttsEnabled: boolean;
  setMode: (mode: ThemeMode) => Promise<void>;
  setHand: (hand: Hand) => Promise<void>;
  setTTSEnabled: (enabled: boolean) => Promise<void>;
  loadMode: () => Promise<void>;
  isDark: () => boolean;
};

const THEME_KEY = "overwatch_theme";
const HAND_KEY = "overwatch_hand";
const TTS_KEY = "overwatch_tts_enabled";

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: "dark",
  hand: "left",
  ttsEnabled: true,

  setMode: async (mode: ThemeMode) => {
    set({ mode });
    await AsyncStorage.setItem(THEME_KEY, mode);
  },

  setHand: async (hand: Hand) => {
    set({ hand });
    await AsyncStorage.setItem(HAND_KEY, hand);
  },

  setTTSEnabled: async (enabled: boolean) => {
    set({ ttsEnabled: enabled });
    await AsyncStorage.setItem(TTS_KEY, enabled ? "true" : "false");
    realtimeClient.updateSettings({ tts: enabled });
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
    const storedTTS = await AsyncStorage.getItem(TTS_KEY);
    if (storedTTS === "true" || storedTTS === "false") {
      set({ ttsEnabled: storedTTS === "true" });
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
