"""InterruptionEmitter — broadcast interruption on user barge-in.

Why this processor exists
-------------------------
Pipecat's standard pipeline composition assumes an LLMUserContextAggregator
sits in the user-input path. That aggregator watches for
`UserStartedSpeakingFrame` and broadcasts an `InterruptionFrame` when the
bot is already speaking, which the TTS service and output transport handle
by aborting in-flight audio generation and clearing queued audio.

We don't have an LLM aggregator (Architecture I — the harness is the LLM,
on the user's Mac). Without something to emit the interruption frame, TTS plays
through to completion even when the user barges in. This tiny processor
fills that gap: when it observes a `UserStartedSpeakingFrame` (typed input
also synthesizes one via TypedInputDecoder for typed barge-in if we ever
decide to wire that), it broadcasts an interruption directly.

Place this BEFORE the STT service so it sees the VAD/system frames as
early as possible. Idempotent — multiple consecutive starts result in one
upstream emission per start frame; if no bot is speaking the
Pipecat's interruption handling is a cheap no-op.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class InterruptionEmitter(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame):
            logger.warning(
                "interruption_emitter.user_started_speaking.broadcast_start direction={} frame_id={}",
                direction.name,
                frame.id,
            )
            await self.broadcast_interruption()
            logger.warning(
                "interruption_emitter.user_started_speaking.broadcast_done frame_id={}",
                frame.id,
            )

        await self.push_frame(frame, direction)
