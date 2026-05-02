/**
 * Cross-runtime contract test: phone-derived session_token validates by daemon.
 *
 * This is the real wire-compatibility check that the previous test in
 * `overwatch-mobile/tests/pairing-store.test.ts` failed to do — it
 * re-implemented HMAC inline instead of importing the daemon's actual
 * TokenValidator. If the daemon ever changes its verification logic, that
 * test still passes; this one would catch it.
 *
 * The test imports both sides:
 *   - mobile: `deriveSessionToken` from `overwatch-mobile/src/stores/pairing-store`
 *   - daemon: `createTokenValidator` from
 *             `packages/session-host-daemon/src/adapter-protocol/token-validator`
 *
 * and asserts the round-trip works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Dynamic imports because the mobile package is CJS (no "type":"module")
// and this test file lives under the ESM-flavored repo root. tsx still
// transforms both, but ESM-from-CJS interop only works through
// dynamic-import or `import * as ns from`. Sticking with dynamic keeps the
// path explicit and dependency-free.
async function importMobile() {
  const m = (await import(
    "../overwatch-mobile/src/services/session-token.js"
  )) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  // tsx interop: both .deriveSessionToken (named) and .default.deriveSessionToken (CJS-default-wrap)
  // depending on resolver mode. Prefer the direct named export when present.
  return (m.deriveSessionToken ??
    m.default?.deriveSessionToken) as (
    pairingToken: string,
    sessionId: string,
    ttlSeconds?: number,
  ) => Promise<string>;
}

async function importDaemon() {
  const m = (await import(
    "../packages/session-host-daemon/src/adapter-protocol/token-validator.js"
  )) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  return (m.createTokenValidator ??
    m.default?.createTokenValidator) as (
    pairingToken: string,
  ) => {
    issue(claims: { session_id: string; expires_at: number }): string;
    verify(token: string): { session_id: string; expires_at: number } | null;
  };
}

test("contract: phone derives session_token; daemon TokenValidator verifies", async () => {
  const deriveSessionToken = await importMobile();
  const createTokenValidator = await importDaemon();

  const pairingToken = "shared-pairing-secret-from-qr-pairing";
  const validator = createTokenValidator(pairingToken);

  const sessionToken = await deriveSessionToken(pairingToken, "session-1", 3600);
  const claims = validator.verify(sessionToken);

  assert.ok(claims, "daemon must accept phone-derived token");
  assert.equal(claims.session_id, "session-1");
});

test("contract: tampered phone token is rejected by daemon", async () => {
  const deriveSessionToken = await importMobile();
  const createTokenValidator = await importDaemon();

  const pairingToken = "alpha-secret";
  const validator = createTokenValidator(pairingToken);

  const sessionToken = await deriveSessionToken(pairingToken, "s", 3600);
  const parts = sessionToken.split("|");
  parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("0") ? "1" : "0");
  const tampered = parts.join("|");
  assert.equal(validator.verify(tampered), null);
});

test("contract: token signed with wrong pairing token is rejected", async () => {
  const deriveSessionToken = await importMobile();
  const createTokenValidator = await importDaemon();

  const validatorA = createTokenValidator("alpha-secret");
  const wrongToken = await deriveSessionToken("beta-secret", "s", 3600);
  assert.equal(validatorA.verify(wrongToken), null);
});

test("contract: expired phone token is rejected", async () => {
  const deriveSessionToken = await importMobile();
  const createTokenValidator = await importDaemon();

  const pairingToken = "alpha-secret";
  const validator = createTokenValidator(pairingToken);
  const sessionToken = await deriveSessionToken(pairingToken, "s", -10);
  assert.equal(validator.verify(sessionToken), null);
});
