"""HarnessRouterProcessor — turns inbound HarnessEventFrames into outbound
TTS / server-message / inject-buffer / drop actions per the registry.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .deferred_update_buffer import DeferredUpdateBuffer
from .frames import HarnessEventFrame, ServerMessageOutFrame
from .harness_router import lookup_config


class HarnessRouterProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        deferred_buffer: DeferredUpdateBuffer,
        default_mode: str = "dev",
    ) -> None:
        super().__init__()
        self._buffer = deferred_buffer
        self._default_mode = default_mode

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if not isinstance(frame, HarnessEventFrame):
            await self.push_frame(frame, direction)
            return

        await self._dispatch(frame)

    async def _dispatch(self, frame: HarnessEventFrame) -> None:
        # The .root of the RootModel is the actual variant.
        # mode="json" ensures Enum fields (like ToolLifecycle.phase) serialize
        # to plain strings so the registry's "tool_lifecycle:start" lookup works.
        root = frame.event.root
        event_dict = root.model_dump(mode="json")
        cfg = lookup_config(event_dict, default_mode=self._default_mode)

        action = cfg.voice_action

        if action == "drop":
            logger.debug(
                "router.drop",
                type=event_dict.get("type"),
                provider=event_dict.get("provider"),
                kind=event_dict.get("kind"),
            )
            return

        if action == "speak":
            text = self._extract_text(event_dict)
            if text:
                # LLMTextFrame (Pipecat's standard text frame) flows into TTS.
                await self.push_frame(LLMTextFrame(text), FrameDirection.DOWNSTREAM)
            else:
                logger.debug("router.speak_no_text", event=event_dict.get("type"))
            return

        if action == "inject":
            text = self._extract_text(event_dict)
            if text:
                self._buffer.append(
                    text=text,
                    source=event_dict.get("provider", "harness"),
                    kind=event_dict.get("type", "event"),
                    priority=cfg.priority,
                )
            return

        # ui-only
        await self.push_frame(
            ServerMessageOutFrame(
                message={"type": "harness_event", "event": event_dict},  # type: ignore[arg-type]
            ),
            FrameDirection.DOWNSTREAM,
        )

    @staticmethod
    def _extract_text(event: dict) -> str:
        """Pull a speakable / injectable text representation from the event.

        Resolution order:
        1. Top-level text/message string fields.
        2. tool_lifecycle phases get synthesized phrases.
        3. provider_event payload.message or payload.text.
        4. Top-level result if it's a string.
        """
        for key in ("text", "message"):
            value = event.get(key)
            if isinstance(value, str) and value.strip():
                return value

        if event.get("type") == "tool_lifecycle":
            phase = event.get("phase", "")
            name = event.get("name", "tool")
            if phase == "start":
                return f"Running {name}."
            if phase == "complete":
                return f"{name} completed."
            return ""

        if event.get("type") == "provider_event":
            payload = event.get("payload") or {}
            if isinstance(payload, dict):
                for key in ("message", "text"):
                    value = payload.get(key)
                    if isinstance(value, str) and value.strip():
                        return value

        result = event.get("result")
        if isinstance(result, str) and result.strip():
            return result

        return ""
