"""Python mirror of the TS daemon's TokenValidator.

The phone derives a per-session token at session-start time as:

    sig = HMAC-SHA256(pairing_token, f"{session_id}|{expires_at}")
    token = f"{session_id}|{expires_at}|{sig.hex()}"

The relay forwards the token verbatim to Pipecat Cloud's session-start API,
which surfaces it to the bot via `runner_args.body.session_token`. The bot
forwards it again on every harness_command envelope; the daemon's
`createTokenValidator` (TS) verifies HMAC + expiry there.

This module exists so the orchestrator can also check the token at its own
boundary — refuse to start the pipeline at all when the token is expired or
signed with the wrong pairing secret. Without this, a tampered token rides
all the way to the daemon before being rejected, leaving the user staring
at a dead Daily room.

Wire format must match TS exactly. See:
- packages/session-host-daemon/src/adapter-protocol/token-validator.ts
- overwatch-mobile/src/services/session-token.ts
- tests/cross-runtime-token-contract.test.ts
"""

from __future__ import annotations

import hmac
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Protocol


@dataclass(frozen=True)
class SessionTokenClaims:
    session_id: str
    expires_at: int  # unix seconds


class TokenValidator(Protocol):
    def issue(self, claims: SessionTokenClaims) -> str: ...
    def verify(self, token: str) -> SessionTokenClaims | None: ...


def create_token_validator(pairing_token: str) -> TokenValidator:
    if not pairing_token:
        raise ValueError("token-validator: empty pairing token")
    secret = pairing_token.encode("utf-8")

    def _sign(payload: str) -> str:
        return hmac.new(secret, payload.encode("utf-8"), sha256).hexdigest()

    class _Impl:
        def issue(self, claims: SessionTokenClaims) -> str:
            payload = f"{claims.session_id}|{claims.expires_at}"
            return f"{payload}|{_sign(payload)}"

        def verify(self, token: str) -> SessionTokenClaims | None:
            if not isinstance(token, str) or not token:
                return None
            parts = token.split("|")
            if len(parts) != 3:
                return None
            session_id, expires_str, signature = parts
            try:
                expires_at = int(expires_str)
            except ValueError:
                return None

            expected = _sign(f"{session_id}|{expires_at}")
            # hmac.compare_digest is constant-time.
            if not hmac.compare_digest(signature, expected):
                return None

            if expires_at < int(time.time()):
                return None

            return SessionTokenClaims(session_id=session_id, expires_at=expires_at)

    return _Impl()
