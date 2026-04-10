import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ConnectionStatus } from "../types";

const BACKEND_URL_KEY = "overwatch_backend_url";

type ConnectionStore = {
  backendURL: string;
  connectionStatus: ConnectionStatus;
  setBackendURL: (url: string) => Promise<void>;
  loadBackendURL: () => Promise<void>;
  setConnectionStatus: (status: ConnectionStatus) => void;
  checkHealth: () => Promise<void>;
};

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  backendURL: "",
  connectionStatus: "disconnected",

  setBackendURL: async (url: string) => {
    const trimmed = url.replace(/\/+$/, "");
    set({ backendURL: trimmed, connectionStatus: "disconnected" });
    await AsyncStorage.setItem(BACKEND_URL_KEY, trimmed);
    if (trimmed) {
      get().checkHealth();
    }
  },

  loadBackendURL: async () => {
    const stored = await AsyncStorage.getItem(BACKEND_URL_KEY);
    if (stored) {
      set({ backendURL: stored });
      // Relay URLs need a QR scan to reconnect — don't auto health check
      if (!stored.startsWith("relay:") && !stored.includes("(relay:")) {
        get().checkHealth();
      }
    }
  },

  setConnectionStatus: (status: ConnectionStatus) => {
    set({ connectionStatus: status });
  },

  checkHealth: async () => {
    const { backendURL } = get();
    if (!backendURL) {
      set({ connectionStatus: "disconnected" });
      return;
    }
    // Relay mode — WebSocket handles status, skip HTTP health check
    if (backendURL.startsWith("relay:") || backendURL.includes("(relay:")) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${backendURL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        set({ connectionStatus: "error" });
        return;
      }
      set({ connectionStatus: "connected" });
    } catch (err) {
      console.warn("Health check failed:", err);
      set({ connectionStatus: "error" });
    }
  },
}));
