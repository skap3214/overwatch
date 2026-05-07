from __future__ import annotations

import time

import pytest
from _harness import FrameRecorder, build_test_pipeline
from pipecat.frames.frames import UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi import RTVIClientMessageFrame

from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.protocol import HarnessEvent

pytestmark = pytest.mark.asyncio


def event(payload: dict) -> HarnessEvent:
    return HarnessEvent.model_validate(payload)


async def test_mid_stream_interrupt_uses_submit_with_steer_and_suppresses_stale_delta() -> None:
    ctx = build_test_pipeline()
    await ctx.bridge._handle_user_input("tell me a story")
    first = ctx.client.commands[0].correlation_id

    await ctx.router.process_frame(
        HarnessEventFrame(
            event=event(
                {
                    "type": "text_delta",
                    "correlation_id": first,
                    "target": "claude-code",
                    "text": "Once ",
                }
            )
        ),
        FrameDirection.DOWNSTREAM,
    )
    await ctx.bridge._handle_user_input("actually summarize it")

    second = ctx.client.commands[1]
    assert second.kind == "submit_with_steer"
    assert second.payload.cancels_correlation_id == first

    stale_delta = event(
        {
            "type": "text_delta",
            "correlation_id": first,
            "target": "claude-code",
            "text": "upon a time",
        }
    )
    assert ctx.bridge._on_event(stale_delta) is False


async def test_interrupt_intent_decodes_from_real_rtvi_client_message_frame() -> None:
    ctx = build_test_pipeline()
    recorder = FrameRecorder()
    decoder = ctx.factory.processors[1]
    decoder.push_frame = recorder.push  # type: ignore[method-assign]

    await decoder.process_frame(
        RTVIClientMessageFrame(
            msg_id="interrupt-1",
            type="interrupt_intent",
            data={},
        ),
        FrameDirection.DOWNSTREAM,
    )

    assert recorder.names() == ["InterruptionFrame", "InterruptionFrame"]
    assert recorder.frames[0][2] == FrameDirection.DOWNSTREAM
    assert recorder.frames[1][2] == FrameDirection.UPSTREAM


async def test_post_llm_mid_tts_barge_in_broadcasts_interruption() -> None:
    ctx = build_test_pipeline()
    recorder = FrameRecorder()
    emitter = ctx.factory.processors[2]
    emitter.push_frame = recorder.push  # type: ignore[method-assign]

    ctx.gate.update_bot_speaking(True)
    await emitter.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

    assert recorder.names()[:2] == ["InterruptionFrame", "InterruptionFrame"]
    assert recorder.frames[0][2] == FrameDirection.DOWNSTREAM
    assert recorder.frames[1][2] == FrameDirection.UPSTREAM


async def test_post_interrupt_new_turn_first_text_arrives_promptly() -> None:
    ctx = build_test_pipeline()
    await ctx.bridge._handle_user_input("first")
    first = ctx.client.commands[0].correlation_id

    start = time.monotonic()
    await ctx.bridge._handle_user_input("replacement")
    second = ctx.client.commands[1]
    assert second.kind == "submit_with_steer"

    ctx.bridge._on_event(
        event(
            {
                "type": "cancel_confirmed",
                "correlation_id": first,
                "target": "claude-code",
            }
        )
    )
    await ctx.router.process_frame(
        HarnessEventFrame(
            event=event(
                {
                    "type": "text_delta",
                    "correlation_id": second.correlation_id,
                    "target": "claude-code",
                    "text": "New answer",
                }
            )
        ),
        FrameDirection.DOWNSTREAM,
    )

    assert time.monotonic() - start <= 1.0
    assert "LLMTextFrame" in ctx.recorder.names()
