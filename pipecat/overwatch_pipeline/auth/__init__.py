"""Auth surface for the orchestrator.

Currently exposes a single Python TokenValidator that mirrors the TS daemon's
verification logic. Used at orchestrator boundary (bot.py) to refuse
expired / tampered phone-derived tokens before forwarding them to the daemon.
"""

from .token_validator import (
    SessionTokenClaims,
    TokenValidator,
    create_token_validator,
)

__all__ = ["SessionTokenClaims", "TokenValidator", "create_token_validator"]
