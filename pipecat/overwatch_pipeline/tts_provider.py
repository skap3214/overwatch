"""TTS provider selection and construction."""

from __future__ import annotations

from pipecat.processors.frame_processor import FrameProcessor

from .settings import Settings
from .voices import resolve_voice_id
from .xai_tts import OverwatchXAITTSService


def select_tts_provider(
    settings: Settings,
    requested_provider: str | None = None,
) -> str:
    """Resolve the TTS provider for one orchestrator session."""
    provider = (requested_provider or settings.tts_provider).strip().lower()
    if provider not in {"cartesia", "xai"}:
        raise RuntimeError(f"unsupported TTS provider: {provider}")
    return provider


def create_tts_service(
    settings: Settings,
    requested_provider: str | None = None,
) -> FrameProcessor:
    """Create the configured Pipecat TTS service for a session."""
    provider = select_tts_provider(settings, requested_provider)

    if provider == "xai":
        if not settings.xai_api_key:
            raise RuntimeError("XAI_API_KEY is required when tts_provider is xai")
        return OverwatchXAITTSService(
            api_key=settings.xai_api_key,
            sample_rate=settings.xai_tts_sample_rate,
            optimize_streaming_latency=settings.xai_tts_optimize_streaming_latency,
            settings=OverwatchXAITTSService.Settings(
                voice=settings.xai_tts_voice,
                language=settings.xai_tts_language,
            ),
        )

    if provider == "cartesia":
        if not settings.cartesia_api_key:
            raise RuntimeError("CARTESIA_API_KEY is required when tts_provider is cartesia")
        from pipecat.services.cartesia.tts import CartesiaTTSService

        return CartesiaTTSService(
            api_key=settings.cartesia_api_key,
            voice_id=resolve_voice_id(settings.cartesia_voice_id),
        )

    raise RuntimeError(f"unsupported TTS provider: {provider}")
