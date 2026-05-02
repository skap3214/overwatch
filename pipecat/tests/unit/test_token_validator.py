"""Unit tests for the orchestrator-side TokenValidator.

Cross-runtime wire compatibility with the TS daemon is covered by
`tests/cross-runtime-token-contract.test.ts` at the repo root; this file
covers Python-only behaviors (round-trip, tamper, expiry, malformed input).
"""

from __future__ import annotations

import time

import pytest

from overwatch_pipeline.auth import (
    SessionTokenClaims,
    create_token_validator,
)


def test_round_trip_valid_token() -> None:
    v = create_token_validator("pairing-secret")
    token = v.issue(SessionTokenClaims(session_id="s1", expires_at=int(time.time()) + 60))
    claims = v.verify(token)
    assert claims is not None
    assert claims.session_id == "s1"


def test_rejects_tampered_signature() -> None:
    v = create_token_validator("pairing-secret")
    token = v.issue(SessionTokenClaims(session_id="s1", expires_at=int(time.time()) + 60))
    # Flip the last hex char of the signature.
    last = token[-1]
    flipped = "1" if last == "0" else "0"
    tampered = token[:-1] + flipped
    assert v.verify(tampered) is None


def test_rejects_wrong_pairing_secret() -> None:
    a = create_token_validator("alpha")
    b = create_token_validator("beta")
    token_a = a.issue(SessionTokenClaims(session_id="s1", expires_at=int(time.time()) + 60))
    assert b.verify(token_a) is None


def test_rejects_expired_token() -> None:
    v = create_token_validator("pairing-secret")
    token = v.issue(SessionTokenClaims(session_id="s1", expires_at=int(time.time()) - 1))
    assert v.verify(token) is None


def test_rejects_malformed_token() -> None:
    v = create_token_validator("pairing-secret")
    assert v.verify("") is None
    assert v.verify("only-two|parts") is None
    assert v.verify("a|not-a-number|deadbeef") is None


def test_empty_pairing_token_rejected_at_construction() -> None:
    with pytest.raises(ValueError):
        create_token_validator("")
