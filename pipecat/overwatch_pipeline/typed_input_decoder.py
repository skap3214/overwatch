"""TypedInputDecoder — turns mobile RTVI client-messages into pipeline frames.

Pipecat Cloud auto-injects an `RTVIProcessor` into our pipeline. That
processor consumes raw `InputTransportMessageFrame`s coming from the Daily
data channel and re-emits them as `RTVIClientMessageFrame` (with `msg_id`,
`type`, `data`). So we listen for *that* frame, not the raw transport one
— otherwise the message is silently dropped before reaching us.

We currently decode two client-message types:

- ``user_text {text}`` → ``UserTextInputFrame(text=...)`` so the bridge
  dispatches a typed turn (no STT involved).
- ``interrupt_intent {}`` → broadcast ``InterruptionFrame`` immediately so
  in-flight TTS and queued output audio are cancelled without waiting for VAD
  to detect the user's voice. PTT-button presses call this on press, so audio
  from the previous turn cuts off the moment the user starts to talk.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import Frame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIClientMessageFrame

from .frames import MonitorActionFrame, UserTextInputFrame


class TypedInputDecoder(FrameProcessor):
    """Forward all frames; in addition, decode mobile RTVI client-messages
    into the pipeline frames the rest of the pipeline knows how to handle.
    """

    async def process_frame(
        self, frame: Frame, direction: FrameDirection
    ) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, RTVIClientMessageFrame):
            kind = frame.type
            data = frame.data if isinstance(frame.data, dict) else {}
            logger.warning(
                "typed_input.client_message kind={} msg_id={} direction={} data_keys={}",
                kind,
                frame.msg_id,
                direction.name,
                sorted(data.keys()),
            )
            if kind == "user_text":
                text = data.get("text") if isinstance(data, dict) else None
                if isinstance(text, str) and text.strip():
                    logger.info("typed_input.user_text len={}", len(text))
                    await self.push_frame(
                        UserTextInputFrame(text=text), FrameDirection.DOWNSTREAM
                    )
                # Swallow the client-message frame either way — the rest of
                # the pipeline doesn't process raw RTVI traffic.
                return
            if kind == "interrupt_intent":
                logger.warning(
                    "typed_input.interrupt_intent.broadcast_start msg_id={} direction={}",
                    frame.msg_id,
                    direction.name,
                )
                await self.broadcast_interruption()
                logger.warning(
                    "typed_input.interrupt_intent.broadcast_done msg_id={}",
                    frame.msg_id,
                )
                return
            if kind == "monitor_action":
                request_id = data.get("request_id")
                action = data.get("action")
                if isinstance(request_id, str) and isinstance(action, str):
                    await self.push_frame(
                        MonitorActionFrame(
                            request_id=request_id,
                            action=action,
                            monitor_id=data.get("monitor_id")
                            if isinstance(data.get("monitor_id"), str)
                            else None,
                            run_id=data.get("run_id")
                            if isinstance(data.get("run_id"), str)
                            else None,
                            input=data.get("input")
                            if isinstance(data.get("input"), dict)
                            else None,
                        ),
                        FrameDirection.DOWNSTREAM,
                    )
                return

        await self.push_frame(frame, direction)
