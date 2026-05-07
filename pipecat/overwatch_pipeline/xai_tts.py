"""Overwatch xAI TTS adapter.

Pipecat ships the actual streaming xAI WebSocket service. This subclass keeps
Overwatch-specific defaults and xAI's latency query parameter close to our
provider selection code without forking the client implementation.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from pipecat.services.xai.tts import (
    XAITTSService as PipecatXAITTSService,
)
from pipecat.services.xai.tts import (
    language_to_xai_language,
)
from pipecat.transcriptions.language import Language


class OverwatchXAITTSService(PipecatXAITTSService):
    """Streaming xAI TTS with Overwatch's low-latency URL options."""

    def __init__(
        self,
        *,
        optimize_streaming_latency: bool = True,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._optimize_streaming_latency = optimize_streaming_latency

    def _build_url(self) -> str:
        language = self._settings.language
        if isinstance(language, Language):
            language_value = language_to_xai_language(language) or language.value
        else:
            language_value = str(language) if language is not None else "auto"

        params: dict[str, Any] = {
            "voice": self._settings.voice,
            "language": language_value,
            "codec": self._codec,
            "sample_rate": self.sample_rate,
        }
        if self._optimize_streaming_latency:
            params["optimize_streaming_latency"] = 1

        return f"{self._base_url}?{urlencode(params)}"
