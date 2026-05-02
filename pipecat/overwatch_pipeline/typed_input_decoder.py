"""TypedInputDecoder — turns mobile InputBar text into UserTextInputFrame.

The mobile client calls `client.sendClientMessage("user_text", {text: "..."})`
which Pipecat sends as an RTVI server-message over the Daily data channel.
On the server side, Daily transport surfaces inbound app-messages as
`InputTransportMessageFrame(message=...)`. We decode them here and emit
`UserTextInputFrame(text=...)` which the HarnessBridgeProcessor consumes.

Without this processor, typed text from the InputBar reaches the pipeline's
input but is never converted into something the bridge knows how to handle.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import Frame, InputTransportMessageFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .frames import UserTextInputFrame


class TypedInputDecoder(FrameProcessor):
    """Forward all frames; in addition, when an InputTransportMessageFrame
    carries `{type: "user_text", text: "..."}`, push a UserTextInputFrame
    downstream so the bridge can dispatch it as a harness command.
    """

    async def process_frame(
        self, frame: Frame, direction: FrameDirection
    ) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InputTransportMessageFrame):
            message = frame.message
            text = self._extract_user_text(message)
            if text:
                logger.info("typed_input.user_text len={}", len(text))
                await self.push_frame(
                    UserTextInputFrame(text=text), FrameDirection.DOWNSTREAM
                )
                # Don't forward the InputTransportMessageFrame itself —
                # the rest of the pipeline doesn't care.
                return

        await self.push_frame(frame, direction)

    @staticmethod
    def _extract_user_text(message: object) -> str | None:
        if not isinstance(message, dict):
            return None
        # Two shapes are possible depending on how Pipecat's RTVI client
        # frames the message — accept both.
        msg_type = message.get("type") or message.get("t")
        if msg_type == "user_text":
            text = message.get("text") or message.get("d", {}).get("text")
            if isinstance(text, str) and text.strip():
                return text
        # Pipecat client wraps in {label, type, data} for RTVI client messages.
        if message.get("label") == "rtvi-ai" and message.get("type") == "client-message":
            data = message.get("data") or {}
            if isinstance(data, dict) and data.get("t") == "user_text":
                inner = data.get("d") or {}
                text = inner.get("text") if isinstance(inner, dict) else None
                if isinstance(text, str) and text.strip():
                    return text
        return None
