/**
 * Pairing store tests — focused on the pure HMAC derivation logic.
 * The AsyncStorage-backed persistence flow is exercised by the conversation
 * store tests + the integration tests against the real relay.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";

// Force the global crypto.subtle path used by deriveSessionToken inside the
// store. Node 25 has it natively, but we still want to verify the hex output
// shape matches what the daemon's TokenValidator expects.

import { deriveSessionToken } from "../src/stores/pairing-store.js";

test("pairing.deriveSessionToken: format is session_id|expires|hex_signature", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const token = await deriveSessionToken("master-secret", "session-1", 60);
    const parts = token.split("|");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], "session-1");
    assert.equal(parts[1], "1700000060"); // 1.7e9 ms / 1000 + 60
    assert.equal(parts[2].length, 64); // SHA-256 hex
  } finally {
    Date.now = realNow;
  }
});

test("pairing.deriveSessionToken: deterministic for same inputs", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const a = await deriveSessionToken("k", "s", 60);
    const b = await deriveSessionToken("k", "s", 60);
    assert.equal(a, b);
  } finally {
    Date.now = realNow;
  }
});

test("pairing.deriveSessionToken: different secrets produce different tokens", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const a = await deriveSessionToken("alpha", "s", 60);
    const b = await deriveSessionToken("beta", "s", 60);
    assert.notEqual(a, b);
    // Same session_id + expiry, different signature.
    assert.equal(a.split("|")[0], b.split("|")[0]);
    assert.equal(a.split("|")[1], b.split("|")[1]);
    assert.notEqual(a.split("|")[2], b.split("|")[2]);
  } finally {
    Date.now = realNow;
  }
});

test("pairing.deriveSessionToken: signature matches RFC 2104 HMAC-SHA256", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const secret = "k";
    const token = await deriveSessionToken(secret, "s", 60);
    const [sessionId, expires, signature] = token.split("|");
    const expected = createHmac("sha256", secret)
      .update(`${sessionId}|${expires}`)
      .digest("hex");
    assert.equal(signature, expected);
  } finally {
    Date.now = realNow;
  }
});

test("pairing.deriveSessionToken: daemon's TokenValidator can verify", async () => {
  // The daemon's verify expects the same shape and recomputes the HMAC.
  // We simulate that path here to confirm wire compatibility without
  // pulling the daemon module into the mobile test file.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const secret = "shared-pairing-token";
    const token = await deriveSessionToken(secret, "user-1", 3600);
    const [sessionId, expires, signature] = token.split("|");

    const expected = createHmac("sha256", secret)
      .update(`${sessionId}|${expires}`)
      .digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    assert.equal(a.length, b.length);
    assert.ok(a.equals(b));
  } finally {
    Date.now = realNow;
  }
});
