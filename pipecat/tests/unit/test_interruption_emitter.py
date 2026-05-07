"""InterruptionEmitter — broadcasts InterruptionFrame on user barge-in.

Pipecat 1.1.0's standard interruption flow runs through an
LLMUserContextAggregator. We don't have one (Architecture I), so this
small processor fills the gap by broadcasting the same InterruptionFrame
when VAD emits UserStartedSpeakingFrame.
"""

from __future__ import annotations

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    Frame,
    InterruptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.interruption_emitter import InterruptionEmitter

pytestmark = pytest.mark.asyncio


def make_emitter() -> tuple[InterruptionEmitter, list[tuple[str, Frame, FrameDirection]]]:
    emitter = InterruptionEmitter()
    pushed: list[tuple[str, Frame, FrameDirection]] = []

    async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append((type(frame).__name__, frame, direction))

    emitter.push_frame = fake_push  # type: ignore[method-assign]
    return emitter, pushed


async def test_user_started_speaking_broadcasts_interruption_frame() -> None:
    emitter, pushed = make_emitter()
    await emitter.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

    # First two pushes: broadcast InterruptionFrame downstream/upstream so TTS
    # and output transport abort. Final push: original frame downstream.
    names = [n for n, *_ in pushed]
    assert names == ["InterruptionFrame", "InterruptionFrame", "UserStartedSpeakingFrame"]

    assert isinstance(pushed[0][1], InterruptionFrame)
    assert pushed[0][2] == FrameDirection.DOWNSTREAM
    assert pushed[1][2] == FrameDirection.UPSTREAM
    assert pushed[2][2] == FrameDirection.DOWNSTREAM


async def test_other_frames_pass_through_unchanged() -> None:
    emitter, pushed = make_emitter()
    await emitter.process_frame(
        UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM
    )
    await emitter.process_frame(
        BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM
    )
    names = [n for n, *_ in pushed]
    # No interruption for these — only the originals pass through.
    assert names == ["UserStoppedSpeakingFrame", "BotStartedSpeakingFrame"]
