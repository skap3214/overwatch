/**
 * Session token derivation — pure HMAC, no native deps.
 *
 * Lives in services/ (not stores/) so it can be imported from a Node-only
 * test runner that exercises the cross-runtime contract with the daemon's
 * `TokenValidator`. The pairing-store re-exports `deriveSessionToken` from
 * here so the rest of the app can still import it from one place.
 *
 * Format: `{session_id}|{expires_at}|{hex_sig}` where
 *   hex_sig = HMAC-SHA256(pairing_token, `{session_id}|{expires_at}`)
 *
 * Implementation note: we use @noble/hashes (pure JS) instead of Web Crypto
 * because RN/Hermes does not expose `crypto.subtle.importKey + sign("HMAC")`
 * by default. Wire-compatible with Node `crypto.createHmac` and Python
 * `hmac.new(..., sha256)` — verified by tests/cross-runtime-token-contract.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export async function deriveSessionToken(
  pairingToken: string,
  sessionId: string,
  ttlSeconds: number = 60 * 60,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const message = `${sessionId}|${expiresAt}`;
  const signature = hmacSha256(pairingToken, message);
  return `${message}|${signature}`;
}

function hmacSha256(secret: string, message: string): string {
  const enc = new TextEncoder();
  const sig = hmac(sha256, enc.encode(secret), enc.encode(message));
  return bytesToHex(sig);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
