"""STT provider selection and construction."""

from __future__ import annotations

from pipecat.processors.frame_processor import FrameProcessor

from .settings import Settings


def select_stt_provider(
    settings: Settings,
    requested_provider: str | None = None,
) -> str:
    """Resolve the STT provider for one orchestrator session."""
    provider = (requested_provider or settings.stt_provider).strip().lower()
    if provider == "grok":
        provider = "xai"
    if provider not in {"deepgram", "xai"}:
        raise RuntimeError(f"unsupported STT provider: {provider}")
    return provider


def create_stt_service(
    settings: Settings,
    requested_provider: str | None = None,
) -> FrameProcessor:
    """Create the configured Pipecat STT service for a session."""
    provider = select_stt_provider(settings, requested_provider)

    if provider == "xai":
        if not settings.xai_api_key:
            raise RuntimeError("XAI_API_KEY is required when stt_provider is xai")
        from pipecat.services.xai.stt import XAISTTService

        return XAISTTService(
            api_key=settings.xai_api_key,
            settings=XAISTTService.Settings(
                language=settings.xai_stt_language,
                interim_results=True,
                endpointing=settings.stt_endpointing_ms,
            ),
        )

    if provider == "deepgram":
        if not settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is required when stt_provider is deepgram")
        from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings

        stt_settings_kwargs: dict = {
            "model": "nova-3",
            "interim_results": True,
            "endpointing": settings.stt_endpointing_ms,
            "utterance_end_ms": settings.stt_utterance_end_ms,
        }
        if settings.stt_keyterms:
            stt_settings_kwargs["keyterm"] = list(settings.stt_keyterms)
        return DeepgramSTTService(
            api_key=settings.deepgram_api_key,
            settings=DeepgramSTTSettings(**stt_settings_kwargs),
        )

    raise RuntimeError(f"unsupported STT provider: {provider}")
