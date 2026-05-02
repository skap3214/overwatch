/**
 * Session token derivation — pure HMAC, no React Native deps.
 *
 * Lives in services/ (not stores/) so it can be imported from a Node-only
 * test runner that exercises the cross-runtime contract with the daemon's
 * `TokenValidator`. The pairing-store re-exports `deriveSessionToken` from
 * here so the rest of the app can still import it from one place.
 *
 * Format: `{session_id}|{expires_at}|{hex_sig}` where
 *   hex_sig = HMAC-SHA256(pairing_token, `{session_id}|{expires_at}`)
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
  // Web Crypto API is available on Hermes (RN 0.72+) and Node.js 20+.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto.subtle unavailable — runtime is too old");
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
