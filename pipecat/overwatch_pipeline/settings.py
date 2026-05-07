"""Centralised env-driven configuration for the orchestrator."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# Default Deepgram keyterm-prompting list. Nova-3 only — see
# https://developers.deepgram.com/docs/keyterm. Each term biases recognition
# toward that token; useful for tool/agent/project names that mainstream
# language models routinely garble (e.g. "tmux" → "T-Mucks", "Hermes" →
# "her means", "Codex" → "Co-decks"). Kept well under the 500-token cap.
# Override at runtime with STT_KEYTERMS="term1,term2,multi word" — the env
# value REPLACES the defaults so you can scope it tightly per deployment.
DEFAULT_STT_KEYTERMS: tuple[str, ...] = (
    # Tool / agent surface
    "tmux",
    "Claude Code",
    "Codex",
    "Hermes",
    "pi-coding-agent",
    "Overwatch",
    "Pipecat",
    "Cartesia",
    "Deepgram",
    "Anthropic",
    "Cloudflare",
    "Daily",
    # Terminal emulators users name in voice
    "Ghostty",
    "Alacritty",
    "iTerm",
    "kitty",
    # Stack jargon
    "WebRTC",
    "TypeScript",
    "Hono",
    "Expo",
    "zsh",
    "bash",
)


@dataclass(frozen=True)
class Settings:
    # ─── Voice providers ────────────────────────────────────────────────────
    deepgram_api_key: str = ""
    cartesia_api_key: str = ""
    xai_api_key: str = ""
    stt_provider: str = "deepgram"
    # Deepgram Nova-3 keyterm-prompting list. See DEFAULT_STT_KEYTERMS above.
    stt_keyterms: tuple[str, ...] = DEFAULT_STT_KEYTERMS
    stt_endpointing_ms: int = 1000
    stt_utterance_end_ms: int = 2000
    tts_provider: str = "cartesia"

    # ─── xAI STT ────────────────────────────────────────────────────────────
    xai_stt_language: str = "en"

    # ─── Cartesia voice ─────────────────────────────────────────────────────
    cartesia_voice_id: str = "a0e99841-438c-4a64-b679-ae501e7d6091"  # Cartesia "Brooke"

    # ─── xAI voice ──────────────────────────────────────────────────────────
    xai_tts_voice: str = "eve"
    xai_tts_language: str = "en"
    xai_tts_sample_rate: int | None = None
    xai_tts_optimize_streaming_latency: bool = True

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
    stt_provider = _parse_stt_provider(os.getenv("STT_PROVIDER"))
    tts_provider = _parse_tts_provider(os.getenv("TTS_PROVIDER"))
    needs_xai = stt_provider == "xai" or tts_provider == "xai"
    return Settings(
        deepgram_api_key=_required_if("DEEPGRAM_API_KEY", stt_provider == "deepgram"),
        cartesia_api_key=_required_if(
            "CARTESIA_API_KEY",
            tts_provider == "cartesia",
        ),
        xai_api_key=_required_if("XAI_API_KEY", needs_xai),
        stt_provider=stt_provider,
        stt_keyterms=_parse_keyterms(os.getenv("STT_KEYTERMS")),
        stt_endpointing_ms=int(os.getenv("STT_ENDPOINTING_MS", "1000")),
        stt_utterance_end_ms=int(os.getenv("STT_UTTERANCE_END_MS", "2000")),
        tts_provider=tts_provider,
        xai_stt_language=os.getenv("XAI_STT_LANGUAGE", Settings.xai_stt_language),
        cartesia_voice_id=os.getenv(
            "CARTESIA_VOICE_ID", Settings.cartesia_voice_id
        ),
        xai_tts_voice=os.getenv("XAI_TTS_VOICE", Settings.xai_tts_voice),
        xai_tts_language=os.getenv("XAI_TTS_LANGUAGE", Settings.xai_tts_language),
        xai_tts_sample_rate=_parse_optional_int(os.getenv("XAI_TTS_SAMPLE_RATE")),
        xai_tts_optimize_streaming_latency=_parse_bool(
            os.getenv("XAI_TTS_OPTIMIZE_STREAMING_LATENCY"),
            default=Settings.xai_tts_optimize_streaming_latency,
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


def _required_if(key: str, condition: bool) -> str:
    if not condition:
        return os.getenv(key, "")
    return _required(key)


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


def _parse_keyterms(raw: str | None) -> tuple[str, ...]:
    """STT_KEYTERMS env override.

    Empty / unset → use DEFAULT_STT_KEYTERMS.
    Set to "" or "off" → disable keyterm prompting entirely.
    Comma-separated values → use exactly those (replaces defaults).
    """
    if raw is None:
        return DEFAULT_STT_KEYTERMS
    stripped = raw.strip()
    if not stripped or stripped.lower() in {"off", "none", "false"}:
        return ()
    return tuple(t.strip() for t in stripped.split(",") if t.strip())


def _parse_stt_provider(raw: str | None) -> str:
    provider = (raw or "deepgram").strip().lower()
    if provider == "grok":
        provider = "xai"
    if provider not in {"deepgram", "xai"}:
        raise RuntimeError(
            "invalid STT_PROVIDER: "
            f"{provider!r} (expected 'deepgram' or 'xai')"
        )
    return provider


def _parse_tts_provider(raw: str | None) -> str:
    provider = (raw or "cartesia").strip().lower()
    if provider not in {"cartesia", "xai"}:
        raise RuntimeError(
            "invalid TTS_PROVIDER: "
            f"{provider!r} (expected 'cartesia' or 'xai')"
        )
    return provider


def _parse_optional_int(raw: str | None) -> int | None:
    if raw is None or not raw.strip():
        return None
    return int(raw)


def _parse_bool(raw: str | None, *, default: bool) -> bool:
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"invalid boolean value: {raw!r}")
