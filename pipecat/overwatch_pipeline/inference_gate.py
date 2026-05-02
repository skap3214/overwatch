"""Inference gate — single instance shared between Pre and Post gates.

Tracks whether the harness is busy, whether the bot is speaking, whether the
user is speaking, and whether any cancellations are pending confirmation.
A new turn fires only when all four are clear.

Modeled on gradient-bang's InferenceGateState (see research §4) but adapted
for our Architecture I shape: there's no LLM in the pipeline, so 'llm_in_flight'
becomes 'harness_in_flight'.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import IntEnum

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class Priority(IntEnum):
    """Priority lanes for pending inferences. Higher values preempt lower."""

    LLM_RUN = 1
    TOOL_RESULT = 2
    EVENT = 3
    URGENT = 4


@dataclass
class PendingRunner:
    reason: str
    priority: Priority
    correlation_id: str | None = None


@dataclass
class InferenceGateState:
    """Shared state between PreLLMInferenceGate and PostLLMInferenceGate."""

    cooldown_seconds: float = 2.0
    cancel_confirm_timeout_seconds: float = 2.0

    _bot_speaking: bool = False
    _user_speaking: bool = False
    _harness_in_flight: bool = False
    _cooldown_until: float = 0.0
    _cancel_pending: set[str] = field(default_factory=set)
    _pending: PendingRunner | None = None

    _bot_idle_event: asyncio.Event = field(default_factory=asyncio.Event)
    _user_idle_event: asyncio.Event = field(default_factory=asyncio.Event)
    _harness_idle_event: asyncio.Event = field(default_factory=asyncio.Event)

    def __post_init__(self) -> None:
        # Start with idle events set since nothing is in flight.
        self._bot_idle_event.set()
        self._user_idle_event.set()
        self._harness_idle_event.set()

    # ─── State updates ──────────────────────────────────────────────────────

    def update_bot_speaking(self, speaking: bool) -> None:
        self._bot_speaking = speaking
        if speaking:
            self._bot_idle_event.clear()
        else:
            self._cooldown_until = time.monotonic() + self.cooldown_seconds
            self._bot_idle_event.set()

    def update_user_speaking(self, speaking: bool) -> None:
        self._user_speaking = speaking
        if speaking:
            self._user_idle_event.clear()
        else:
            self._user_idle_event.set()

    def update_harness_in_flight(self, in_flight: bool) -> None:
        self._harness_in_flight = in_flight
        if in_flight:
            self._harness_idle_event.clear()
        else:
            self._harness_idle_event.set()

    def mark_cancel_pending(self, correlation_id: str) -> None:
        self._cancel_pending.add(correlation_id)

    def confirm_cancel(self, correlation_id: str) -> None:
        self._cancel_pending.discard(correlation_id)

    @property
    def has_cancel_pending(self) -> bool:
        return bool(self._cancel_pending)

    @property
    def harness_in_flight(self) -> bool:
        return self._harness_in_flight

    # ─── Decision ───────────────────────────────────────────────────────────

    def can_run_now(self) -> bool:
        return (
            not self._bot_speaking
            and not self._user_speaking
            and not self._harness_in_flight
            and not self.has_cancel_pending
            and time.monotonic() >= self._cooldown_until
        )

    async def wait_until_runnable(self) -> None:
        while not self.can_run_now():
            await asyncio.gather(
                self._bot_idle_event.wait(),
                self._user_idle_event.wait(),
                self._harness_idle_event.wait(),
            )
            remaining = self._cooldown_until - time.monotonic()
            if remaining > 0:
                await asyncio.sleep(remaining)


class PreLLMInferenceGate(FrameProcessor):
    """Gate before the user_aggregator. Tracks user-speaking state."""

    def __init__(self, state: InferenceGateState) -> None:
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame):
            self._state.update_user_speaking(True)
            logger.debug("gate: user started speaking")
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._state.update_user_speaking(False)
            logger.debug("gate: user stopped speaking")

        await self.push_frame(frame, direction)


class PostLLMInferenceGate(FrameProcessor):
    """Gate after the harness bridge. Tracks bot-speaking state."""

    def __init__(self, state: InferenceGateState) -> None:
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, BotStartedSpeakingFrame):
            self._state.update_bot_speaking(True)
            logger.debug("gate: bot started speaking")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._state.update_bot_speaking(False)
            logger.debug("gate: bot stopped speaking")

        await self.push_frame(frame, direction)
