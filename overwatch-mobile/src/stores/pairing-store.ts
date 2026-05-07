/**
 * Pairing store — replaces the legacy connection-store.
 *
 * Holds the alpha pairing identity:
 *  - relayUrl: where to call /api/sessions/start to mint a Pipecat Cloud session
 *  - userId: the user identity bootstrapped at QR pair time
 *  - pairingToken: long-term token shared between phone, daemon, and orchestrator
 *
 * Connection status is derived from the conversation store's transportState —
 * components that need it should read from useConversationStore directly.
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const RELAY_URL_KEY = "overwatch_relay_url";
const USER_ID_KEY = "overwatch_user_id";
const PAIRING_TOKEN_KEY = "overwatch_pairing_token";
const STT_PROVIDER_KEY = "overwatch_pairing_stt_provider";
const TTS_PROVIDER_KEY = "overwatch_pairing_tts_provider";
const LEGACY_TTS_PROVIDER_KEY = "overwatch_tts_provider";

const DEFAULT_RELAY_URL = "https://overwatch-relay.soami.workers.dev";
export type STTProvider = "deepgram" | "xai";
export type TTSProvider = "cartesia" | "xai";

interface PairingState {
  relayUrl: string;
  userId: string;
  pairingToken: string;
  sttProvider: STTProvider;
  ttsProvider: TTSProvider;
  hydrate: () => Promise<void>;
  setPairing: (
    p: { relayUrl?: string; userId: string; pairingToken: string; sttProvider?: STTProvider; ttsProvider?: TTSProvider },
  ) => Promise<void>;
  clearPairing: () => Promise<void>;
  isPaired: () => boolean;
}

export const usePairingStore = create<PairingState>((set, get) => ({
  relayUrl: DEFAULT_RELAY_URL,
  userId: "",
  pairingToken: "",
  sttProvider: "deepgram",
  ttsProvider: "cartesia",

  async hydrate() {
    const [relayUrl, userId, pairingToken, sttProvider, ttsProvider, legacyTTSProvider] = await Promise.all([
      AsyncStorage.getItem(RELAY_URL_KEY),
      AsyncStorage.getItem(USER_ID_KEY),
      AsyncStorage.getItem(PAIRING_TOKEN_KEY),
      AsyncStorage.getItem(STT_PROVIDER_KEY),
      AsyncStorage.getItem(TTS_PROVIDER_KEY),
      AsyncStorage.getItem(LEGACY_TTS_PROVIDER_KEY),
    ]);
    set({
      relayUrl: relayUrl ?? DEFAULT_RELAY_URL,
      userId: userId ?? "",
      pairingToken: pairingToken ?? "",
      sttProvider: normalizeSTTProvider(sttProvider),
      ttsProvider: normalizeTTSProvider(ttsProvider ?? legacyTTSProvider),
    });
  },

  async setPairing({ relayUrl, userId, pairingToken, sttProvider, ttsProvider }) {
    const url = relayUrl ?? get().relayUrl;
    const stt = sttProvider ?? "deepgram";
    const tts = ttsProvider ?? "cartesia";
    set({ relayUrl: url, userId, pairingToken, sttProvider: stt, ttsProvider: tts });
    await Promise.all([
      AsyncStorage.setItem(RELAY_URL_KEY, url),
      AsyncStorage.setItem(USER_ID_KEY, userId),
      AsyncStorage.setItem(PAIRING_TOKEN_KEY, pairingToken),
      AsyncStorage.setItem(STT_PROVIDER_KEY, stt),
      AsyncStorage.setItem(TTS_PROVIDER_KEY, tts),
    ]);
  },

  async clearPairing() {
    set({ userId: "", pairingToken: "", sttProvider: "deepgram", ttsProvider: "cartesia" });
    await Promise.all([
      AsyncStorage.removeItem(USER_ID_KEY),
      AsyncStorage.removeItem(PAIRING_TOKEN_KEY),
      AsyncStorage.removeItem(STT_PROVIDER_KEY),
      AsyncStorage.removeItem(TTS_PROVIDER_KEY),
    ]);
  },

  isPaired() {
    const s = get();
    return Boolean(s.userId && s.pairingToken);
  },
}));

function normalizeSTTProvider(value: string | null): STTProvider {
  return value === "xai" || value === "grok" ? "xai" : "deepgram";
}

function normalizeTTSProvider(value: string | null): TTSProvider {
  return value === "xai" ? "xai" : "cartesia";
}

// Session token derivation lives in services/session-token.ts so it can be
// imported from a Node-only test runner (no RN deps). Re-export here for
// convenience. Extension-less so Metro and tsx both resolve to the .ts source.
export { deriveSessionToken } from "../services/session-token";
