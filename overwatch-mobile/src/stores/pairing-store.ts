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

const DEFAULT_RELAY_URL = "https://overwatch-relay.soami.workers.dev";

interface PairingState {
  relayUrl: string;
  userId: string;
  pairingToken: string;
  hydrate: () => Promise<void>;
  setPairing: (
    p: { relayUrl?: string; userId: string; pairingToken: string },
  ) => Promise<void>;
  clearPairing: () => Promise<void>;
  isPaired: () => boolean;
}

export const usePairingStore = create<PairingState>((set, get) => ({
  relayUrl: DEFAULT_RELAY_URL,
  userId: "",
  pairingToken: "",

  async hydrate() {
    const [relayUrl, userId, pairingToken] = await Promise.all([
      AsyncStorage.getItem(RELAY_URL_KEY),
      AsyncStorage.getItem(USER_ID_KEY),
      AsyncStorage.getItem(PAIRING_TOKEN_KEY),
    ]);
    set({
      relayUrl: relayUrl ?? DEFAULT_RELAY_URL,
      userId: userId ?? "",
      pairingToken: pairingToken ?? "",
    });
  },

  async setPairing({ relayUrl, userId, pairingToken }) {
    const url = relayUrl ?? get().relayUrl;
    set({ relayUrl: url, userId, pairingToken });
    await Promise.all([
      AsyncStorage.setItem(RELAY_URL_KEY, url),
      AsyncStorage.setItem(USER_ID_KEY, userId),
      AsyncStorage.setItem(PAIRING_TOKEN_KEY, pairingToken),
    ]);
  },

  async clearPairing() {
    set({ userId: "", pairingToken: "" });
    await Promise.all([
      AsyncStorage.removeItem(USER_ID_KEY),
      AsyncStorage.removeItem(PAIRING_TOKEN_KEY),
    ]);
  },

  isPaired() {
    const s = get();
    return Boolean(s.userId && s.pairingToken);
  },
}));

/**
 * Derives a session-scoped HMAC token from the long-term pairing token.
 * Phone-side; the orchestrator and daemon verify this same HMAC.
 *
 * The legacy nacl-based pairing flow lives in `services/crypto.ts`. The
 * session token here is a separate concept — see plan §7 trust model.
 */
import { Buffer } from "buffer";

export async function deriveSessionToken(
  pairingToken: string,
  sessionId: string,
  ttlSeconds: number = 60 * 60,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const message = `${sessionId}|${expiresAt}`;
  const signature = await hmacSha256(pairingToken, message);
  return `${message}|${signature}`;
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  // Web Crypto API is available on Hermes (RN 0.72+).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto.subtle unavailable — RN runtime is too old");
  }
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, enc.encode(message));
  return Buffer.from(new Uint8Array(sig)).toString("hex");
}
