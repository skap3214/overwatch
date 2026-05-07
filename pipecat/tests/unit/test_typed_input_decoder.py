"""TypedInputDecoder — decode mobile RTVI client-messages into pipeline frames.

Pipecat Cloud's auto-injected RTVIProcessor consumes raw
InputTransportMessageFrames and re-emits them as RTVIClientMessageFrame.
We listen for that — otherwise messages are silently dropped before
reaching the bridge.

Two paths matter:
- `user_text` → `UserTextInputFrame` downstream (typed turn, no STT)
- `interrupt_intent` → broadcast InterruptionFrame immediately so TTS and
  output audio abort without waiting for VAD to detect the user's voice
"""

from __future__ import annotations

import pytest
from pipecat.frames.frames import Frame, InterruptionFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi import RTVIClientMessageFrame

from overwatch_pipeline.typed_input_decoder import TypedInputDecoder

pytestmark = pytest.mark.asyncio


def make_decoder() -> tuple[TypedInputDecoder, list[tuple[str, Frame, FrameDirection]]]:
    decoder = TypedInputDecoder()
    pushed: list[tuple[str, Frame, FrameDirection]] = []

    async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append((type(frame).__name__, frame, direction))

    decoder.push_frame = fake_push  # type: ignore[method-assign]
    return decoder, pushed


async def test_user_text_emits_user_text_input_frame_downstream() -> None:
    decoder, pushed = make_decoder()
    await decoder.process_frame(
        RTVIClientMessageFrame(
            msg_id="m1", type="user_text", data={"text": "hello world"}
        ),
        FrameDirection.DOWNSTREAM,
    )

    assert len(pushed) == 1
    name, frame, direction = pushed[0]
    assert name == "UserTextInputFrame"
    assert frame.text == "hello world"  # type: ignore[attr-defined]
    assert direction == FrameDirection.DOWNSTREAM


async def test_monitor_action_emits_monitor_action_frame_downstream() -> None:
    decoder, pushed = make_decoder()
    await decoder.process_frame(
        RTVIClientMessageFrame(
            msg_id="m-monitor",
            type="monitor_action",
            data={
                "request_id": "req-1",
                "action": "run_now",
                "monitor_id": "job-1",
            },
        ),
        FrameDirection.DOWNSTREAM,
    )

    assert len(pushed) == 1
    name, frame, direction = pushed[0]
    assert name == "MonitorActionFrame"
    assert frame.request_id == "req-1"  # type: ignore[attr-defined]
    assert frame.action == "run_now"  # type: ignore[attr-defined]
    assert frame.monitor_id == "job-1"  # type: ignore[attr-defined]
    assert direction == FrameDirection.DOWNSTREAM


async def test_interrupt_intent_broadcasts_interruption_frame() -> None:
    """PTT button calls sendInterruptIntent on press; the resulting RTVI
    client-message must immediately cut off in-flight TTS, not wait for VAD."""
    decoder, pushed = make_decoder()
    await decoder.process_frame(
        RTVIClientMessageFrame(msg_id="m2", type="interrupt_intent", data={}),
        FrameDirection.DOWNSTREAM,
    )

    assert len(pushed) == 2
    assert [name for name, *_ in pushed] == ["InterruptionFrame", "InterruptionFrame"]
    assert isinstance(pushed[0][1], InterruptionFrame)
    assert pushed[0][2] == FrameDirection.DOWNSTREAM
    assert pushed[1][2] == FrameDirection.UPSTREAM


async def test_unknown_message_passes_through_unchanged() -> None:
    decoder, pushed = make_decoder()
    await decoder.process_frame(
        RTVIClientMessageFrame(msg_id="m3", type="unknown_kind", data={}),
        FrameDirection.DOWNSTREAM,
    )
    # No special decode → forward the original frame downstream so other
    # processors (or RTVI consumers) see it.
    assert pushed[0][0] == "RTVIClientMessageFrame"
    assert pushed[0][2] == FrameDirection.DOWNSTREAM


async def test_user_text_with_empty_string_does_nothing() -> None:
    decoder, pushed = make_decoder()
    await decoder.process_frame(
        RTVIClientMessageFrame(msg_id="m4", type="user_text", data={"text": "   "}),
        FrameDirection.DOWNSTREAM,
    )
    # Whitespace-only text → swallow without emitting a UserTextInputFrame.
    assert pushed == []
