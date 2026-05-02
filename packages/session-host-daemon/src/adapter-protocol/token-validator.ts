/**
 * Validates per-user + per-session tokens on inbound HarnessCommands.
 *
 * The pairing token (long-term, per-user) is bootstrapped via the QR-pair flow
 * during `overwatch setup`. The cloud orchestrator presents a per-session token
 * derived as HMAC(pairing_token, session_id || expires_at). The daemon verifies
 * the HMAC and the expiry.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionTokenClaims {
  session_id: string;
  expires_at: number; // unix seconds
}

export interface TokenValidator {
  /**
   * Issue a per-session token. Used in tests and for daemon-side simulation;
   * in production, the phone derives the token and presents it to the
   * orchestrator who then forwards on commands.
   */
  issue(claims: SessionTokenClaims): string;

  /** Verify a presented session token. Returns claims on success, null on failure. */
  verify(token: string): SessionTokenClaims | null;
}

export function createTokenValidator(pairingToken: string): TokenValidator {
  if (!pairingToken) {
    throw new Error("token-validator: empty pairing token");
  }

  const sign = (payload: string): string =>
    createHmac("sha256", pairingToken).update(payload).digest("hex");

  return {
    issue(claims) {
      const payload = `${claims.session_id}|${claims.expires_at}`;
      const signature = sign(payload);
      return `${payload}|${signature}`;
    },

    verify(token) {
      if (!token || typeof token !== "string") return null;
      const parts = token.split("|");
      if (parts.length !== 3) return null;
      const [session_id, expiresStr, signature] = parts;
      const expires_at = Number.parseInt(expiresStr, 10);
      if (!Number.isFinite(expires_at)) return null;

      const expected = sign(`${session_id}|${expires_at}`);
      const a = Buffer.from(signature, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

      const now = Math.floor(Date.now() / 1000);
      if (expires_at < now) return null;

      return { session_id, expires_at };
    },
  };
}
