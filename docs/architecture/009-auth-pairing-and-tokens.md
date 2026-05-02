# 009 — Auth, Pairing, and Tokens

**Status:** Implemented (2026-05-02)
**Related:** [007-post-overhaul-architecture.md](007-post-overhaul-architecture.md)

There are two secrets in the system: a long-term **pairing token** and a per-session **session token**. The pairing token is set up once via QR; the session token is derived from it on every session and verified at every boundary it crosses.

## The two secrets

| Token | Lifetime | Issued by | Held by | Used for |
|---|---|---|---|---|
| `pairing_token` | Long (until rotated) | `overwatch setup` on the Mac | Phone, daemon, orchestrator (per session via the relay) | Authenticates the daemon's WebSocket to the relay; HMAC secret for session tokens |
| `session_token` | TTL ~1h | Phone (HMAC of `pairing_token`) | Phone, relay, orchestrator, daemon | Verified per-command on the daemon; verified at orchestrator boot |

Format of `session_token`:

```
{session_id}|{expires_at_unix_seconds}|{hex_hmac}

hex_hmac = HMAC-SHA256(pairing_token, "{session_id}|{expires_at}")
```

Wire-compatible across three runtimes:

| Where | Implementation |
|---|---|
| Phone (Web Crypto) | `overwatch-mobile/src/services/session-token.ts` |
| Daemon (Node `crypto`) | `packages/session-host-daemon/src/adapter-protocol/token-validator.ts` |
| Orchestrator (Python `hmac`) | `pipecat/overwatch_pipeline/auth/token_validator.py` |

The cross-runtime contract is locked in by `tests/cross-runtime-token-contract.test.ts` — it imports the mobile derive function and the daemon validator in a single Node process and asserts round-trip + tamper + expired + wrong-secret cases.

## Pairing flow

`overwatch setup` on the Mac:

1. Generates a `user_id` (or reuses the saved one).
2. Mints a high-entropy `pairing_token`.
3. Persists both to `~/.overwatch/config.json` and exports them as `OVERWATCH_USER_ID` / `ORCHESTRATOR_PAIRING_TOKEN` for the daemon process.
4. Renders a QR code containing `{relay_url, user_id, pairing_token}`.

The phone's QR scanner reads the payload, calls `pairingStore.setPairing({...})`, and persists to AsyncStorage (`overwatch_relay_url`, `overwatch_user_id`, `overwatch_pairing_token`).

After this, the phone, daemon, and orchestrator share a secret without ever passing it through Pipecat Cloud or Daily — only through the relay.

## Session start path

```
Phone                     Relay                       Pipecat Cloud              Bot
─────                     ─────                       ─────────────              ───
deriveSessionToken
  (pairing_token, sid)
                  ── /api/sessions/start ──>
                      {user_id, pairing_token,
                       session_token}
                                          ── POST /agents/<name>/start ──>
                                              body: {user_id, pairing_token,
                                                     session_token, default_target}
                                                                            spawn pod
                                                                            bot.py runs
                                                                            ▼
                                                                            create_token_validator
                                                                              (pairing_token)
                                                                            .verify(session_token)
                                                                            ▼
                                                                            (valid? proceed.
                                                                             invalid? RuntimeError,
                                                                             pod stops cleanly)
                  <── {daily_room_url, daily_token} ──
join Daily room ─────────────────────────────────────────────────────────────────>
```

The orchestrator's verification step is what catches expired or tampered tokens up-front, instead of letting the bot join a Daily room and then silently failing on the first harness command.

## Per-command verification (daemon)

Every envelope the daemon receives over `wss://relay/api/users/<id>/ws/host` carries `session_token`. `AdapterProtocolServer.onMessage` runs:

1. Protocol-version major check.
2. `session_token` present? Else `error_response: missing session_token`.
3. `tokens.verify(session_token)` returns claims or null. Null → `error_response: invalid or expired session_token`. Audit-log the rejection.
4. Command kind in `COMMAND_ALLOWLIST`? Else `error_response: command kind '<x>' not allowed`. Audit-log.
5. Dispatch.

Audit log: `~/.overwatch/audit.jsonl`. Every command — accepted or rejected — gets a line. Rotates by length (`AuditLog`), not by date.

## Why three validators

It would be tempting to verify only at the daemon. Three validators exists because each catches a different failure mode at the cheapest point:

| Validator | Catches |
|---|---|
| **Phone** (derive only, no verify) | Nothing — it's the issuer. |
| **Orchestrator** | Stale tokens from background reconnects, tampered tokens injected via a misbehaving relay, clock skew. Refuses to start the pipeline → user sees "Couldn't connect" instead of a frozen Daily room. |
| **Daemon** | Per-command guarantee. Even a malicious orchestrator (or a relay routing bug that misroutes a different user's commands) can't drive a harness without a token signed with this specific user's pairing secret. |

## Rotating the pairing token

Currently a manual operation: re-run `overwatch setup` on the Mac, re-pair the phone via QR. Existing in-flight session tokens become invalid the moment the daemon picks up the new pairing secret (HMAC stops matching).

There is no automatic rotation today. If we add it, the load-bearing constraint is that all three holders (phone, daemon, orchestrator's per-session view) must learn the new secret atomically — anything else opens a window of valid-but-rejected tokens.

## Threat model (in scope)

- Tampered envelopes via a compromised relay → daemon rejects per-command.
- Expired tokens lying around in mobile state → orchestrator rejects at boot.
- Token signed with a different pairing secret (e.g. wrong user's QR) → both validators reject.
- Replay of a captured `session_token` after expiry → orchestrator + daemon reject by `expires_at`.

## Threat model (out of scope today)

- TLS interception — mitigated by the `wss://` connections to Cloudflare and Pipecat Cloud, not by anything we add.
- Long-lived `session_token` replay within TTL — the TTL is 1h. If we needed shorter, the phone would have to remint mid-session. Not built.
- Compromise of the Mac's `~/.overwatch/config.json` → game over (attacker has the pairing token). The local file system is treated as trusted; the daemon doesn't run with privileged accounts.
- Cloudflare Workers secrets compromise → attacker can mint Pipecat Cloud sessions for any `user_id` they observe. They still can't drive the daemon without a valid `session_token`, which they can't sign without the pairing secret.

## Files

| Concern | File |
|---|---|
| Phone derive | `overwatch-mobile/src/services/session-token.ts` |
| Daemon verify | `packages/session-host-daemon/src/adapter-protocol/token-validator.ts` |
| Orchestrator verify | `pipecat/overwatch_pipeline/auth/token_validator.py` |
| Orchestrator boundary check | `pipecat/overwatch_pipeline/bot.py` (calls `create_token_validator(pairing_token).verify(session_token)`) |
| Daemon per-command | `packages/session-host-daemon/src/adapter-protocol/server.ts:onMessage` |
| Cross-runtime contract test | `tests/cross-runtime-token-contract.test.ts` |
| Daemon TS unit | `packages/session-host-daemon/tests/token-validator.test.ts` |
| Orchestrator Python unit | `pipecat/tests/unit/test_token_validator.py` |
| Audit log | `packages/session-host-daemon/src/adapter-protocol/audit-log.ts` |
