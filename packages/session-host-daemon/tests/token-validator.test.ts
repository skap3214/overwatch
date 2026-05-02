import { test } from "node:test";
import assert from "node:assert/strict";

import { createTokenValidator } from "../src/adapter-protocol/token-validator.js";

test("token-validator: round-trip succeeds for valid token", () => {
  const v = createTokenValidator("secret-pairing-token");
  const token = v.issue({
    session_id: "session-1",
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });
  const claims = v.verify(token);
  assert.equal(claims?.session_id, "session-1");
});

test("token-validator: rejects expired tokens", () => {
  const v = createTokenValidator("secret");
  const token = v.issue({
    session_id: "session-1",
    expires_at: Math.floor(Date.now() / 1000) - 1,
  });
  assert.equal(v.verify(token), null);
});

test("token-validator: rejects tampered signatures", () => {
  const v = createTokenValidator("secret");
  const token = v.issue({
    session_id: "session-1",
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });
  const parts = token.split("|");
  parts[2] = parts[2].replace(/^./, (c) => (c === "0" ? "1" : "0"));
  const tampered = parts.join("|");
  assert.equal(v.verify(tampered), null);
});

test("token-validator: rejects malformed tokens", () => {
  const v = createTokenValidator("secret");
  assert.equal(v.verify(""), null);
  assert.equal(v.verify("not-a-token"), null);
  assert.equal(v.verify("a|b"), null);
});

test("token-validator: rejects token signed by a different secret", () => {
  const a = createTokenValidator("alpha");
  const b = createTokenValidator("beta");
  const token = a.issue({
    session_id: "s",
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });
  assert.equal(b.verify(token), null);
});
