from __future__ import annotations

import pytest

from overwatch_pipeline.settings import Settings, load
from overwatch_pipeline.stt_provider import create_stt_service, select_stt_provider


def test_select_stt_provider_defaults_to_deepgram() -> None:
    settings = Settings(deepgram_api_key="deepgram", cartesia_api_key="cartesia")

    assert select_stt_provider(settings) == "deepgram"


def test_select_stt_provider_uses_global_xai() -> None:
    settings = Settings(
        xai_api_key="xai",
        stt_provider="xai",
    )

    assert select_stt_provider(settings) == "xai"


def test_select_stt_provider_uses_session_request() -> None:
    settings = Settings(
        deepgram_api_key="deepgram",
        xai_api_key="xai",
        stt_provider="deepgram",
    )

    assert select_stt_provider(settings, requested_provider="xai") == "xai"
    assert select_stt_provider(settings, requested_provider="deepgram") == "deepgram"


def test_select_stt_provider_normalizes_grok_to_xai() -> None:
    settings = Settings(xai_api_key="xai", stt_provider="deepgram")

    assert select_stt_provider(settings, requested_provider="grok") == "xai"
    assert select_stt_provider(settings, requested_provider="Grok") == "xai"


def test_select_stt_provider_rejects_unknown() -> None:
    settings = Settings(deepgram_api_key="dg")

    with pytest.raises(RuntimeError, match="unsupported STT provider"):
        select_stt_provider(settings, requested_provider="whisper")


def test_load_requires_deepgram_for_deepgram_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("STT_PROVIDER", raising=False)
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)

    with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY"):
        load()


def test_load_does_not_require_deepgram_when_xai_stt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "xai")
    monkeypatch.setenv("XAI_API_KEY", "xai")
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia")
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)

    settings = load()

    assert settings.stt_provider == "xai"
    assert settings.deepgram_api_key == ""
    assert settings.xai_api_key == "xai"


def test_load_requires_xai_when_xai_stt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "xai")
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)

    with pytest.raises(RuntimeError, match="XAI_API_KEY"):
        load()


def test_load_accepts_grok_as_stt_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_PROVIDER", "grok")
    monkeypatch.setenv("XAI_API_KEY", "xai")
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia")
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)

    settings = load()
    assert settings.stt_provider == "xai"


def test_create_deepgram_stt_service() -> None:
    settings = Settings(
        deepgram_api_key="dg-key",
        cartesia_api_key="cartesia",
        stt_provider="deepgram",
        stt_endpointing_ms=1000,
        stt_utterance_end_ms=2000,
    )

    service = create_stt_service(settings)
    from pipecat.services.deepgram.stt import DeepgramSTTService

    assert isinstance(service, DeepgramSTTService)


def test_create_xai_stt_service() -> None:
    settings = Settings(
        xai_api_key="xai-key",
        stt_provider="xai",
        xai_stt_language="en",
        stt_endpointing_ms=500,
    )

    service = create_stt_service(settings)
    from pipecat.services.xai.stt import XAISTTService

    assert isinstance(service, XAISTTService)


def test_create_stt_service_requires_key() -> None:
    settings = Settings(stt_provider="xai", xai_api_key="")

    with pytest.raises(RuntimeError, match="XAI_API_KEY"):
        create_stt_service(settings)

    settings2 = Settings(stt_provider="deepgram", deepgram_api_key="")

    with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY"):
        create_stt_service(settings2)
