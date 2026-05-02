"""SayTextVoiceGuard — placeholder processor.

In gradient-bang this guards against double-output when a manual say-text
injection is active alongside the LLM stream. Architecture I has no LLM in
the pipeline so the guard is mostly idle, but we keep the slot wired so a
future Architecture II flip can drop the real implementation in.
"""

from __future__ import annotations

from pipecat.frames.frames import Frame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class SayTextVoiceGuard(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
