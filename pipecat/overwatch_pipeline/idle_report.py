"""IdleReportProcessor — fires periodic 'what are you up to' reports during
prolonged silence.

Trigger conditions (mirrored from gradient-bang):
- N seconds (default 9) since last BotStoppedSpeakingFrame.
- M seconds (default 45) cooldown between reports.
- Suppressed when the deferred-update buffer is non-empty (we'd rather drain
  user-relevant context than synthesize idle prompts).
- Suppressed when harness is in flight.
- Skip the bot's own greeting: timer arms only after the user has spoken once.
"""

from __future__ import annotations

import asyncio
import time

from loguru import logger
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    Frame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .deferred_update_buffer import DeferredUpdateBuffer
from .frames import UserTextInputFrame
from .inference_gate import InferenceGateState


class IdleReportProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        gate_state: InferenceGateState,
        buffer: DeferredUpdateBuffer,
        threshold_seconds: float = 9.0,
        cooldown_seconds: float = 45.0,
    ) -> None:
        super().__init__()
        self._gate = gate_state
        self._buffer = buffer
        self._threshold = threshold_seconds
        self._cooldown = cooldown_seconds
        self._last_bot_stopped_at: float | None = None
        self._last_report_at: float | None = None
        self._user_has_spoken = False
        self._timer_task: asyncio.Task[None] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStoppedSpeakingFrame):
            self._user_has_spoken = True
        elif isinstance(frame, BotStoppedSpeakingFrame) and self._user_has_spoken:
            self._last_bot_stopped_at = time.monotonic()
            self._arm_timer()

        await self.push_frame(frame, direction)

    def _arm_timer(self) -> None:
        if self._timer_task and not self._timer_task.done():
            return  # Already armed
        self._timer_task = asyncio.create_task(self._timer_run())

    async def _timer_run(self) -> None:
        try:
            await asyncio.sleep(self._threshold)
            await self._maybe_fire()
        except asyncio.CancelledError:
            return

    async def _maybe_fire(self) -> None:
        now = time.monotonic()

        if self._last_report_at and (now - self._last_report_at) < self._cooldown:
            return
        if self._gate.harness_in_flight:
            return
        if not self._buffer.is_empty():
            return

        # Synthesize an idle-check user input — the bridge will route it normally.
        logger.info("idle_report.fire")
        self._last_report_at = now
        await self.push_frame(
            UserTextInputFrame(
                text="<idle_check>One sentence on what you're working on.</idle_check>",
            ),
            FrameDirection.DOWNSTREAM,
        )
