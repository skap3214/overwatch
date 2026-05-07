from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from overwatch_pipeline.settings import Settings, load
from overwatch_pipeline.tts_provider import create_tts_service, select_tts_provider
from overwatch_pipeline.xai_tts import OverwatchXAITTSService


def test_select_tts_provider_defaults_to_cartesia() -> None:
    settings = Settings(deepgram_api_key="deepgram", cartesia_api_key="cartesia")

    assert select_tts_provider(settings) == "cartesia"


def test_select_tts_provider_uses_global_xai() -> None:
    settings = Settings(
        deepgram_api_key="deepgram",
        xai_api_key="xai",
        tts_provider="xai",
    )

    assert select_tts_provider(settings) == "xai"


def test_select_tts_provider_uses_session_request() -> None:
    settings = Settings(
        deepgram_api_key="deepgram",
        cartesia_api_key="cartesia",
        xai_api_key="xai",
        tts_provider="cartesia",
    )

    assert select_tts_provider(settings, requested_provider="xai") == "xai"
    assert select_tts_provider(settings, requested_provider="cartesia") == "cartesia"


def test_load_requires_cartesia_for_cartesia_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram")
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    monkeypatch.delenv("STT_PROVIDER", raising=False)

    with pytest.raises(RuntimeError, match="CARTESIA_API_KEY"):
        load()


def test_load_requires_xai_only_when_xai_is_selectable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram")
    monkeypatch.setenv("TTS_PROVIDER", "xai")
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("STT_PROVIDER", raising=False)

    with pytest.raises(RuntimeError, match="XAI_API_KEY"):
        load()

    monkeypatch.setenv("XAI_API_KEY", "xai")

    settings = load()

    assert settings.tts_provider == "xai"
    assert settings.cartesia_api_key == ""
    assert settings.xai_api_key == "xai"


def test_create_xai_tts_service_sets_voice_language_and_latency_query() -> None:
    settings = Settings(
        deepgram_api_key="deepgram",
        xai_api_key="xai",
        tts_provider="xai",
        xai_tts_voice="eve",
        xai_tts_language="en",
        xai_tts_sample_rate=24000,
        xai_tts_optimize_streaming_latency=True,
    )

    service = create_tts_service(settings, requested_provider="xai")

    assert isinstance(service, OverwatchXAITTSService)
    service._sample_rate = 24000  # noqa: SLF001 - normally set by StartFrame.
    url = service._build_url()  # noqa: SLF001
    params = parse_qs(urlparse(url).query)
    assert params["voice"] == ["eve"]
    assert params["language"] == ["en"]
    assert params["codec"] == ["pcm"]
    assert params["sample_rate"] == ["24000"]
    assert params["optimize_streaming_latency"] == ["1"]
