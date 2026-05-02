"""Centralised env-driven configuration for the orchestrator."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    # ─── Voice providers ────────────────────────────────────────────────────
    deepgram_api_key: str
    cartesia_api_key: str

    # ─── Cartesia voice ─────────────────────────────────────────────────────
    cartesia_voice_id: str = "a0e99841-438c-4a64-b679-ae501e7d6091"  # Cartesia "Brooke"

    # ─── Relay (orchestrator ↔ Mac daemon) ──────────────────────────────────
    relay_url: str = ""
    relay_namespace: str = "overwatch"

    # ─── Auth ───────────────────────────────────────────────────────────────
    # Per-user tokens are stored server-side per session, not as a global key.
    # This is the secret used to verify HMAC-derived per-session tokens from
    # the phone.
    session_token_secret: str = ""

    # ─── Inference gate tuning ──────────────────────────────────────────────
    cooldown_seconds: float = 2.0
    cancel_confirm_timeout_seconds: float = 2.0
    idle_report_threshold_seconds: float = 9.0
    idle_report_cooldown_seconds: float = 45.0

    # ─── Registry default policy ────────────────────────────────────────────
    # "dev" → unknown events route to ui-only; "prod" → drop. Never speak.
    registry_default_mode: str = "dev"

    # ─── Observability ──────────────────────────────────────────────────────
    sentry_dsn: str | None = None
    otel_endpoint: str | None = None
    otel_headers: dict[str, str] = field(default_factory=dict)

    # ─── Pipecat Cloud bookkeeping ──────────────────────────────────────────
    environment: str = "dev"  # "dev" | "alpha" | "prod"


def load() -> Settings:
    """Load settings from env. Pipecat Cloud injects secrets at container startup."""
    return Settings(
        deepgram_api_key=_required("DEEPGRAM_API_KEY"),
        cartesia_api_key=_required("CARTESIA_API_KEY"),
        cartesia_voice_id=os.getenv(
            "CARTESIA_VOICE_ID", Settings.cartesia_voice_id
        ),
        relay_url=os.getenv("RELAY_URL", ""),
        relay_namespace=os.getenv("RELAY_NAMESPACE", "overwatch"),
        session_token_secret=os.getenv("SESSION_TOKEN_SECRET", ""),
        cooldown_seconds=float(os.getenv("COOLDOWN_SECONDS", "2.0")),
        cancel_confirm_timeout_seconds=float(
            os.getenv("CANCEL_CONFIRM_TIMEOUT_SECONDS", "2.0")
        ),
        idle_report_threshold_seconds=float(
            os.getenv("IDLE_REPORT_THRESHOLD_SECONDS", "9.0")
        ),
        idle_report_cooldown_seconds=float(
            os.getenv("IDLE_REPORT_COOLDOWN_SECONDS", "45.0")
        ),
        registry_default_mode=os.getenv("REGISTRY_DEFAULT_MODE", "dev"),
        sentry_dsn=os.getenv("SENTRY_DSN") or None,
        otel_endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
        otel_headers=_parse_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS")),
        environment=os.getenv("ENVIRONMENT", "dev"),
    )


def _required(key: str) -> str:
    value = os.getenv(key)
    if not value:
        raise RuntimeError(f"missing required environment variable: {key}")
    return value


def _parse_headers(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    out: dict[str, str] = {}
    for pair in raw.split(","):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        out[k.strip()] = v.strip()
    return out
